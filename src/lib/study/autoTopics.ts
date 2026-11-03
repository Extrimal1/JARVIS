/**
 * Shared topic-extraction orchestration: meaningful-text gate,
 * error causes, bounded retry progress, and the persist loop.
 * Both the automatic post-upload run (DocumentLibrary) and the
 * manual run (TopicTree) use this module, so local and cloud
 * behave identically and no second extraction system exists.
 */

import type { Entry } from "@/src/lib/study";
import type { AssistantLocale } from "@/src/lib/assistant/actions";
import type { TopicsExtractResponse } from "@/src/lib/study/protocol";
import {
  MAX_EXTRACT_SPANS,
  mergeExtractedTopics,
  type TopicMergeResult,
} from "@/src/lib/study/topics";

/** Letter/digit chars required across all chunks (else: no LLM call). */
export const MEANINGFUL_TEXT_MIN_CHARS = 120;

/** Retries per span label before it counts as exhausted (terminates). */
export const TOPIC_SPAN_MAX_ATTEMPTS = 3;

/** Safety cap for rounds of one document run (each covers ≤6 spans). */
export const TOPIC_EXTRACT_MAX_ROUNDS = 10;

/**
 * True when the chunks hold enough real text to extract from.
 * Whitespace-only or fragment-only chunks (e.g. OCR-less scans
 * that slipped through) yield no topics and no model call.
 */
export function hasMeaningfulText(chunks: { text: string }[]): boolean {
  let chars = 0;

  for (const chunk of chunks) {
    const matches = chunk.text.match(/[\p{L}\p{N}]/gu);

    if (matches !== null) chars += matches.length;

    if (chars >= MEANINGFUL_TEXT_MIN_CHARS) return true;
  }

  return false;
}

// ------------------------------------------------------------------- errors

export type TopicErrorCause =
  | "ollama"
  | "supabase"
  | "format"
  | "conflict"
  | "auth"
  | "aborted"
  | "empty"
  | "unknown";

export type ClassifiedTopicError = {
  cause: TopicErrorCause;
  /** Original message, never fabricated. */
  detail: string;
  retryable: boolean;
};

const CAUSE_LABELS: Record<TopicErrorCause, string> = {
  ollama: "KI-Dienst",
  supabase: "Cloud-Speicher",
  format: "Antwortformat",
  conflict: "Zwischenstand",
  auth: "Anmeldung",
  aborted: "Abbruch",
  empty: "Kein Text",
  unknown: "Fehler",
};

export function topicCauseLabel(cause: TopicErrorCause): string {
  return CAUSE_LABELS[cause];
}

/**
 * Maps a thrown extraction failure to a visible cause. Matching is
 * deliberately substring-based: callers surface error.message text
 * from several layers (fetch, API, parser), not typed codes.
 */
export function classifyTopicError(error: unknown): ClassifiedTopicError {
  const detail =
    error instanceof Error && error.message !== ""
      ? error.message
      : "Unbekannter Fehler bei der Themenextraktion.";
  const text = detail.toLowerCase();

  if (text.includes("abgebrochen")) {
    return { cause: "aborted", detail, retryable: true };
  }

  if (
    text.includes("sitzung") ||
    text.includes("angemeldet") ||
    text.includes("anmeldung") ||
    text.includes("401") ||
    text.includes("403")
  ) {
    return { cause: "auth", detail, retryable: false };
  }

  if (
    text.includes("ollama") ||
    text.includes("11434") ||
    text.includes("keine verbindung zum server") ||
    text.includes("/api/llm/chat") ||
    text.includes("ki-dienst") ||
    text.includes("modell")
  ) {
    return { cause: "ollama", detail, retryable: true };
  }

  if (
    text.includes("supabase") ||
    text.includes("cloud-backend") ||
    text.includes("cloud-speicher") ||
    text.includes("storage") ||
    text.includes("postgres")
  ) {
    return { cause: "supabase", detail, retryable: true };
  }

  if (
    text.includes("kein lesbarer text") ||
    text.includes("kein text") ||
    text.includes("eingescannt") ||
    text.includes("ocr") ||
    text.includes("nicht genügend text")
  ) {
    return { cause: "empty", detail, retryable: false };
  }

  if (
    text.includes("json") ||
    text.includes("lesbaren themen") ||
    text.includes("antwortformat") ||
    text.includes("unerwartete serverantwort")
  ) {
    return { cause: "format", detail, retryable: true };
  }

  if (
    text.includes("noch nicht verarbeitet") ||
    text.includes("läuft bereits") ||
    text.includes("bereits eine") ||
    text.includes("texterkennung")
  ) {
    return { cause: "conflict", detail, retryable: true };
  }

  return { cause: "unknown", detail, retryable: true };
}

