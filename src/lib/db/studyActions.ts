/**
 * Dual-mode study actions: process / summarize / explain.
 * Cloud mode calls the API routes (Supabase + server Ollama);
 * local mode extracts and chunks in the browser (same pure
 * functions) and reasons through /api/llm/chat (open locally).
 */

import { CLOUD_ENABLED } from "./mode";
import { apiUnknown } from "./useRemoteResource";
import {
  listDocuments as localListDocuments,
  saveDocumentText as localSaveText,
  updateDocumentMeta as localUpdateMeta,
  type DocumentKind,
} from "@/src/lib/documents";
import {
  blocksToText,
  extractDocument,
  ExtractError,
  formatSourceRefs,
} from "@/src/lib/study/extract";
import { chunkBlocks, estimateTokens } from "@/src/lib/study/chunk";
import { getDocumentChunks, saveDocumentChunks } from "@/src/lib/study/localChunks";
import {
  groundedAnswer,
  insufficientContextMessage,
  type CitationSource,
} from "@/src/lib/study/grounding";
import {
  explainPrompt,
  fitSourcesToBudget,
  summaryPrompt,
  type GroundedSource,
} from "@/src/lib/study/prompts";
import {
  isExplainResponse,
  isProcessResponse,
  isSummarizeResponse,
  MAX_CHUNKS_PER_DOC,
  processResponseOfExtractError,
  type ExplainResponse,
  type ProcessResponse,
  type SummarizeResponse,
} from "@/src/lib/study/protocol";
import type { AssistantLocale } from "@/src/lib/assistant/actions";
import type { LlmMessage } from "@/src/lib/assistant/llm";
import { retrieveStudy } from "./studyRetrieval";

/** Local summaries fit the /api/llm/chat per-message cap (8000). */
const LOCAL_SUMMARY_BUDGET_CHARS = 6500;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : fallback;
}

// ---------------------------------------------------------------- process

/**
 * Processes one document. Cloud: the server pulls the bytes from
 * Storage. Local: the caller passes the bytes (upload flow has the
 * File; re-process loads the blob first).
 */
export async function processDocument(
  id: string,
  kind: DocumentKind,
  blob: Blob | null,
): Promise<ProcessResponse> {
  if (CLOUD_ENABLED) {
    const result = await apiUnknown(
      `/api/documents/${encodeURIComponent(id)}/process`,
      "POST",
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    if (!isProcessResponse(result.data)) {
      throw new Error("Unerwartete Serverantwort.");
    }

    return result.data;
  }

  if (blob === null) {
    throw new Error("Datei nicht gefunden.");
  }

  await localUpdateMeta(id, { extractionStatus: "processing" });

  let bytes: Uint8Array;

  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch {
    await localUpdateMeta(id, { extractionStatus: "failed" });

    throw new Error("Datei konnte nicht gelesen werden.");
  }

  try {
    const extracted = await extractDocument(kind, bytes);
    const chunks = chunkBlocks(extracted.blocks);
    const warnings = [...extracted.warnings];
    const kept = chunks.slice(0, MAX_CHUNKS_PER_DOC);

    if (kept.length < chunks.length) {
      warnings.push(
        `Sehr langes Dokument: nur die ersten ${MAX_CHUNKS_PER_DOC} von ${chunks.length} Abschnitten wurden übernommen.`,
      );
    }

    await saveDocumentChunks(
      id,
      kept.map((chunk) => ({
        index: chunk.index,
        text: chunk.text,
        refs: chunk.refs,
        tokenCount: estimateTokens(chunk.charCount),
      })),
    );
    await localSaveText(id, blocksToText(extracted.blocks));

    return {
      status: "completed",
      chunks: kept.length,
      blocks: extracted.blocks.length,
      warnings,
      message:
        kept.length === 1
          ? "Dokument verarbeitet: 1 Abschnitt."
          : `Dokument verarbeitet: ${kept.length} Abschnitte.`,
    };
  } catch (error: unknown) {
    if (error instanceof ExtractError) {
      const response = processResponseOfExtractError(error);
      await localUpdateMeta(id, { extractionStatus: response.status });

      return response;
    }

    await localUpdateMeta(id, { extractionStatus: "failed" });

    throw new Error(messageOf(error, "Unbekannter Fehler bei der Texterkennung."));
  }
}

// --------------------------------------------------------------- llm chat

async function llmChatRemote(
  messages: LlmMessage[],
  numPredict: number,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  if (signal !== undefined && signal.aborted) {
    throw new Error("Abgebrochen.");
  }

  let res: Response;

  try {
    res = await fetcher("/api/llm/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        options: { think: false, temperature: 0, numPredict },
      }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    if (signal !== undefined && signal.aborted) {
      throw new Error("Abgebrochen.");
    }

    throw new Error(
      "Keine Verbindung zum Server. Prüfe deine Verbindung und versuche es erneut.",
    );
  }

  if (res.status === 401) {
    throw new Error("Sitzung abgelaufen. Bitte melde dich erneut an.");
  }

  let parsed: unknown = null;

  try {
    parsed = (await res.json()) as unknown;
  } catch {
    throw new Error(`Serverfehler (${res.status}).`);
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { ok?: unknown }).ok === true &&
    typeof (parsed as { data?: unknown }).data === "object" &&
    (parsed as { data?: unknown }).data !== null &&
    typeof
      ((parsed as { data: Record<string, unknown> }).data.content) === "string"
  ) {
    return (parsed as { data: { content: string } }).data.content;
  }

  const record = parsed as Record<string, unknown> | null;
  const error = record?.error as Record<string, unknown> | undefined;

  throw new Error(
    typeof error?.message === "string"
      ? error.message
      : `Serverfehler (${res.status}).`,
  );
}

