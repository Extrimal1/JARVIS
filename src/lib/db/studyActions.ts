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
  batchSummaryPrompt,
  explainPrompt,
  fitSourcesToBudget,
  questionPrompt,
  summaryPrompt,
  synthesizePrompt,
  type GroundedSource,
} from "@/src/lib/study/prompts";
import {
  EMPTY_QUESTION_COVERAGE,
  EMPTY_QUESTION_WINDOW,
  isDocumentCoverage,
  isExplainResponse,
  isProcessResponse,
  isQuestionsResponse,
  isSummarizeBatchResponse,
  isSummarizeResponse,
  isSummaryRecordList,
  isSynthesizeResponse,
  MAX_CHUNKS_PER_DOC,
  processResponseOfExtractError,
  type DocumentCoverage,
  type DocumentSummary,
  type ExplainResponse,
  type ProcessResponse,
  type QuestionsResponse,
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
  getDocumentSummary,
  saveDocumentSummary,
} from "@/src/lib/study/localSummaries";
import {
  groupSectionsForReduction,
  orderSpansForSynthesis,
  resolveMarkersToLabels,
  spanUnitCounts,
  validateSynthesisRefs,
} from "@/src/lib/study/summaries";
import { createId } from "@/src/lib/ids";
import {
  parseQuestionsWithRepair,
  QuestionsParseError,
  QuestionsTruncatedError,
  assertCompleteQuestions,
} from "@/src/lib/study/questions";
import type { AssistantLocale } from "@/src/lib/assistant/actions";
import type { LlmMessage } from "@/src/lib/assistant/llm";
import { retrieveStudy } from "./studyRetrieval";

/** Local summaries fit the /api/llm/chat per-message cap (8000). */
const LOCAL_SUMMARY_BUDGET_CHARS = 6500;

/** Local question prompts leave room for the strict JSON contract. */
const LOCAL_QUESTIONS_BUDGET_CHARS = 6000;

/**
 * Question JSON needs more room than summaries or answers: six
 * items with options and explanations must never hit the cutoff
 * mid-array (truncated JSON is unparseable by design).
 */
