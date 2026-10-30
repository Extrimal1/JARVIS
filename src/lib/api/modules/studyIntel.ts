/**
 * Study-intelligence server logic: document processing (extract →
 * chunk → store), keyword retrieval, and grounded summaries /
 * explanations through the central Ollama engine. Every query is
 * owner-scoped (RLS + user_id filters); the model only ever sees
 * retrieved excerpts, never raw storage.
 */

import {
  chatWithOllama,
  contextBudgetChars,
} from "@/src/lib/assistant/llm";
import type { AssistantLocale } from "@/src/lib/assistant/actions";
import {
  dbDeleteWhere,
  dbGetOne,
  dbInsert,
  dbList,
  dbUpdate,
  type DbClient,
} from "@/src/lib/supabase/db";
import {
  downloadBytes,
  ownerPath,
  uploadBytes,
} from "@/src/lib/supabase/storage";
import { SupabaseHttpError } from "@/src/lib/supabase/supabase";
import { listStudyDocs, STUDY_BUCKET } from "./documents";
import {
  blocksToText,
  extractDocument,
  ExtractError,
  formatSourceRefs,
  parseSourceRefs,
} from "@/src/lib/study/extract";
import {
  chunkBlocks,
  estimateTokens,
} from "@/src/lib/study/chunk";
import {
  rankByTerms,
  tokenizeQuery,
} from "@/src/lib/study/retrieve";
import {
  groundedAnswer,
  insufficientContextMessage,
  type CitationSource,
  type GroundedAnswer,
} from "@/src/lib/study/grounding";
import {
  excerptOf,
  MAX_CHUNKS_PER_DOC,
  processResponseOfExtractError,
  type ExplainResponse,
  type ProcessResponse,
  type RetrieveResponse,
  type SummarizeResponse,
} from "@/src/lib/study/protocol";
import {
  explainPrompt,
  fitSourcesToBudget,
  summaryPrompt,
  type GroundedSource,
} from "@/src/lib/study/prompts";

export function isStudyLocale(value: unknown): value is AssistantLocale {
  return value === "de" || value === "ru";
}

/** Retrieval scans at most this many chunks (personal scale). */
const RETRIEVE_SCAN_LIMIT = 500;
/** Excerpt length per retrieved chunk (tool context). */
const RETRIEVE_EXCERPT_CHARS = 600;
/** Prompt + answer headroom kept back from the context budget. */
const SUMMARY_HEADROOM_CHARS = 4000;

function isMissingObject(error: unknown): boolean {
  return (
    error instanceof SupabaseHttpError &&
    error.message === "Object not found"
  );
}

type ChunkRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  source_refs: unknown;
};

function isChunkRow(row: Record<string, unknown>): row is ChunkRow {
  return (
    typeof row.id === "string" &&
    typeof row.document_id === "string" &&
    typeof row.chunk_index === "number" &&
    typeof row.content === "string"
  );
}

// ---------------------------------------------------------------- process

export type ProcessOutcome =
  | { ok: true; response: ProcessResponse }
  | { ok: false; http: 404 | 500; message: string };

/**
 * Extracts one owned document, chunks it, and replaces its stored
 * chunks (re-process safe). Returns the new extraction status with
 * a German detail message — including honest failed/unsupported
 * outcomes, which are results, not transport errors.
 */