// ----------------------------------------------------------------- progress

export type TopicExtractProgress = {
  coveredLabels: string[];
  attempts: Record<string, number>;
  exhaustedLabels: string[];
};

export function emptyTopicProgress(): TopicExtractProgress {
  return { coveredLabels: [], attempts: {}, exhaustedLabels: [] };
}

export type AppliedExtractResponse = {
  progress: TopicExtractProgress;
  /** True when this call covered at least one new span. */
  madeProgress: boolean;
  /** Skipped labels that may be retried (attempts left). */
  retryableSkipped: string[];
};

/**
 * Folds one extract response into bounded retry progress. Done
 * spans are never requested again (duplicate-safe); skipped
 * spans are retried until TOPIC_SPAN_MAX_ATTEMPTS, then
 * exhausted — so a persistently failing span terminates the
 * run instead of looping "Weiter" forever.
 */
export function applyExtractResponse(
  state: TopicExtractProgress,
  response: TopicsExtractResponse,
): AppliedExtractResponse {
  const covered = new Set(state.coveredLabels);
  const exhausted = new Set(state.exhaustedLabels);
  const attempts: Record<string, number> = { ...state.attempts };
  let madeProgress = false;

  for (const label of response.spansDone) {
    if (!covered.has(label)) {
      covered.add(label);
      madeProgress = true;
    }
  }

  for (const label of response.skippedSpans) {
    if (covered.has(label) || exhausted.has(label)) continue;

    const next = (attempts[label] ?? 0) + 1;
    attempts[label] = next;

    if (next >= TOPIC_SPAN_MAX_ATTEMPTS) exhausted.add(label);
  }

  const retryableSkipped = response.skippedSpans.filter(
    (label) => !covered.has(label) && !exhausted.has(label),
  );

  return {
    progress: {
      coveredLabels: [...covered],
      attempts,
      exhaustedLabels: [...exhausted],
    },
    madeProgress,
    retryableSkipped,
  };
}

// ------------------------------------------------------------------- runner

export type TopicExtractCall = (
  coveredLabels: string[],
  maxSpans: number,
) => Promise<TopicsExtractResponse>;

export type TopicPersistStore = {
  addEntry: (
    section: "topics",
    entry: Entry,
  ) => Promise<{ ok: boolean; error?: string }>;
  updateEntry: (
    id: string,
    patch: Partial<Entry>,
  ) => Promise<{ ok: boolean; error?: string }>;
};

export type DocumentTopicSummary = {
  documentId: string;
  created: number;
  merged: number;
  droppedInvalid: number;
  droppedUngrounded: number;
  spansDone: string[];
  skippedSpans: string[];
  exhaustedLabels: string[];
  insufficient: boolean;
  done: boolean;
};

export type DocumentTopicProgress = {
  round: number;
  spansDone: string[];
  skippedSpans: string[];
  created: number;
  merged: number;
};

/**
 * Persists a pure merge result against the caller's working list.
 * The working list (not render-time props) is the diff base, so
 * multi-call runs never re-merge against stale state. Store
 * failures throw with their cause instead of vanishing.
 */
export async function persistMergedTopics(
  store: TopicPersistStore,
  before: Entry[],
  merged: TopicMergeResult,
): Promise<{ created: number; merged: number }> {
  let created = 0;
  let updated = 0;

  for (const entry of merged.entries) {
    const have = before.find((item) => item.id === entry.id);

    if (have === undefined) {
      const result = await store.addEntry("topics", entry);

      if (!result.ok) {
        throw new Error(result.error ?? "Thema konnte nicht gespeichert werden.");
      }

      created += 1;
    } else if (JSON.stringify(have) !== JSON.stringify(entry)) {
      const result = await store.updateEntry(entry.id, {
        title: entry.title,
        detail: entry.detail,
        parentId: entry.parentId ?? null,
        sourceRefs: entry.sourceRefs ?? [],
        topicData: entry.topicData,
      });

      if (!result.ok) {
        throw new Error(
          result.error ?? "Thema konnte nicht aktualisiert werden.",
        );
      }

      updated += 1;
    }
  }

  return { created, merged: updated };
}

/**
 * Runs the existing span extraction for one document to
 * completion: processing gate and chunk checks live inside the
 * extract call (server + local share them), merging reuses
 * topics.ts, and persistence threads a working list for
 * duplicate-safe retries. Re-running is idempotent: already
 * covered spans are skipped and re-proposed topics merge into
 * the existing ones instead of duplicating them.
 */
