/**
 * Study-intelligence server logic: document processing (extract →
 * chunk → store), keyword retrieval, and grounded summaries /
 * explanations through the central Ollama engine. Every query is
 * owner-scoped (RLS + user_id filters); the model only ever sees
 * retrieved excerpts, never raw storage.
 */

import {
  ProviderError,
  chatWithOllama,
  contextBudgetChars,
  type LlmMessage,
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
  type SourceRef,
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
  EMPTY_QUESTION_COVERAGE,
  EMPTY_QUESTION_WINDOW,
  MAX_CHUNKS_PER_DOC,
  processResponseOfExtractError,
  type DocumentCoverage,
  type ExplainResponse,
  type ProcessResponse,
  type QuestionsResponse,
  type RetrieveResponse,
  type SummarizeBatchResponse,
  type SummarizeResponse,
  type SummarySpanResult,
  type SynthesizeResponse,
} from "@/src/lib/study/protocol";
import {
  coverageStats,
  groupChunksByUnit,
  planSummarySweep,
  selectQuestionWindow,
  targetQuestionCount,
} from "@/src/lib/study/coverage";
import {
  groupSectionsForReduction,
  orderSpansForSynthesis,
  resolveMarkersToLabels,
  spanUnitCounts,
  validateSynthesisRefs,
} from "@/src/lib/study/summaries";
import { summaryRowToDomain } from "./summaries";
import { createId, isUuid } from "@/src/lib/ids";
import {
  batchSummaryPrompt,
  explainPrompt,
  fitSourcesToBudget,
  questionPrompt,
  summaryPrompt,
  synthesizePrompt,
  type GroundedSource,
} from "@/src/lib/study/prompts";
import {
  parseQuestionsWithRepair,
  QuestionsParseError,
  QuestionsTruncatedError,
  assertCompleteQuestions,
  summarizeDropReasons,
} from "@/src/lib/study/questions";

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

  // Total page/slide count: best effort, never fatal (older
  // databases may not have the column yet — see 0008 migration).
  try {
    await dbUpdate(db, "study_documents", id, {
      page_count: extracted.pageCount,
    });
  } catch {
    warnings.push("Die Seitenanzahl konnte nicht gespeichert werden.");
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
      pageCount: extracted.pageCount,
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

// --------------------------------------------------------------- questions

export const QUESTIONS_DEFAULT_COUNT = 6;

export const QUESTIONS_MAX_COUNT = 10;

/**
 * Question JSON needs more room than summaries or answers: six
 * items with options and explanations must never hit the cutoff
 * mid-array (truncated JSON is unparseable by design).
 */
const QUESTIONS_NUM_PREDICT = 3000;

export type QuestionsInput = {
  documentId: string;
  locale: AssistantLocale;
  count: number;
  /** Stored ref labels already covered (repeat calls cover new slices). */
  coveredRefs: string[];
};

export function validQuestionsInput(body: unknown): QuestionsInput | null {
  if (typeof body !== "object" || body === null) return null;

  const record = body as Record<string, unknown>;

  if (
    typeof record.documentId !== "string" ||
    record.documentId === "" ||
    !isStudyLocale(record.locale)
  ) {
    return null;
  }

  if (
    record.count !== undefined &&
    (typeof record.count !== "number" ||
      !Number.isInteger(record.count) ||
      record.count < 1 ||
      record.count > QUESTIONS_MAX_COUNT)
  ) {
    return null;
  }

  if (
    record.coveredRefs !== undefined &&
    (!Array.isArray(record.coveredRefs) ||
      record.coveredRefs.length > 5000 ||
      record.coveredRefs.some(
        (ref) => typeof ref !== "string" || ref.length > 500,
      ))
  ) {
    return null;
  }

  return {
    documentId: record.documentId,
    locale: record.locale,
    count:
      typeof record.count === "number"
        ? record.count
        : QUESTIONS_DEFAULT_COUNT,
    coveredRefs: Array.isArray(record.coveredRefs)
      ? (record.coveredRefs.filter(
          (ref): ref is string => typeof ref === "string",
        ) as string[])
      : [],
  };
}

export type QuestionsOutcome =
  | { ok: true; response: QuestionsResponse }
  | { ok: false; http: 404; message: string };

/**
 * Generates grounded exam questions for one owned document through
 * the central Ollama engine in native JSON mode. Each call covers
 * one spread window over the not-yet-covered slices (never the
 * front prefix twice): citations resolve strictly against window
 * sources, one repair round re-asks for JSON-only output, and
 * anything still unparseable is an honest upstream error — never
 * heuristic questions and never silent success.
 */
export async function generateStudyQuestions(
  db: DbClient,
  input: QuestionsInput,
): Promise<QuestionsOutcome> {
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
  const subject =
    typeof row.subject === "string" && row.subject !== ""
      ? row.subject
      : null;

  if (row.extraction_status !== "completed") {
    return {
      ok: true,
      response: {
        questions: [],
        documentId: input.documentId,
        documentName,
        subject,
        refsUsed: [],
        truncated: false,
        chunkCount: 0,
        insufficient: true,
        droppedInvalid: 0,
        partial: false,
        window: EMPTY_QUESTION_WINDOW,
        coverage: EMPTY_QUESTION_COVERAGE,
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
        questions: [],
        documentId: input.documentId,
        documentName,
        subject,
        refsUsed: [],
        truncated: false,
        chunkCount: 0,
        insufficient: true,
        droppedInvalid: 0,
        partial: false,
        window: EMPTY_QUESTION_WINDOW,
        coverage: EMPTY_QUESTION_COVERAGE,
      },
    };
  }

  const budget = Math.max(4000, contextBudgetChars() - SUMMARY_HEADROOM_CHARS);
  const selection = selectQuestionWindow(
    valid.map((chunkRow) => ({
      index: chunkRow.chunk_index,
      text: chunkRow.content,
      refs: parseSourceRefs(chunkRow.source_refs),
      payload: chunkRow,
    })),
    input.coveredRefs,
    input.count,
    budget,
  );
  const sources = toGroundedSources(
    selection.picked.map((entry) => ({
      text: entry.payload.content,
      refLabel: formatSourceRefs(entry.refs),
      documentName,
    })),
  );

  const started = Date.now();
  let model = "unknown";
  let doneReason: string | null = null;
  let evalCount: number | null = null;
  let responseChars = 0;
  let thinkingChars = 0;

  // Safe diagnostics only: shape facts, no document text.
  const attemptFacts = (): string =>
    `model=${model} durationMs=${Date.now() - started} ` +
    `doneReason=${doneReason ?? "unknown"} ` +
    `evalCount=${evalCount ?? "unknown"} ` +
    `responseChars=${responseChars} thinkingChars=${thinkingChars} ` +
    `thinkRequested=false`;

  let parsed;

  try {
    parsed = await parseQuestionsWithRepair(
      async (callMessages) => {
        const result = await chatWithOllama(callMessages, {
          temperature: 0,
          numPredict: QUESTIONS_NUM_PREDICT,
          format: "json",
        });

        model = result.model;
        doneReason = result.doneReason;
        evalCount = result.evalCount;
        responseChars = result.content.length;
        thinkingChars = result.thinkingChars;

        // Opt-in local diagnosis: generated output only (never the
        // prompt, chunks, or user data), capped at 1000 characters.
        if (process.env.STUDY_DEBUG_RAW === "1") {
          console.log(
            `[api:study] DEBUG raw questions response (${responseChars} chars): ${result.content.slice(0, 1000)}`,
          );
        }

        // Exhaustion never enters parsing or repair: a longer retry
        // prompt would only exhaust the budget further.
        assertCompleteQuestions(result);

        return result.content;
      },
      questionPrompt(input.locale, documentName, sources, input.count),
      sources,
      input.locale,
    );
  } catch (error: unknown) {
    if (error instanceof QuestionsTruncatedError) {
      console.log(`[api:study] questions ${attemptFacts()} error=truncated`);

      throw new ProviderError("truncated", error.message);
    }

    if (error instanceof QuestionsParseError) {
      const detail =
        error.reasons.length > 0
          ? ` dropReasons=${summarizeDropReasons(error.reasons)}`
          : "";

      console.log(
        `[api:study] questions ${attemptFacts()} validJson=false repair=true count=0 jsonFound=${error.jsonFound}${detail}`,
      );

      if (process.env.STUDY_DEBUG_RAW === "1") {
        console.log(
          `[api:study] DEBUG questions rejection: jsonFound=${error.jsonFound} reasons=${error.reasons.length > 0 ? summarizeDropReasons(error.reasons) : "none"}`,
        );
      }

      throw new ProviderError("malformed", error.message);
    }

    throw error;
  }

  console.log(
    `[api:study] questions ${attemptFacts()} validJson=true repair=${parsed.repaired} count=${parsed.questions.length} dropped=${parsed.droppedInvalid} ` +
      `groups=${selection.labels.length} pool=${selection.poolSize} ` +
      `coverage=${selection.coverage.coveredUnits}/${selection.coverage.usableUnits}`,
  );

  const refsUsed = [
    ...new Set(sources.map((source) => source.refLabel)),
  ].filter((label) => label !== "");

  return {
    ok: true,
    response: {
      questions: parsed.questions,
      documentId: input.documentId,
      documentName,
      subject,
      refsUsed,
      truncated: selection.truncated,
      chunkCount: valid.length,
      insufficient: false,
      droppedInvalid: parsed.droppedInvalid,
      partial: parsed.questions.length < input.count,
      window: {
        labels: selection.labels,
        poolSize: selection.poolSize,
        truncated: selection.truncated,
      },
      coverage: {
        usableUnits: selection.coverage.usableUnits,
        coveredUnits: selection.coverage.coveredUnits,
        percent: selection.coverage.percent,
      },
    },
  };
}

const GENERATION_LOCKS = new Set<string>();

export function generationLockKey(
  userId: string,
  documentId: string,
): string {
  return `${userId}::${documentId}`;
}

/**
 * Per-document generation lock (single instance): the UI batches
 * sequentially per document, but direct API double-calls would
 * otherwise generate duplicate windows concurrently. Always pair
 * with `releaseGenerationLock` in a finally block.
 */
export function tryAcquireGenerationLock(key: string): boolean {
  if (GENERATION_LOCKS.has(key)) return false;

  GENERATION_LOCKS.add(key);

  return true;
}

export function releaseGenerationLock(key: string): void {
  GENERATION_LOCKS.delete(key);
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

// --------------------------------------------------------------- coverage

export type CoverageOutcome =
  | { ok: true; coverage: DocumentCoverage }
  | { ok: false; http: 404; message: string };

/**
 * Per-document coverage snapshot: usable units from the stored
 * chunks, covered units from every persisted question's labels
 * (manual questions count toward the total but rarely cover),
 * plus the extraction-time page total. Read-only.
 */
export async function getStudyCoverage(
  db: DbClient,
  documentId: string,
): Promise<CoverageOutcome> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "study_documents",
    documentId,
  );

  if (row === null) {
    return { ok: false, http: 404, message: "Dokument nicht gefunden." };
  }

  const rows = await dbList<Record<string, unknown>>(
    db,
    "retrieval_chunks",
    {
      select: "id,document_id,chunk_index,content,source_refs",
      filters: [`document_id=eq.${encode(documentId)}`],
      order: "chunk_index.asc",
      limit: RETRIEVE_SCAN_LIMIT,
    },
  );
  const groups = groupChunksByUnit(
    rows.filter(isChunkRow).map((chunkRow) => ({
      index: chunkRow.chunk_index,
      text: chunkRow.content,
      refs: parseSourceRefs(chunkRow.source_refs),
    })),
  );
  const quizRows = await dbList<Record<string, unknown>>(
    db,
    "quiz_questions",
    {
      select: "id,source_refs",
      filters: [`document_id=eq.${encode(documentId)}`],
      order: "created_at.asc",
      limit: 5000,
    },
  );
  const labels = quizRows.flatMap((quizRow) =>
    Array.isArray(quizRow.source_refs)
      ? quizRow.source_refs.filter(
          (ref): ref is string => typeof ref === "string",
        )
      : [],
  );
  const stats = coverageStats(groups, labels);

  return {
    ok: true,
    coverage: {
      documentId,
      totalPages:
        typeof row.page_count === "number" ? row.page_count : null,
      usableUnits: stats.usableUnits,
      coveredUnits: stats.coveredUnits,
      percent: stats.percent,
      questionCount: quizRows.length,
      target: targetQuestionCount(stats.usableUnits),
    },
  };
}