export async function processStudyDoc(
  db: DbClient,
  userId: string,
  id: string,
): Promise<ProcessOutcome> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "study_documents",
    id,
  );

  if (
    row === null ||
    typeof row.kind !== "string" ||
    typeof row.storage_path !== "string" ||
    row.storage_path === ""
  ) {
    return { ok: false, http: 404, message: "Dokument nicht gefunden." };
  }

  try {
    await dbUpdate(db, "study_documents", id, {
      extraction_status: "processing",
    });
  } catch {
    return {
      ok: false,
      http: 500,
      message: "Verarbeitungsstatus konnte nicht gesetzt werden.",
    };
  }

  const failed = async (message: string): Promise<ProcessOutcome> => {
    await dbUpdate(db, "study_documents", id, {
      extraction_status: "failed",
    });

    return {
      ok: true,
      response: {
        status: "failed",
        chunks: 0,
        blocks: 0,
        warnings: [],
        message,
      },
    };
  };

  let bytes: Uint8Array;

  try {
    const downloaded = await downloadBytes(db, STUDY_BUCKET, row.storage_path);
    bytes = new Uint8Array(downloaded.bytes);
  } catch (error: unknown) {
    if (isMissingObject(error)) {
      await dbUpdate(db, "study_documents", id, {
        extraction_status: "not_processed",
      });

      return {
        ok: false,
        http: 404,
        message: "Die Datei wurde nie vollständig hochgeladen.",
      };
    }

    return failed("Die Datei konnte nicht geladen werden.");
  }

  let extracted;

  try {
    extracted = await extractDocument(row.kind, bytes);
  } catch (error: unknown) {
    if (error instanceof ExtractError) {
      const response = processResponseOfExtractError(error);
      await dbUpdate(db, "study_documents", id, {
        extraction_status: response.status,
      });

      return { ok: true, response };
    }

    return failed("Unbekannter Fehler bei der Texterkennung.");
  }

  const chunks = chunkBlocks(extracted.blocks);
  const warnings = [...extracted.warnings];
  const kept = chunks.slice(0, MAX_CHUNKS_PER_DOC);

  if (kept.length < chunks.length) {
    warnings.push(
      `Sehr langes Dokument: nur die ersten ${MAX_CHUNKS_PER_DOC} von ${chunks.length} Abschnitten wurden übernommen.`,
    );
  }

  try {
    await dbDeleteWhere(db, "retrieval_chunks", [
      `document_id=eq.${encodeURIComponent(id)}`,
    ]);
    await dbInsert(db, "retrieval_chunks", kept.map((chunk) => ({
      document_id: id,
      chunk_index: chunk.index,
      content: chunk.text,
      token_count: estimateTokens(chunk.charCount),
      source_refs: chunk.refs,
    })));
  } catch {
    return failed("Textabschnitte konnten nicht gespeichert werden.");
  }

  // Full text for previews: best effort, never fatal.
  try {
    const textPath = ownerPath(userId, `${id}.txt`);
    await uploadBytes(
      db,
      STUDY_BUCKET,
      textPath,
      new TextEncoder().encode(blocksToText(extracted.blocks)).buffer as ArrayBuffer,
      "text/plain;charset=utf-8",
    );
    await dbUpdate(db, "study_documents", id, { text_path: textPath });
  } catch {
    warnings.push("Die Volltext-Vorschau konnte nicht gespeichert werden.");
  }

  await dbUpdate(db, "study_documents", id, {
    extraction_status: "completed",
  });

  return {
    ok: true,
    response: {
      status: "completed",
      chunks: kept.length,
      blocks: extracted.blocks.length,
      warnings,
      message:
        kept.length === 1
          ? "Dokument verarbeitet: 1 Abschnitt."
          : `Dokument verarbeitet: ${kept.length} Abschnitte.`,
    },
  };
}

// --------------------------------------------------------------- retrieve

export type RetrieveInput = {
  query: string;
  documentId?: string;
  limit?: number;
};