export async function runDocumentTopicExtraction(args: {
  documentId: string;
  subject: string;
  locale: AssistantLocale;
  /** Snapshot of all topics; the working list evolves from it. */
  topics: Entry[];
  makeId: () => string;
  call: TopicExtractCall;
  store: TopicPersistStore;
  onProgress?: (progress: DocumentTopicProgress) => void;
  signal?: AbortSignal;
  maxRounds?: number;
  /** Resume: span labels already covered by an earlier run. */
  initialCovered?: string[];
}): Promise<DocumentTopicSummary & { topics: Entry[] }> {
  const maxRounds =
    args.maxRounds !== undefined &&
    Number.isInteger(args.maxRounds) &&
    args.maxRounds > 0
      ? args.maxRounds
      : TOPIC_EXTRACT_MAX_ROUNDS;
  let working = args.topics.map((entry) => ({ ...entry }));
  let progress = emptyTopicProgress();

  if (args.initialCovered !== undefined) {
    progress = {
      ...progress,
      coveredLabels: [...new Set(args.initialCovered)],
    };
  }
  const summary: DocumentTopicSummary = {
    documentId: args.documentId,
    created: 0,
    merged: 0,
    droppedInvalid: 0,
    droppedUngrounded: 0,
    spansDone: [],
    skippedSpans: [],
    exhaustedLabels: [],
    insufficient: false,
    done: false,
  };

  for (let round = 0; round < maxRounds; round += 1) {
    if (args.signal?.aborted === true) throw new Error("Abgebrochen.");

    const response = await args.call(
      progress.coveredLabels,
      MAX_EXTRACT_SPANS,
    );

    summary.droppedInvalid += response.droppedInvalid;
    summary.droppedUngrounded += response.droppedUngrounded;

    if (response.insufficient) {
      summary.insufficient = true;
      summary.done = true;

      return { ...summary, topics: working };
    }

    if (response.topics.length > 0) {
      const merged = mergeExtractedTopics(
        working,
        response.topics.map((topic) => ({
          topic,
          documentId: args.documentId,
        })),
        args.subject,
        args.makeId,
      );
      const counts = await persistMergedTopics(args.store, working, merged);

      working = merged.entries;
      summary.created += counts.created;
      summary.merged += counts.merged;
    }

    const applied = applyExtractResponse(progress, response);

    progress = applied.progress;
    summary.spansDone = [...progress.coveredLabels];
    summary.skippedSpans = applied.retryableSkipped;
    summary.exhaustedLabels = [...progress.exhaustedLabels];
    args.onProgress?.({
      round: round + 1,
      spansDone: [...progress.coveredLabels],
      skippedSpans: [...applied.retryableSkipped],
      created: summary.created,
      merged: summary.merged,
    });

    if (response.done) {
      summary.done = true;
      summary.skippedSpans = [];

      return { ...summary, topics: working };
    }

    // More spans remain server-side: continue while a round either
    // covers new spans (finite plan) or has retryable skips left
    // (bounded attempts). Only a stalled round ends the run.
    if (!applied.madeProgress && applied.retryableSkipped.length === 0) {
      return { ...summary, topics: working };
    }
  }

  return { ...summary, topics: working };
}

/**
 * One-line German result for notices: created/merged plus honest
 * counts for everything dropped, skipped, or missing.
 */
export function formatTopicSummary(summary: DocumentTopicSummary): string {
  const parts = [`+${summary.created} neu`, `${summary.merged} ergänzt`];

  if (summary.droppedInvalid > 0) {
    parts.push(`${summary.droppedInvalid} ungültig verworfen`);
  }

  if (summary.droppedUngrounded > 0) {
    parts.push(`${summary.droppedUngrounded} ohne Beleg verworfen`);
  }

  if (summary.exhaustedLabels.length > 0) {
    parts.push(
      `${summary.exhaustedLabels.length} Abschnitt${summary.exhaustedLabels.length === 1 ? "" : "e"} fehlerhaft (${summary.exhaustedLabels.join(", ")})`,
    );
  } else if (summary.skippedSpans.length > 0) {
    parts.push(
      `${summary.skippedSpans.length} Abschnitt${summary.skippedSpans.length === 1 ? "" : "e"} übersprungen`,
    );
  }

  if (summary.insufficient) {
    return "Kein ausreichender Text für Themen gefunden.";
  }

  return parts.join(" · ");
}
