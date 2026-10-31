/**
 * Review events: append-only answer history behind mastery.
 * One event per rated answer (correct + self-reported rating),
 * newest first, capped for storage. The mastery engine reads
 * this log recency-weighted; rows are never updated.
 */

import type { QuestionKind } from "@/src/lib/quiz";
import type { QuizRating } from "@/src/lib/quizReview";

export type ReviewEvent = {
  id: string;
  questionId: string;
  topicId: string | null;
  examId: string | null;
  kind: QuestionKind;
  correct: boolean;
  rating: QuizRating;
  /** ISO datetime of the rated answer. */
  createdAt: string;
};

export const REVIEW_EVENTS_STORAGE_KEY = "jarvis-review-events";

/** Ring-buffer cap (local + cloud list limit). */
export const MAX_REVIEW_EVENTS = 500;

/** Prepends one event, newest first, ring-buffer capped. */
export function pushReviewEvent(
  events: ReviewEvent[],
  event: ReviewEvent,
): ReviewEvent[] {
  return [event, ...events].slice(0, MAX_REVIEW_EVENTS);
}

const KINDS: readonly string[] = ["single", "multiple", "free"];
const RATINGS: readonly string[] = ["again", "hard", "good", "easy"];

export function isReviewEvent(value: unknown): value is ReviewEvent {
  if (typeof value !== "object" || value === null) return false;

  const event = value as Record<string, unknown>;

  return (
    typeof event.id === "string" &&
    event.id !== "" &&
    typeof event.questionId === "string" &&
    event.questionId !== "" &&
    (event.topicId === null || typeof event.topicId === "string") &&
    (event.examId === null || typeof event.examId === "string") &&
    typeof event.kind === "string" &&
    KINDS.includes(event.kind) &&
    typeof event.correct === "boolean" &&
    typeof event.rating === "string" &&
    RATINGS.includes(event.rating) &&
    typeof event.createdAt === "string" &&
    event.createdAt !== ""
  );
}

export function isReviewEventList(value: unknown): value is ReviewEvent[] {
  return Array.isArray(value) && value.every(isReviewEvent);
}
