/**
 * Study-intelligence wire protocol: request/response DTOs shared by
 * the API routes and both client backends (cloud fetch validates
 * with these guards; local mode builds the same shapes).
 */

import type { ExtractionStatus } from "@/src/lib/documents";
import {
  ExtractError,
  isSourceRef,
  type SourceRef,
} from "@/src/lib/study/extract";

export type { ExtractionStatus };

/** A single document contributes at most this many chunks. */
export const MAX_CHUNKS_PER_DOC = 2000;

export type RetrieveChunkDto = {
  chunkId: string;
  documentId: string;
  documentName: string;
  index: number;
  /** Excerpt, truncated for tool context. */
  text: string;
  refs: SourceRef[];
  refLabel: string;
  score: number;
  matchedTerms: string[];
};

export type RetrieveResponse = {
  chunks: RetrieveChunkDto[];
  totalCandidates: number;
  terms: string[];
};

export function isRetrieveResponse(value: unknown): value is RetrieveResponse {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    Array.isArray(record.chunks) &&
    record.chunks.every((chunk) => {
      if (typeof chunk !== "object" || chunk === null) return false;

      const item = chunk as Record<string, unknown>;

      return (
        typeof item.chunkId === "string" &&
        typeof item.documentId === "string" &&
        typeof item.documentName === "string" &&
        typeof item.index === "number" &&
        typeof item.text === "string" &&
        Array.isArray(item.refs) &&
        item.refs.every(isSourceRef) &&
        typeof item.refLabel === "string" &&
        typeof item.score === "number" &&
        Array.isArray(item.matchedTerms) &&
        item.matchedTerms.every((term) => typeof term === "string")
      );
    }) &&
    typeof record.totalCandidates === "number" &&
    Array.isArray(record.terms) &&
    record.terms.every((term) => typeof term === "string")
  );
}

export type ProcessResponse = {
  status: ExtractionStatus;
  chunks: number;
  blocks: number;
  warnings: string[];
  message: string;
  /** Total PDF pages / PPTX slides; absent when unknown or inapplicable. */
  pageCount?: number | null;
};

const PROCESS_STATUSES: ExtractionStatus[] = [
  "not_processed",
  "processing",
  "completed",
  "failed",
  "unsupported",
];

export function isProcessResponse(value: unknown): value is ProcessResponse {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.status === "string" &&
    PROCESS_STATUSES.includes(record.status as ExtractionStatus) &&
    typeof record.chunks === "number" &&
    typeof record.blocks === "number" &&
    Array.isArray(record.warnings) &&
    record.warnings.every((warning) => typeof warning === "string") &&
    typeof record.message === "string" &&
    (record.pageCount === undefined ||
      record.pageCount === null ||
      typeof record.pageCount === "number")
  );
}

export type SummarizeResponse = {
  summary: string;
  documentName: string;
  refsUsed: string[];
  truncated: boolean;
  chunkCount: number;
};

export function isSummarizeResponse(
  value: unknown,
): value is SummarizeResponse {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.summary === "string" &&
    typeof record.documentName === "string" &&
    Array.isArray(record.refsUsed) &&
    record.refsUsed.every((ref) => typeof ref === "string") &&
    typeof record.truncated === "boolean" &&
    typeof record.chunkCount === "number"
  );
}

export type ExplainResponse = {
  answer: string;
  documentName: string;
  refsUsed: string[];
  insufficient: boolean;
};

export function isExplainResponse(value: unknown): value is ExplainResponse {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.answer === "string" &&
    typeof record.documentName === "string" &&
    Array.isArray(record.refsUsed) &&
    record.refsUsed.every((ref) => typeof ref === "string") &&
    typeof record.insufficient === "boolean"
  );
}

export type GeneratedQuestionDto = {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  kind: "single" | "multiple" | "free";
  correctIndices?: number[];
  gradingCriteria?: string;
  /** Resolved page/section labels (never raw [Qn] markers). */
  refs: string[];
};

export function isGeneratedQuestionDto(
  value: unknown,
): value is GeneratedQuestionDto {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.question === "string" &&
    Array.isArray(record.options) &&
    record.options.every((option) => typeof option === "string") &&
    typeof record.correctIndex === "number" &&
    typeof record.explanation === "string" &&
    (record.kind === "single" ||
      record.kind === "multiple" ||
      record.kind === "free") &&
    (record.correctIndices === undefined ||
      (Array.isArray(record.correctIndices) &&
        record.correctIndices.every(
          (index): index is number => typeof index === "number",
        ))) &&
    (record.gradingCriteria === undefined ||
      typeof record.gradingCriteria === "string") &&
    Array.isArray(record.refs) &&
    record.refs.every((ref) => typeof ref === "string")
  );
}