// ------------------------------------------------- summaries (4C)

/** Summary planning reads every stored chunk (coverage needs all). */
const SUMMARY_SCAN_LIMIT = MAX_CHUNKS_PER_DOC;

/** Batch summaries keep the legacy per-call output budget. */
const SUMMARY_BATCH_NUM_PREDICT = 1200;

/** Final synthesis over span texts (explicit, see plan). */
const SYNTHESIZE_NUM_PREDICT = 2000;

/** Synthesis input cap (fits the 8000 local message limit). */
const SYNTHESIS_INPUT_BUDGET_CHARS = 6000;

/** Reduction depth cap (sections → groups → final). */
const MAX_SYNTHESIS_LEVELS = 2;

export type SummaryBatchInput = {
  documentId: string;
  locale: AssistantLocale;
  /** Null starts a replacement draft (active summary untouched). */
  generationId: string | null;
};

export function validSummaryBatchInput(
  body: unknown,
): SummaryBatchInput | null {
  if (typeof body !== "object" || body === null) return null;

  const record = body as Record<string, unknown>;

  if (
    typeof record.documentId !== "string" ||
    record.documentId === "" ||
    !isStudyLocale(record.locale)
  ) {
    return null;
  }

  if (
    record.generationId !== undefined &&
    record.generationId !== null &&
    !isUuid(record.generationId)
  ) {
    return null;
  }

  return {
    documentId: record.documentId,
    locale: record.locale,
    generationId:
      typeof record.generationId === "string" ? record.generationId : null,
  };
}

