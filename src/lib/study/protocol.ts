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
    typeof record.message === "string"
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
