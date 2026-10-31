/**
 * Review-event access: cloud route when enabled, localStorage
 * ring buffer otherwise. Same event shape both ways; callers
 * never branch on the backend.
 */

import { CLOUD_ENABLED } from "./mode";
import { apiUnknown } from "./useRemoteResource";
import {
  MAX_REVIEW_EVENTS,
  REVIEW_EVENTS_STORAGE_KEY,
  isReviewEvent,
  isReviewEventList,
  pushReviewEvent,
  type ReviewEvent,
} from "@/src/lib/study/reviewEvents";

function readLocal(): ReviewEvent[] {
  if (typeof localStorage === "undefined") return [];

  try {
    const raw = localStorage.getItem(REVIEW_EVENTS_STORAGE_KEY);

    if (raw === null) return [];

    const parsed: unknown = JSON.parse(raw);

    return isReviewEventList(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocal(events: ReviewEvent[]): void {
  if (typeof localStorage === "undefined") return;

  try {
    localStorage.setItem(
      REVIEW_EVENTS_STORAGE_KEY,
      JSON.stringify(events.slice(0, MAX_REVIEW_EVENTS)),
    );
  } catch {
    // Storage full or unavailable: history stays in memory only.
  }
}

/** Own events, newest first (capped). */
export async function listReviewEvents(): Promise<ReviewEvent[]> {
  if (!CLOUD_ENABLED) return readLocal();

  const result = await apiUnknown("/api/quiz/reviews", "GET");

  if (!result.ok) {
    throw new Error(result.error);
  }

  if (!isReviewEventList(result.data)) {
    throw new Error("Unerwartete Serverantwort.");
  }

  return result.data;
}

export type LogReviewInput = {
  questionId: string;
  topicId: string | null;
  examId: string | null;
  kind: ReviewEvent["kind"];
  correct: boolean;
  rating: ReviewEvent["rating"];
};

/**
 * Appends one answered question. Cloud mode stamps links
 * server-side; local mode stores the caller-provided links.
 */
export async function logReviewEvent(
  input: LogReviewInput,
): Promise<ReviewEvent> {
  if (!CLOUD_ENABLED) {
    const event: ReviewEvent = {
      id:
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      ...input,
      createdAt: new Date().toISOString(),
    };

    writeLocal(pushReviewEvent(readLocal(), event));

    return event;
  }

  const result = await apiUnknown("/api/quiz/reviews", "POST", {
    questionId: input.questionId,
    correct: input.correct,
    rating: input.rating,
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  if (!isReviewEvent(result.data)) {
    throw new Error("Unerwartete Serverantwort.");
  }

  return result.data;
}