/** Which document slice this batch drew on. */
export type QuestionWindow = {
  labels: string[];
  poolSize: number;
  truncated: boolean;
};

export function isQuestionWindow(value: unknown): value is QuestionWindow {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    Array.isArray(record.labels) &&
    record.labels.every((label) => typeof label === "string") &&
    typeof record.poolSize === "number" &&
    typeof record.truncated === "boolean"
  );
}

/** Coverage before this batch (callers re-derive after saving). */
export type QuestionCoverage = {
  usableUnits: number;
  coveredUnits: number;
  percent: number;
};

export function isQuestionCoverage(
  value: unknown,
): value is QuestionCoverage {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.usableUnits === "number" &&
    typeof record.coveredUnits === "number" &&
    typeof record.percent === "number"
  );
}

export const EMPTY_QUESTION_WINDOW: QuestionWindow = {
  labels: [],
  poolSize: 0,
  truncated: false,
};

// ------------------------------------------------- document summaries

/** One planned summary span (contiguous units, stable key). */
export type SummarySpanPlan = {
  key: string;
  label: string;
  /** Distributed processing position (0-based). */
  order: number;
};

export function isSummarySpanPlan(value: unknown): value is SummarySpanPlan {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.key === "string" &&
    typeof record.label === "string" &&
    typeof record.order === "number"
  );
}

/** One persisted per-span summary. */
export type SummarySpanResult = {
  key: string;
  label: string;
  text: string;
  refs: string[];
  completedAt: string;
};

export function isSummarySpanResult(
  value: unknown,
): value is SummarySpanResult {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.key === "string" &&
    typeof record.label === "string" &&
    typeof record.text === "string" &&
    Array.isArray(record.refs) &&
    record.refs.every((ref) => typeof ref === "string") &&
    typeof record.completedAt === "string"
  );
}

export type SummaryStatus = "none" | "partial" | "complete";

/**
 * Draft + active summary state for one document. The active
 * summary stays readable and untouched while a draft generation
 * (its own generation_id + spans) runs; promotion replaces the
 * active text only after a successful complete synthesis.
 */
export type DocumentSummary = {
  documentId: string;
  status: SummaryStatus;
  active: {
    text: string;
    refs: string[];
    completedAt: string;
  } | null;
  draft: {
    generationId: string;
    plannedSpans: SummarySpanPlan[];
    spans: SummarySpanResult[];
    preview: { text: string; refs: string[] } | null;
    startedAt: string;
  } | null;
};

export function isDocumentSummary(value: unknown): value is DocumentSummary {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  const active = record.active as Record<string, unknown> | null;
  const draft = record.draft as Record<string, unknown> | null;

  return (
    typeof record.documentId === "string" &&
    (record.status === "none" ||
      record.status === "partial" ||
      record.status === "complete") &&
    (active === null ||
      (typeof active === "object" &&
        typeof active.text === "string" &&
        Array.isArray(active.refs) &&
        active.refs.every((ref) => typeof ref === "string") &&
        typeof active.completedAt === "string")) &&
    (draft === null ||
      (typeof draft === "object" &&
        typeof draft.generationId === "string" &&
        Array.isArray(draft.plannedSpans) &&
        draft.plannedSpans.every(isSummarySpanPlan) &&
        Array.isArray(draft.spans) &&
        draft.spans.every(isSummarySpanResult) &&
        (draft.preview === null ||
          (typeof draft.preview === "object" &&
            typeof (draft.preview as Record<string, unknown>).text ===
              "string" &&
            Array.isArray(
              (draft.preview as Record<string, unknown>).refs,
            ))) &&
        typeof draft.startedAt === "string"))
  );
}

/** Persisted summary record (CRUD domain shape). */
export type SummaryRecord = DocumentSummary & { id: string };

export function isSummaryRecord(value: unknown): value is SummaryRecord {
  if (typeof value !== "object" || value === null) return false;

  return (
    typeof (value as Record<string, unknown>).id === "string" &&
    isDocumentSummary(value)
  );
}

export function isSummaryRecordList(value: unknown): value is SummaryRecord[] {
  return Array.isArray(value) && value.every(isSummaryRecord);
}

/** One generated span batch with store-validated progress. */
export type SummarizeBatchResponse = {
  documentId: string;
  generationId: string;
  span: { key: string; label: string; index: number; total: number };
  text: string;
  refs: string[];
  processedUnits: number;
  usableUnits: number;
  percent: number;
  /** True when every planned span already persisted (nothing to do). */
  done: boolean;
};