export type SynthesizeInput = {
  documentId: string;
  locale: AssistantLocale;
  generationId: string;
};

export function validSynthesizeInput(body: unknown): SynthesizeInput | null {
  if (typeof body !== "object" || body === null) return null;

  const record = body as Record<string, unknown>;

  if (
    typeof record.documentId !== "string" ||
    record.documentId === "" ||
    !isStudyLocale(record.locale) ||
    !isUuid(record.generationId)
  ) {
    return null;
  }

  return {
    documentId: record.documentId,
    locale: record.locale,
    generationId: record.generationId,
  };
}

export type SummaryBatchOutcome =
  | { ok: true; response: SummarizeBatchResponse }
  | { ok: false; http: 404 | 409; message: string };

export type SynthesizeOutcome =
  | { ok: true; response: SynthesizeResponse }
  | { ok: false; http: 404 | 409; message: string };

type SummaryRowShape = {
  id: string;
  generationId: string | null;
  planned: { key: string; label: string; order: number }[];
  spans: SummarySpanResult[];
  hasActive: boolean;
};

function readSummaryRow(row: Record<string, unknown>): SummaryRowShape {
  const domain = summaryRowToDomain(row) as {
    draft?: {
      generationId?: unknown;
      plannedSpans?: unknown;
      spans?: unknown;
    } | null;
    active?: unknown;
  };
  const planned = Array.isArray(domain.draft?.plannedSpans)
    ? (domain.draft.plannedSpans as SummaryRowShape["planned"])
    : [];
  const spans = Array.isArray(domain.draft?.spans)
    ? (domain.draft.spans as SummarySpanResult[])
    : [];

  return {
    id: typeof row.id === "string" ? row.id : "",
    generationId:
      typeof domain.draft?.generationId === "string"
        ? domain.draft.generationId
        : null,
    planned,
    spans,
    hasActive: domain.active !== null && domain.active !== undefined,
  };
}

