/**
 * Batched question generation loop, framework-free so the Study UI
 * and (via the same callbacks) tests share it: each batch asks for
 * fresh questions over the not-yet-covered labels, dedupes exact +
 * near duplicates against everything saved so far, and persists
 * incrementally — a failed later batch never loses earlier saves.
 */

import { filterFreshQuestions } from "@/src/lib/study/coverage";
import type { QuizQuestion } from "@/src/lib/quiz";
import type {
  QuestionCoverage,
  QuestionsResponse,
} from "@/src/lib/study/protocol";

/** Batches per click (each batch is one model call). */
export const DEFAULT_MAX_BATCHES = 3;
/** Saved questions per click (repeats continue where this stops). */
export const DEFAULT_MAX_SAVED = 10;
/** Empty batches in a row before the run saturates. */
export const SATURATED_AFTER_EMPTY = 2;

export type BatchGenerate = (
  coveredRefs: string[],
) => Promise<QuestionsResponse>;

export type BatchSave = (fresh: QuizQuestion[]) => Promise<void>;

export type BatchProgress = {
  batch: number;
  saved: number;
  labels: string[];
  coverage: QuestionCoverage;
};

export type BatchRunOptions = {
  generate: BatchGenerate;
  save: BatchSave;
  /** Already persisted questions (dedup baseline). */
  existing: QuizQuestion[];
  /** DTOs mapped to QuizQuestion records (ids, subject, doc link). */
  mapResponse: (response: QuestionsResponse) => QuizQuestion[];
  maxBatches?: number;
  maxSaved?: number;
  signal?: AbortSignal;
  onBatch?: (progress: BatchProgress) => void;
};

export type BatchRunStatus =
  | "done"
  | "saturated"
  | "cancelled"
  | "error";

export type BatchRunResult = {
  /** Everything persisted during this run (partial on error). */
  saved: QuizQuestion[];
  batches: number;
  skippedExact: number;
  skippedNear: number;
  droppedInvalid: number;
  status: BatchRunStatus;
  savedCapReached: boolean;
  error: string | null;
  coverage: QuestionCoverage | null;
};

function labelsOf(items: QuizQuestion[]): string[] {
  return items.flatMap((item) => item.sourceRefs ?? []);
}

/** Read through a call: the flag can flip across any await. */
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function runQuestionBatches(
  opts: BatchRunOptions,
): Promise<BatchRunResult> {
  const maxBatches =
    Number.isInteger(opts.maxBatches) && (opts.maxBatches ?? 0) > 0
      ? (opts.maxBatches as number)
      : DEFAULT_MAX_BATCHES;
  const maxSaved =
    Number.isInteger(opts.maxSaved) && (opts.maxSaved ?? 0) > 0
      ? (opts.maxSaved as number)
      : DEFAULT_MAX_SAVED;
  const pool: QuizQuestion[] = [...opts.existing];
  const saved: QuizQuestion[] = [];
  const result: BatchRunResult = {
    saved,
    batches: 0,
    skippedExact: 0,
    skippedNear: 0,
    droppedInvalid: 0,
    status: "done",
    savedCapReached: false,
    error: null,
    coverage: null,
  };
  let emptyStreak = 0;

  for (let batch = 1; batch <= maxBatches; batch += 1) {
    if (signalAborted(opts.signal)) {
      result.status = "cancelled";

      return result;
    }

    let response: QuestionsResponse;

    try {
      response = await opts.generate(labelsOf(pool));
    } catch (error: unknown) {
      result.status = "error";
      result.error =
        error instanceof Error ? error.message : "Unbekannter Fehler.";

      return result;
    }

    if (signalAborted(opts.signal)) {
      result.status = "cancelled";

      return result;
    }

    if (response.insufficient) {
      result.status = "error";
      result.error =
        "Zu diesem Dokument liegen keine auswertbaren Textstellen vor — Fragen können nicht erstellt werden.";

      return result;
    }

    result.batches = batch;
    result.coverage = response.coverage;
    result.droppedInvalid += response.droppedInvalid;

    const { fresh, skippedExact, skippedNear } = filterFreshQuestions(
      pool,
      opts.mapResponse(response),
    );

    result.skippedExact += skippedExact;
    result.skippedNear += skippedNear;

    try {
      await opts.save(fresh);
    } catch (error: unknown) {
      result.status = "error";
      result.error =
        error instanceof Error ? error.message : "Speichern fehlgeschlagen.";

      return result;
    }

    pool.push(...fresh);
    saved.push(...fresh);
    emptyStreak = fresh.length === 0 ? emptyStreak + 1 : 0;

    opts.onBatch?.({
      batch,
      saved: saved.length,
      labels: response.window.labels,
      coverage: response.coverage,
    });

    if (saved.length >= maxSaved) {
      result.savedCapReached = true;

      return result;
    }

    if (emptyStreak >= SATURATED_AFTER_EMPTY) {
      result.status = "saturated";

      return result;
    }
  }

  return result;
}