export function validRetrieveInput(body: unknown): RetrieveInput | null {
  if (typeof body !== "object" || body === null) return null;

  const record = body as Record<string, unknown>;

  if (
    typeof record.query !== "string" ||
    record.query.trim() === "" ||
    record.query.length > 500
  ) {
    return null;
  }

  if (
    record.documentId !== undefined &&
    (typeof record.documentId !== "string" || record.documentId === "")
  ) {
    return null;
  }

  if (
    record.limit !== undefined &&
    (typeof record.limit !== "number" ||
      !Number.isInteger(record.limit) ||
      record.limit < 1 ||
      record.limit > 10)
  ) {
    return null;
  }

  return {
    query: record.query,
    documentId: record.documentId as string | undefined,
    limit: record.limit as number | undefined,
  };
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

export async function retrieveStudyChunks(
  db: DbClient,
  input: RetrieveInput,
): Promise<RetrieveResponse> {
  const terms = tokenizeQuery(input.query);

  if (terms.length === 0) {
    return { chunks: [], totalCandidates: 0, terms: [] };
  }

  const filters =
    input.documentId === undefined
      ? []
      : [`document_id=eq.${encode(input.documentId)}`];
  const rows = await dbList<Record<string, unknown>>(
    db,
    "retrieval_chunks",
    {
      select: "id,document_id,chunk_index,content,source_refs",
      filters,
      order: "chunk_index.asc",
      limit: RETRIEVE_SCAN_LIMIT,
    },
  );
  const valid = rows.filter(isChunkRow);
  const docs = await listStudyDocs(db);
  const names = new Map(docs.map((doc) => [doc.id, doc.name]));
  const ranked = rankByTerms(
    valid,
    (row) => row.content,
    input.query,
    input.limit ?? 5,
  );

  return {
    chunks: ranked.map((entry) => {
      const refs = parseSourceRefs(entry.item.source_refs);

      return {
        chunkId: entry.item.id,
        documentId: entry.item.document_id,
        documentName: names.get(entry.item.document_id) ?? "Dokument",
        index: entry.item.chunk_index,
        text: excerptOf(entry.item.content, RETRIEVE_EXCERPT_CHARS),
        refs,
        refLabel: formatSourceRefs(refs),
        score: Math.round(entry.score * 100) / 100,
        matchedTerms: entry.matchedTerms,
      };
    }),
    totalCandidates: valid.length,
    terms,
  };
}

// --------------------------------------------------------------- grounded

async function groundedChat(
  messages: Parameters<typeof chatWithOllama>[0],
  sources: CitationSource[],
  locale: AssistantLocale,
  numPredict: number,
): Promise<GroundedAnswer> {
  return groundedAnswer(
    async (callMessages) =>
      (
        await chatWithOllama(callMessages, {
          temperature: 0,
          numPredict,
        })
      ).content,
    messages,
    sources,
    locale,
  );
}

function toGroundedSources(
  chunks: { text: string; refLabel: string; documentName: string }[],
): GroundedSource[] {
  return chunks.map((chunk, index) => ({
    marker: `[Q${index + 1}]`,
    documentName: chunk.documentName,
    refLabel: chunk.refLabel,
    text: chunk.text,
  }));
}

function toCitationSources(sources: GroundedSource[]): CitationSource[] {
  return sources.map((source) => ({
    marker: source.marker,
    documentName: source.documentName,
    refLabel: source.refLabel,
  }));
}

// --------------------------------------------------------------- summarize

export type SummarizeInput = {
  documentId: string;
  locale: AssistantLocale;
};

export function validSummarizeInput(body: unknown): SummarizeInput | null {
  if (typeof body !== "object" || body === null) return null;

  const record = body as Record<string, unknown>;

  if (
    typeof record.documentId !== "string" ||
    record.documentId === "" ||
    !isStudyLocale(record.locale)
  ) {
    return null;
  }

  return { documentId: record.documentId, locale: record.locale };
}

export type SummarizeOutcome =
  | { ok: true; response: SummarizeResponse }
  | { ok: false; http: 404; message: string };

export async function summarizeStudyDoc(
  db: DbClient,
  input: SummarizeInput,
): Promise<SummarizeOutcome> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "study_documents",
    input.documentId,
  );

  if (row === null) {
    return { ok: false, http: 404, message: "Dokument nicht gefunden." };
  }

  const documentName =
    typeof row.name === "string" && row.name !== "" ? row.name : "Dokument";

  if (row.extraction_status !== "completed") {
    const message =
      input.locale === "ru"
        ? `Документ «${documentName}» ещё не обработан — сначала извлеки текст.`
        : `„${documentName}“ ist noch nicht verarbeitet — bitte zuerst Text erkennen lassen.`;

    return {
      ok: true,
      response: {
        summary: message,
        documentName,
        refsUsed: [],
        truncated: false,
        chunkCount: 0,
      },
    };
  }

  const rows = await dbList<Record<string, unknown>>(
    db,
    "retrieval_chunks",
    {
      select: "id,document_id,chunk_index,content,source_refs",
      filters: [`document_id=eq.${encode(input.documentId)}`],
      order: "chunk_index.asc",
      limit: RETRIEVE_SCAN_LIMIT,
    },
  );
  const valid = rows.filter(isChunkRow);

  if (valid.length === 0) {
    return {
      ok: true,
      response: {
        summary: insufficientContextMessage(input.locale),
        documentName,
        refsUsed: [],
        truncated: false,
        chunkCount: 0,
      },
    };
  }

  const budget = Math.max(4000, contextBudgetChars() - SUMMARY_HEADROOM_CHARS);
  const { included, truncated: truncatedByBudget } = fitSourcesToBudget(
    valid.map((row) => ({ row, text: row.content })),
    budget,
  );
  const includedRows = included.map((entry) => entry.row);

  const sources = toGroundedSources(
    includedRows.map((row) => ({
      text: row.content,
      refLabel: formatSourceRefs(parseSourceRefs(row.source_refs)),
      documentName,
    })),
  );
  const truncated = truncatedByBudget;

  const chat = await groundedChat(
    summaryPrompt(input.locale, documentName, sources, truncated),
    toCitationSources(sources),
    input.locale,
    1200,
  );

  const refsUsed = [
    ...new Set(sources.map((source) => source.refLabel)),
  ].filter((label) => label !== "");

  return {
    ok: true,
    response: {
      summary: chat.text,
      documentName,
      refsUsed,
      truncated,
      chunkCount: valid.length,
    },
  };
}