async function loadSummaryRow(
  db: DbClient,
  documentId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await dbList<Record<string, unknown>>(
    db,
    "study_summaries",
    {
      select: "*",
      filters: [`document_id=eq.${encode(documentId)}`],
      limit: 1,
    },
  );

  return rows[0] ?? null;
}

async function loadOrderedChunks(
  db: DbClient,
  documentId: string,
): Promise<{ index: number; text: string; refs: SourceRef[] }[]> {
  const rows = await dbList<Record<string, unknown>>(
    db,
    "retrieval_chunks",
    {
      select: "id,document_id,chunk_index,content,source_refs",
      filters: [`document_id=eq.${encode(documentId)}`],
      order: "chunk_index.asc",
      limit: SUMMARY_SCAN_LIMIT,
    },
  );

  return rows.filter(isChunkRow).map((chunkRow) => ({
    index: chunkRow.chunk_index,
    text: chunkRow.content,
    refs: parseSourceRefs(chunkRow.source_refs),
  }));
}

async function synthesisChat(messages: LlmMessage[]): Promise<string> {
  const result = await chatWithOllama(messages, {
    temperature: 0,
    numPredict: SYNTHESIZE_NUM_PREDICT,
  });

  assertCompleteQuestions({
    content: result.content,
    doneReason: result.doneReason,
    evalCount: result.evalCount,
    thinkingChars: result.thinkingChars,
  });

  return result.content;
}