export function isSummarizeBatchResponse(
  value: unknown,
): value is SummarizeBatchResponse {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;
  const span = record.span as Record<string, unknown> | undefined;

  return (
    typeof record.documentId === "string" &&
    typeof record.generationId === "string" &&
    typeof span === "object" &&
    span !== null &&
    typeof span.key === "string" &&
    typeof span.label === "string" &&
    typeof span.index === "number" &&
    typeof span.total === "number" &&
    typeof record.text === "string" &&
    Array.isArray(record.refs) &&
    record.refs.every((ref) => typeof ref === "string") &&
    typeof record.processedUnits === "number" &&
    typeof record.usableUnits === "number" &&
    typeof record.percent === "number" &&
    typeof record.done === "boolean"
  );
}

/** Final (or partial-preview) synthesis over persisted spans. */
export type SynthesizeResponse = {
  documentId: string;
  generationId: string;
  text: string;
  refs: string[];
  /** True only when every usable unit was synthesized. */
  complete: boolean;
  levels: number;
};

export function isSynthesizeResponse(
  value: unknown,
): value is SynthesizeResponse {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.documentId === "string" &&
    typeof record.generationId === "string" &&
    typeof record.text === "string" &&
    Array.isArray(record.refs) &&
    record.refs.every((ref) => typeof ref === "string") &&
    typeof record.complete === "boolean" &&
    typeof record.levels === "number"
  );
}

/** Per-document coverage snapshot for the Study UI. */
export type DocumentCoverage = {
  documentId: string;
  /** Total PDF pages / PPTX slides; null when unknown or inapplicable. */
  totalPages: number | null;
  usableUnits: number;
  coveredUnits: number;
  percent: number;
  questionCount: number;
  /** Adaptive question target for the whole document. */
  target: number;
};

export function isDocumentCoverage(
  value: unknown,
): value is DocumentCoverage {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.documentId === "string" &&
    (record.totalPages === null || typeof record.totalPages === "number") &&
    typeof record.usableUnits === "number" &&
    typeof record.coveredUnits === "number" &&
    typeof record.percent === "number" &&
    typeof record.questionCount === "number" &&
    typeof record.target === "number"
  );
}

export const EMPTY_QUESTION_COVERAGE: QuestionCoverage = {
  usableUnits: 0,
  coveredUnits: 0,
  percent: 0,
};

export type QuestionsResponse = {
  questions: GeneratedQuestionDto[];
  documentId: string;
  documentName: string;
  subject: string | null;
  refsUsed: string[];
  truncated: boolean;
  chunkCount: number;
  /** True when no usable chunks existed (no LLM call happened). */
  insufficient: boolean;
  /** Model items dropped as invalid (never repaired heuristically). */
  droppedInvalid: number;
  /** True when fewer valid questions came back than requested. */
  partial: boolean;
  window: QuestionWindow;
  coverage: QuestionCoverage;
};

export function isQuestionsResponse(
  value: unknown,
): value is QuestionsResponse {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    Array.isArray(record.questions) &&
    record.questions.every(isGeneratedQuestionDto) &&
    typeof record.documentId === "string" &&
    typeof record.documentName === "string" &&
    (record.subject === null || typeof record.subject === "string") &&
    Array.isArray(record.refsUsed) &&
    record.refsUsed.every((ref) => typeof ref === "string") &&
    typeof record.truncated === "boolean" &&
    typeof record.chunkCount === "number" &&
    typeof record.insufficient === "boolean" &&
    typeof record.droppedInvalid === "number" &&
    typeof record.partial === "boolean" &&
    isQuestionWindow(record.window) &&
    isQuestionCoverage(record.coverage)
  );
}

/**
 * Maps extraction failures to process outcomes, identically for the
 * cloud route and the local client path. Scanned pages and unknown
 * kinds are "unsupported" (honest capability gap); everything else
 * is "failed" (broken input).
 */
export function processResponseOfExtractError(
  error: ExtractError,
): ProcessResponse {
  if (error.code === "scanned" || error.code === "unsupported-kind") {
    return {
      status: "unsupported",
      chunks: 0,
      blocks: 0,
      warnings: [],
      message: error.message,
    };
  }

  return {
    status: "failed",
    chunks: 0,
    blocks: 0,
    warnings: [],
    message: error.message,
  };
}

/** Truncates excerpts at a word boundary (never mid-word). */
export function excerptOf(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const slice = text.slice(0, maxChars);
  const boundary = slice.lastIndexOf(" ");

  return `${boundary > maxChars / 2 ? slice.slice(0, boundary) : slice} …`;
}