const LOCAL_QUESTIONS_NUM_PREDICT = 3000;

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
    await localUpdateMeta(id, { pageCount: extracted.pageCount });

    return {
      status: "completed",
      chunks: kept.length,
      blocks: extracted.blocks.length,
      warnings,
      pageCount: extracted.pageCount,
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

export type LlmChatOutput = {
  content: string;
  doneReason: string | null;
  evalCount: number | null;
  thinkingChars: number;
};

async function llmChatRemote(
  messages: LlmMessage[],
  numPredict: number,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  format?: "json",
): Promise<LlmChatOutput> {
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
        options: {
          think: false,
          temperature: 0,
          numPredict,
          ...(format === undefined ? {} : { format }),
        },
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
    const data = (parsed as { data: Record<string, unknown> }).data;

    return {
      content: data.content as string,
      doneReason:
        typeof data.doneReason === "string" ? data.doneReason : null,
      evalCount:
        typeof data.evalCount === "number" &&
        Number.isInteger(data.evalCount)
          ? data.evalCount
          : null,
      thinkingChars:
        typeof data.thinkingChars === "number" &&
        Number.isInteger(data.thinkingChars) &&
        data.thinkingChars >= 0
          ? data.thinkingChars
          : 0,
    };
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
    async (messages) =>
      (await llmChatRemote(messages, 1200, fetcher, signal)).content,
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
    async (messages) =>
      (await llmChatRemote(messages, 800, fetcher, signal)).content,
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

// ------------------------------------------------------------- questions

/**
 * Generates grounded exam questions for one document. Cloud mode
 * calls POST /api/study/questions; local mode reasons over the
 * IndexedDB chunks through /api/llm/chat in native JSON mode with
 * the same prompt, the same strict parser, and the same single
 * repair round. Both modes select the same spread window over
 * not-yet-covered slices (`coveredRefs`); unparseable model
 * output is an honest error — never heuristic questions.
 */
export async function generateQuestionsForDocument(
  id: string,
  locale: AssistantLocale,
  count = 6,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  coveredRefs: string[] = [],
): Promise<QuestionsResponse> {
  if (CLOUD_ENABLED) {
    const result = await apiUnknown("/api/study/questions", "POST", {
      documentId: id,
      locale,
      count,
      coveredRefs,
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    if (!isQuestionsResponse(result.data)) {
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
    return {
      questions: [],
      documentId: id,
      documentName: meta.name,
      subject: meta.subject,
      refsUsed: [],
      truncated: false,
      chunkCount: 0,
      insufficient: true,
      droppedInvalid: 0,
      partial: false,
      window: EMPTY_QUESTION_WINDOW,
      coverage: EMPTY_QUESTION_COVERAGE,
    };
  }

  const stored = await getDocumentChunks(id);

  if (stored === null || stored.length === 0) {
    return {
      questions: [],
      documentId: id,
      documentName: meta.name,
      subject: meta.subject,
      refsUsed: [],
      truncated: false,
      chunkCount: 0,
      insufficient: true,
      droppedInvalid: 0,
      partial: false,
      window: EMPTY_QUESTION_WINDOW,
      coverage: EMPTY_QUESTION_COVERAGE,
    };
  }

  const selection = selectQuestionWindow(
    stored.map((chunk) => ({
      index: chunk.index,
      text: chunk.text,
      refs: chunk.refs,
      payload: chunk,
    })),
    coveredRefs,
    count,
    LOCAL_QUESTIONS_BUDGET_CHARS,
  );
  const sources: GroundedSource[] = selection.picked.map((entry, index) => ({
    marker: `[Q${index + 1}]`,
    documentName: meta.name,
    refLabel: formatSourceRefs(entry.refs),
    text: entry.payload.text,
  }));

  let parsed;

  try {
    parsed = await parseQuestionsWithRepair(
      async (messages) => {
        const result = await llmChatRemote(
          messages,
          LOCAL_QUESTIONS_NUM_PREDICT,
          fetcher,
          signal,
          "json",
        );

        // Exhaustion never enters parsing or repair: a longer retry
        // prompt would only exhaust the budget further.
        assertCompleteQuestions(result);

        return result.content;
      },
      questionPrompt(locale, meta.name, sources, count),
      sources,
      locale,
    );
  } catch (error: unknown) {
    if (
      error instanceof QuestionsParseError ||
      error instanceof QuestionsTruncatedError
    ) {
      throw new Error(error.message);
    }

    throw error;
  }

  return {
    questions: parsed.questions,
    documentId: id,
    documentName: meta.name,
    subject: meta.subject,
    refsUsed: dedupeRefs(sources),
    truncated: selection.truncated,
    chunkCount: stored.length,
    insufficient: false,
    droppedInvalid: parsed.droppedInvalid,
    partial: parsed.questions.length < count,
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
  };
}

// --------------------------------------------------------------- coverage

/**
 * Per-document coverage snapshot. Cloud mode asks the server
 * (chunks live there); local mode derives the same snapshot
 * from IndexedDB chunks plus the caller's persisted labels.
 */
export async function getDocumentCoverage(
  id: string,
  labels: string[],
  questionCount: number,
): Promise<DocumentCoverage> {
  if (CLOUD_ENABLED) {
    const result = await apiUnknown(
      `/api/study/coverage?documentId=${encodeURIComponent(id)}`,
      "GET",
    );

    if (!result.ok) {
      throw new Error(result.error);
    }

    if (!isDocumentCoverage(result.data)) {
      throw new Error("Unerwartete Serverantwort.");
    }

    return result.data;
  }

  const docs = await localListDocuments();
  const meta = docs.find((doc) => doc.id === id);

  if (meta === undefined) {
    throw new Error("Dokument nicht gefunden.");
  }

  const stored = await getDocumentChunks(id);
  const groups = groupChunksByUnit(
    (stored ?? []).map((chunk) => ({
      index: chunk.index,
      text: chunk.text,
      refs: chunk.refs,
    })),
  );
  const stats = coverageStats(groups, labels);

  return {
    documentId: id,
    totalPages: typeof meta.pageCount === "number" ? meta.pageCount : null,
    usableUnits: stats.usableUnits,
    coveredUnits: stats.coveredUnits,
    percent: stats.percent,
    questionCount,
    target: targetQuestionCount(stats.usableUnits),
  };
}

// ------------------------------------------------- summaries (4C)

const LOCAL_BATCH_NUM_PREDICT = 1200;
const LOCAL_SYNTHESIZE_NUM_PREDICT = 2000;
const LOCAL_SYNTHESIS_INPUT_BUDGET_CHARS = 6000;
const LOCAL_MAX_SYNTHESIS_LEVELS = 2;

/**
 * Stored draft/active summary state. Cloud mode reads the row
 * list (one row per document); local mode reads IndexedDB.
 */
export async function getSummaryState(
  id: string,
): Promise<DocumentSummary | null> {
  if (CLOUD_ENABLED) {
    const result = await apiUnknown("/api/summaries", "GET");

    if (!result.ok) {
      throw new Error(result.error);
    }

    if (!isSummaryRecordList(result.data)) {
      throw new Error("Unerwartete Serverantwort.");
    }

    return result.data.find((record) => record.documentId === id) ?? null;
  }

  return getDocumentSummary(id);
}

async function localPlan(id: string): Promise<{
  meta: { name: string };
  plan: ReturnType<typeof planSummarySweep>;
}> {
  const docs = await localListDocuments();
  const meta = docs.find((doc) => doc.id === id);

  if (meta === undefined) {
    throw new Error("Dokument nicht gefunden.");
  }

  if (meta.extractionStatus !== "completed") {
    throw new Error("Das Dokument ist noch nicht verarbeitet.");
  }

  const stored = await getDocumentChunks(id);
  const plan = planSummarySweep(
    groupChunksByUnit(
      (stored ?? []).map((chunk) => ({
        index: chunk.index,
        text: chunk.text,
        refs: chunk.refs,
      })),
    ),
  );

  if (plan.length === 0) {
    throw new Error(
      "Zu diesem Dokument liegen keine auswertbaren Textstellen vor.",
    );
  }

  return { meta, plan };
}

/**
 * Next span batch: cloud mode calls the batch endpoint; local
 * mode plans, generates (same prompt + budgets), and persists
 * identically in IndexedDB. Only persisted spans count.
 */
export async function summarizeNextSpan(
  id: string,
  locale: AssistantLocale,
  generationId: string | null,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SummarizeBatchResponse> {
  if (CLOUD_ENABLED) {
    const result = await apiUnknown("/api/study/summarize/batch", "POST", {
      documentId: id,
      locale,
      generationId,
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    if (!isSummarizeBatchResponse(result.data)) {
      throw new Error("Unerwartete Serverantwort.");
    }

    return result.data;
  }

  const { meta, plan } = await localPlan(id);
  const planned = plan.map((span, order) => ({
    key: span.key,
    label: span.label,
    order,
  }));
  const planKeys = new Set(plan.map((span) => span.key));
  const current = await getDocumentSummary(id);
  let gid = generationId;
  let effective: SummarySpanResult[] = [];
  let active = current?.active ?? null;

  if (gid === null) {
    gid = createId();

    await saveDocumentSummary(id, {
      documentId: id,
      status: active === null ? "partial" : "complete",
      active,
      draft: {
        generationId: gid,
        plannedSpans: planned,
        spans: [],
        preview: null,
        startedAt: new Date().toISOString(),
      },
    });
  } else {
    if (current?.draft?.generationId !== gid) {
      throw new Error(
        "Unbekannte oder abgelaufene Generierung — bitte neu starten.",
      );
    }

    active = current.active;
    effective = current.draft.spans.filter((span) => planKeys.has(span.key));
  }

  const doneKeys = new Set(effective.map((span) => span.key));
  const nextIndex = plan.findIndex((span) => !doneKeys.has(span.key));

  if (nextIndex === -1) {
    const progress = spanUnitCounts(plan, [...doneKeys]);

    await saveDocumentSummary(id, {
      documentId: id,
      status: active === null ? "partial" : "complete",
      active,
      draft:
        current?.draft === undefined || current.draft === null
          ? null
          : { ...current.draft, plannedSpans: planned, spans: effective },
    });

    return {
      documentId: id,
      generationId: gid,
      span: { key: "", label: "", index: plan.length, total: plan.length },
      text: "",
      refs: [],
      processedUnits: progress.processedUnits,
      usableUnits: progress.usableUnits,
      percent: progress.percent,
      done: true,
    };
  }

  const next = plan[nextIndex] as (typeof plan)[number];
  const stored = (await getDocumentChunks(id)) ?? [];
  const wanted = new Set(next.chunkIndices);
  const sources: GroundedSource[] = stored
    .filter((chunk) => wanted.has(chunk.index))
    .map((chunk, index) => ({
      marker: `[Q${index + 1}]`,
      documentName: meta.name,
      refLabel: formatSourceRefs(chunk.refs),
      text: chunk.text,
    }));

  let raw: string;

  try {
    const chat = await groundedAnswer(
      async (messages) => {
        const result = await llmChatRemote(
          messages,
          LOCAL_BATCH_NUM_PREDICT,
          fetcher,
          signal,
        );

        assertCompleteQuestions(result);

        return result.content;
      },
      batchSummaryPrompt(locale, meta.name, next.label, sources),
      toCitationSources(sources),
      locale,
    );

    raw = chat.text;
  } catch (error: unknown) {
    if (error instanceof QuestionsTruncatedError) {
      throw new Error(error.message);
    }

    throw error;
  }

  const resolved = resolveMarkersToLabels(raw, sources);
  const updated: SummarySpanResult[] = [
    ...effective,
    {
      key: next.key,
      label: next.label,
      text: resolved.text,
      refs: resolved.refs,
      completedAt: new Date().toISOString(),
    },
  ];
  const progress = spanUnitCounts(
    plan,
    updated.map((span) => span.key),
  );

  await saveDocumentSummary(id, {
    documentId: id,
    status: active === null ? "partial" : "complete",
    active,
    draft: {
      generationId: gid,
      plannedSpans: planned,
      spans: updated,
      preview: current?.draft?.preview ?? null,
      startedAt:
        current?.draft?.startedAt ?? new Date().toISOString(),
    },
  });

  return {
    documentId: id,
    generationId: gid,
    span: {
      key: next.key,
      label: next.label,
      index: nextIndex,
      total: plan.length,
    },
    text: updated[updated.length - 1]?.text ?? "",
    refs: updated[updated.length - 1]?.refs ?? [],
    processedUnits: progress.processedUnits,
    usableUnits: progress.usableUnits,
    percent: progress.percent,
    done: false,
  };
}

/**
 * Synthesis over persisted spans with promotion on complete
 * coverage. Cloud mode calls the endpoint; local mode mirrors
 * the reduction, validation, and atomic promote-or-preview.
 */
export async function synthesizeDocumentSummary(
  id: string,
  locale: AssistantLocale,
  generationId: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<SynthesizeResponse> {
  if (CLOUD_ENABLED) {
    const result = await apiUnknown("/api/study/summarize/synthesize", "POST", {
      documentId: id,
      locale,
      generationId,
    });

    if (!result.ok) {
      throw new Error(result.error);
    }

    if (!isSynthesizeResponse(result.data)) {
      throw new Error("Unerwartete Serverantwort.");
    }

    return result.data;
  }

  const { meta, plan } = await localPlan(id);
  const current = await getDocumentSummary(id);

  if (current === null || current.draft === null) {
    throw new Error("Keine Zusammenfassung vorhanden.");
  }

  if (current.draft.generationId !== generationId) {
    throw new Error(
      "Unbekannte oder abgelaufene Generierung — bitte neu starten.",
    );
  }

  const planKeys = new Set(plan.map((span) => span.key));
  const effective = current.draft.spans.filter((span) =>
    planKeys.has(span.key),
  );

  if (effective.length === 0) {
    throw new Error("Noch keine Abschnitte zusammengefasst.");
  }

  const complete = effective.length === plan.length;
  let sections = orderSpansForSynthesis(effective).map((span) => ({
    label: span.label,
    text: span.text,
  }));
  let levels = 1;

  const chat = async (
    messages: Parameters<typeof llmChatRemote>[0],
  ): Promise<string> => {
    const result = await llmChatRemote(
      messages,
      LOCAL_SYNTHESIZE_NUM_PREDICT,
      fetcher,
      signal,
    );

    assertCompleteQuestions(result);

    return result.content;
  };

  try {
    while (
      sections.reduce(
        (sum, section) => sum + section.label.length + section.text.length,
        0,
      ) > LOCAL_SYNTHESIS_INPUT_BUDGET_CHARS &&
      levels <= LOCAL_MAX_SYNTHESIS_LEVELS
    ) {
      const groups = groupSectionsForReduction(
        sections,
        LOCAL_SYNTHESIS_INPUT_BUDGET_CHARS,
      );

      if (groups.length <= 1) break;

      const merged: { label: string; text: string }[] = [];

      for (const group of groups) {
        merged.push({
          label: group.map((section) => section.label).join(", "),
          text: await chat(synthesizePrompt(locale, meta.name, group, true)),
        });
      }

      sections = merged;
      levels += 1;
    }

    const text = await chat(
      synthesizePrompt(locale, meta.name, sections, complete),
    );
    const check = validateSynthesisRefs(
      text,
      plan.flatMap((span) => span.units),
    );

    if (!check.ok) {
      throw new Error(
        "Die Synthese enthielt ungültige Quellenangaben — bitte erneut versuchen.",
      );
    }

    if (complete) {
      await saveDocumentSummary(id, {
        documentId: id,
        status: "complete",
        active: {
          text,
          refs: check.refs,
          completedAt: new Date().toISOString(),
        },
        draft: null,
      });
    } else {
      await saveDocumentSummary(id, {
        documentId: id,
        status: current.active === null ? "partial" : "complete",
        active: current.active,
        draft: {
          ...current.draft,
          plannedSpans: plan.map((span, order) => ({
            key: span.key,
            label: span.label,
            order,
          })),
          spans: effective,
          preview: { text, refs: check.refs },
        },
      });
    }

    return {
      documentId: id,
      generationId,
      text,
      refs: check.refs,
      complete,
      levels,
    };
  } catch (error: unknown) {
    if (error instanceof QuestionsTruncatedError) {
      throw new Error(error.message);
    }

    throw error;
  }
}