// ----------------------------------------------------------------- explain

export type ExplainInput = {
  documentId: string;
  question: string;
  locale: AssistantLocale;
};

export function validExplainInput(body: unknown): ExplainInput | null {
  if (typeof body !== "object" || body === null) return null;

  const record = body as Record<string, unknown>;

  if (
    typeof record.documentId !== "string" ||
    record.documentId === "" ||
    typeof record.question !== "string" ||
    record.question.trim() === "" ||
    record.question.length > 1000 ||
    !isStudyLocale(record.locale)
  ) {
    return null;
  }

  return {
    documentId: record.documentId,
    question: record.question,
    locale: record.locale,
  };
}

export type ExplainOutcome =
  | { ok: true; response: ExplainResponse }
  | { ok: false; http: 404; message: string };

export async function explainStudyDoc(
  db: DbClient,
  input: ExplainInput,
): Promise<ExplainOutcome> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "study_documents",
    input.documentId,
  );

  if (row === null) {
    return { ok: false, http: 404, message: "Dokument nicht gefunden." };
  }

  const documentName =
    typeof row.name === "string" && row.name !== "" ? row.name : "Dokument";
  const retrieval = await retrieveStudyChunks(db, {
    query: input.question,
    documentId: input.documentId,
    limit: 6,
  });

  if (retrieval.chunks.length === 0) {
    // No usable evidence: deterministic honesty, no LLM call.
    return {
      ok: true,
      response: {
        answer: insufficientContextMessage(input.locale),
        documentName,
        refsUsed: [],
        insufficient: true,
      },
    };
  }

  const sources = toGroundedSources(retrieval.chunks);
  const chat = await groundedChat(
    explainPrompt(input.locale, documentName, input.question, sources),
    toCitationSources(sources),
    input.locale,
    800,
  );
  const refsUsed = [
    ...new Set(sources.map((source) => source.refLabel)),
  ].filter((label) => label !== "");

  return {
    ok: true,
    response: {
      answer: chat.text,
      documentName,
      refsUsed,
      insufficient: false,
    },
  };
}

/** Keeps document deletion honest: chunks vanish with the document. */
export async function deleteStudyDocChunks(
  db: DbClient,
  id: string,
): Promise<void> {
  await dbDeleteWhere(db, "retrieval_chunks", [
    `document_id=eq.${encode(id)}`,
  ]);
}