/**
 * Generates + persists the next incomplete span of the current
 * draft (server-validated resume: only persisted spans count).
 * A null generation starts a replacement draft; the active
 * summary is never touched here — promotion happens only in
 * `synthesizeSummary` after a complete synthesis.
 */
export async function summarizeNextSpan(
  db: DbClient,
  input: SummaryBatchInput,
): Promise<SummaryBatchOutcome> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "study_documents",
    input.documentId,
  );

  if (row === null) {
    return { ok: false, http: 404, message: "Dokument nicht gefunden." };
  }

  if (row.extraction_status !== "completed") {
    return {
      ok: false,
      http: 409,
      message: "Das Dokument ist noch nicht verarbeitet.",
    };
  }

  const documentName =
    typeof row.name === "string" && row.name !== "" ? row.name : "Dokument";
  const chunks = await loadOrderedChunks(db, input.documentId);
  const plan = planSummarySweep(groupChunksByUnit(chunks));

  if (plan.length === 0) {
    return {
      ok: false,
      http: 409,
      message: "Zu diesem Dokument liegen keine auswertbaren Textstellen vor.",
    };
  }

  const stored = await loadSummaryRow(db, input.documentId);
  const current = stored === null ? null : readSummaryRow(stored);
  const planned = plan.map((span, order) => ({
    key: span.key,
    label: span.label,
    order,
  }));
  const planKeys = new Set(plan.map((span) => span.key));
  let generationId = input.generationId;
  let effective: SummarySpanResult[] = [];
  let rowId = current?.id ?? "";

  if (generationId === null) {
    generationId = createId();

    if (stored === null || current === null) {
      rowId = createId();

      await dbInsert(db, "study_summaries", [
        {
          id: rowId,
          document_id: input.documentId,
          status: "partial",
          draft_generation_id: generationId,
          draft_planned: planned,
          draft_spans: [],
          draft_started_at: new Date().toISOString(),
        },
      ]);
    } else {
      await dbUpdate(db, "study_summaries", current.id, {
        status: current.hasActive ? "complete" : "partial",
        draft_generation_id: generationId,
        draft_planned: planned,
        draft_spans: [],
        draft_preview_md: "",
        draft_preview_refs: [],
        draft_started_at: new Date().toISOString(),
      });
    }
  } else {
    if (
      stored === null ||
      current === null ||
      current.generationId !== generationId
    ) {
      return {
        ok: false,
        http: 409,
        message:
          "Unbekannte oder abgelaufene Generierung — bitte neu starten.",
      };
    }

    effective = current.spans.filter((span) => planKeys.has(span.key));
  }

  const doneKeys = new Set(effective.map((span) => span.key));
  const nextIndex = plan.findIndex((span) => !doneKeys.has(span.key));

  if (nextIndex === -1) {
    const progress = spanUnitCounts(plan, [...doneKeys]);

    if (stored !== null && current !== null) {
      await dbUpdate(db, "study_summaries", current.id, {
        draft_planned: planned,
        draft_spans: effective,
      });
    }

    return {
      ok: true,
      response: {
        documentId: input.documentId,
        generationId,
        span: { key: "", label: "", index: plan.length, total: plan.length },
        text: "",
        refs: [],
        processedUnits: progress.processedUnits,
        usableUnits: progress.usableUnits,
        percent: progress.percent,
        done: true,
      },
    };
  }

  const next = plan[nextIndex] as (typeof plan)[number];
  const wanted = new Set(next.chunkIndices);
  const picked = chunks.filter((chunk) => wanted.has(chunk.index));
  const sources = toGroundedSources(
    picked.map((chunk) => ({
      text: chunk.text,
      refLabel: formatSourceRefs(chunk.refs),
      documentName,
    })),
  );

  let raw: string;

  try {
    const chat = await groundedAnswer(
      async (callMessages) => {
        const result = await chatWithOllama(callMessages, {
          temperature: 0,
          numPredict: SUMMARY_BATCH_NUM_PREDICT,
        });

        assertCompleteQuestions({
          content: result.content,
          doneReason: result.doneReason,
          evalCount: result.evalCount,
          thinkingChars: result.thinkingChars,
        });

        return result.content;
      },
      batchSummaryPrompt(input.locale, documentName, next.label, sources),
      toCitationSources(sources),
      input.locale,
    );

    raw = chat.text;
  } catch (error: unknown) {
    if (error instanceof QuestionsTruncatedError) {
      throw new ProviderError("truncated", error.message);
    }

    throw error;
  }

  const resolved = resolveMarkersToLabels(raw, sources);
  const completed: SummarySpanResult = {
    key: next.key,
    label: next.label,
    text: resolved.text,
    refs: resolved.refs,
    completedAt: new Date().toISOString(),
  };
  const updated = [...effective, completed];
  const progress = spanUnitCounts(
    plan,
    updated.map((span) => span.key),
  );

  const hasActive =
    stored !== null && current !== null && current.hasActive;

  await dbUpdate(db, "study_summaries", rowId, {
    status: hasActive ? "complete" : "partial",
    draft_planned: planned,
    draft_spans: updated,
  });

  console.log(
    `[api:study] summary-batch doc=${input.documentId} gen=${generationId} span=${next.key} units=${progress.processedUnits}/${progress.usableUnits}`,
  );

  return {
    ok: true,
    response: {
      documentId: input.documentId,
      generationId,
      span: {
        key: next.key,
        label: next.label,
        index: nextIndex,
        total: plan.length,
      },
      text: completed.text,
      refs: completed.refs,
      processedUnits: progress.processedUnits,
      usableUnits: progress.usableUnits,
      percent: progress.percent,
      done: false,
    },
  };
}