function toCitationSources(sources: GroundedSource[]): CitationSource[] {
  return sources.map((source) => ({
    marker: source.marker,
    documentName: source.documentName,
    refLabel: source.refLabel,
  }));
}

function dedupeRefs(sources: GroundedSource[]): string[] {
  return [...new Set(sources.map((source) => source.refLabel))].filter(
    (label) => label !== "",
  );
}

// ------------------------------------------------------------- summarize

export async function summarizeDocument(
  id: string,
  locale: AssistantLocale,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SummarizeResponse> {
  if (CLOUD_ENABLED) {
    const result = await apiUnknown("/api/study/summarize", "POST", {
      documentId: id,
      locale,
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    if (!isSummarizeResponse(result.data)) {
      throw new Error("Unerwartete Serverantwort.");
    }

    return result.data;
  }

  const docs = await localListDocuments();
  const meta = docs.find((doc) => doc.id === id);

  if (meta === undefined) {
    throw new Error("Dokument nicht gefunden.");
  }

  if (meta.extractionStatus !== "completed") {
    const summary =
      locale === "ru"
        ? `Документ «${meta.name}» ещё не обработан — сначала извлеки текст.`
        : `„${meta.name}“ ist noch nicht verarbeitet — bitte zuerst Text erkennen lassen.`;

    return {
      summary,
      documentName: meta.name,
      refsUsed: [],
      truncated: false,
      chunkCount: 0,
    };
  }

  const stored = await getDocumentChunks(id);

  if (stored === null || stored.length === 0) {
    return {
      summary: insufficientContextMessage(locale),
      documentName: meta.name,
      refsUsed: [],
      truncated: false,
      chunkCount: 0,
    };
  }

  const { included, truncated } = fitSourcesToBudget(
    stored.map((chunk) => ({ chunk, text: chunk.text })),
    LOCAL_SUMMARY_BUDGET_CHARS,
  );
  const sources: GroundedSource[] = included.map((entry, index) => ({
    marker: `[Q${index + 1}]`,
    documentName: meta.name,
    refLabel: formatSourceRefs(entry.chunk.refs),
    text: entry.chunk.text,
  }));
  const chat = await groundedAnswer(
    (messages) => llmChatRemote(messages, 1200, fetcher, signal),
    summaryPrompt(locale, meta.name, sources, truncated),
    toCitationSources(sources),
    locale,
  );

  return {
    summary: chat.text,
    documentName: meta.name,
    refsUsed: dedupeRefs(sources),
    truncated,
    chunkCount: stored.length,
  };
}

// --------------------------------------------------------------- explain

export async function explainInDocument(
  id: string,
  question: string,
  locale: AssistantLocale,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<ExplainResponse> {
  if (CLOUD_ENABLED) {
    const result = await apiUnknown("/api/study/explain", "POST", {
      documentId: id,
      question,
      locale,
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    if (!isExplainResponse(result.data)) {
      throw new Error("Unerwartete Serverantwort.");
    }

    return result.data;
  }

  const docs = await localListDocuments();
  const meta = docs.find((doc) => doc.id === id);

  if (meta === undefined) {
    throw new Error("Dokument nicht gefunden.");
  }

  const retrieval = await retrieveStudy({
    query: question,
    documentId: id,
    limit: 6,
  });

  if (!retrieval.ok) {
    throw new Error(retrieval.error.message);
  }

  if (retrieval.data.sources.length === 0) {
    return {
      answer: insufficientContextMessage(locale),
      documentName: meta.name,
      refsUsed: [],
      insufficient: true,
    };
  }

  const sources: GroundedSource[] = retrieval.data.sources.map(
    (source, index) => ({
      marker: `[Q${index + 1}]`,
      documentName: source.documentName,
      refLabel: source.refLabel,
      text: source.text,
    }),
  );
  const chat = await groundedAnswer(
    (messages) => llmChatRemote(messages, 800, fetcher, signal),
    explainPrompt(locale, meta.name, question, sources),
    toCitationSources(sources),
    locale,
  );

  return {
    answer: chat.text,
    documentName: meta.name,
    refsUsed: dedupeRefs(sources),
    insufficient: false,
  };
}