/**
 * Synthesizes the persisted spans of one draft generation.
 * Complete coverage promotes to active in a single atomic
 * update; partial coverage stores a preview and keeps the draft
 * resumable. Truncation or ref-validation failure keeps the
 * draft incomplete for retry — spans are never lost.
 */
export async function synthesizeSummary(
  db: DbClient,
  input: SynthesizeInput,
): Promise<SynthesizeOutcome> {
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
  const stored = await loadSummaryRow(db, input.documentId);

  if (stored === null) {
    return {
      ok: false,
      http: 404,
      message: "Keine Zusammenfassung vorhanden.",
    };
  }

  const current = readSummaryRow(stored);

  if (current.generationId !== input.generationId) {
    return {
      ok: false,
      http: 409,
      message: "Unbekannte oder abgelaufene Generierung — bitte neu starten.",
    };
  }

  const plan = planSummarySweep(
    groupChunksByUnit(await loadOrderedChunks(db, input.documentId)),
  );

  if (plan.length === 0) {
    return {
      ok: false,
      http: 409,
      message: "Zu diesem Dokument liegen keine auswertbaren Textstellen vor.",
    };
  }

  const planKeys = new Set(plan.map((span) => span.key));
  const effective = current.spans.filter((span) => planKeys.has(span.key));

  if (effective.length === 0) {
    return {
      ok: false,
      http: 409,
      message: "Noch keine Abschnitte zusammengefasst.",
    };
  }

  const complete = effective.length === plan.length;
  const ordered = orderSpansForSynthesis(effective);
  let sections = ordered.map((span) => ({
    label: span.label,
    text: span.text,
  }));
  let levels = 1;

  try {
    while (
      sections.reduce(
        (sum, section) => sum + section.label.length + section.text.length,
        0,
      ) > SYNTHESIS_INPUT_BUDGET_CHARS &&
      levels <= MAX_SYNTHESIS_LEVELS
    ) {
      const groups = groupSectionsForReduction(
        sections,
        SYNTHESIS_INPUT_BUDGET_CHARS,
      );

      if (groups.length <= 1) break;

      const merged: { label: string; text: string }[] = [];

      for (const group of groups) {
        const text = await synthesisChat(
          synthesizePrompt(input.locale, documentName, group, true),
        );

        merged.push({
          label: group.map((section) => section.label).join(", "),
          text,
        });
      }

      sections = merged;
      levels += 1;
    }

    const text = await synthesisChat(
      synthesizePrompt(input.locale, documentName, sections, complete),
    );
    const usable = plan.flatMap((span) => span.units);
    const check = validateSynthesisRefs(text, usable);

    if (!check.ok) {
      throw new ProviderError(
        "malformed",
        "Die Synthese enthielt ungültige Quellenangaben — bitte erneut versuchen.",
      );
    }

    if (complete) {
      await dbUpdate(db, "study_summaries", current.id, {
        status: "complete",
        active_final_md: text,
        active_final_refs: check.refs,
        active_completed_at: new Date().toISOString(),
        draft_generation_id: null,
        draft_planned: [],
        draft_spans: [],
        draft_preview_md: "",
        draft_preview_refs: [],
        draft_started_at: null,
      });
    } else {
      await dbUpdate(db, "study_summaries", current.id, {
        status: current.hasActive ? "complete" : "partial",
        draft_planned: plan.map((span, order) => ({
          key: span.key,
          label: span.label,
          order,
        })),
        draft_spans: effective,
        draft_preview_md: text,
        draft_preview_refs: check.refs,
      });
    }

    console.log(
      `[api:study] synthesize doc=${input.documentId} gen=${input.generationId} complete=${complete} levels=${levels} refs=${check.refs.length}`,
    );

    return {
      ok: true,
      response: {
        documentId: input.documentId,
        generationId: input.generationId,
        text,
        refs: check.refs,
        complete,
        levels,
      },
    };
  } catch (error: unknown) {
    if (error instanceof QuestionsTruncatedError) {
      throw new ProviderError("truncated", error.message);
    }

    throw error;
  }
}
