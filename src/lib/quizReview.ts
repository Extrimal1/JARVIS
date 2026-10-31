import { daysBetween } from "@/src/lib/briefing";
import { addDaysISO } from "@/src/lib/revision";
import type { QuizQuestion, QuizReviewStatus } from "@/src/lib/quiz";

/**
 * SM-2-inspired per-question schedule: expanding intervals
 * (1 → 3 → 7 → 14 → 30 days) indexed by the success streak,
 * adjusted by the self-reported difficulty rating. Simpler than
 * full SM-2 (no ease factor to store) but keeps its core idea:
 * easy recalls wait longer, hard recalls come back sooner, and
 * failures restart at one day.
 */
export const QUIZ_INTERVAL_LADDER = [1, 3, 7, 14, 30];

export type QuizRating = "again" | "hard" | "good" | "easy";

/** SM-2-style quality values stored as `difficulty`. */
export const QUIZ_RATING_QUALITY: Record<QuizRating, number> = {
  again: 1,
  hard: 2,
  good: 4,
  easy: 5,
};

export type QuizReviewPatch = Pick<
  QuizQuestion,
  | "lastReviewedAt"
  | "nextReviewAt"
  | "reviewCount"
  | "successCount"
  | "streak"
  | "difficulty"
  | "reviewStatus"
>;

function countOf(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : 0;
}

/**
 * Schedules the next review after one completed attempt.
 * Wrong answers (or an "again" rating) come back tomorrow;
 * the streak drives the ladder step and the review status.
 */
export function scheduleQuizReview(
  question: QuizQuestion,
  correct: boolean,
  rating: QuizRating,
  todayISO: string,
): QuizReviewPatch {
  const reviewCount = countOf(question.reviewCount) + 1;
  const successCount = countOf(question.successCount) + (correct ? 1 : 0);
  const streak = correct ? countOf(question.streak) + 1 : 0;

  let intervalDays: number;

  if (!correct || rating === "again") {
    intervalDays = 1;
  } else {
    const step = Math.min(
      Math.max(streak - 1, 0),
      QUIZ_INTERVAL_LADDER.length - 1,
    );
    const base = QUIZ_INTERVAL_LADDER[step] ?? 1;

    intervalDays =
      rating === "hard"
        ? Math.max(1, Math.round(base / 2))
        : rating === "easy"
          ? Math.round(base * 1.5)
          : base;
  }

  const reviewStatus: QuizReviewStatus =
    streak >= 4 ? "mastered" : streak >= 2 ? "review" : "learning";

  return {
    lastReviewedAt: todayISO,
    nextReviewAt: addDaysISO(todayISO, intervalDays) ?? todayISO,
    reviewCount,
    successCount,
    streak,
    difficulty: correct ? QUIZ_RATING_QUALITY[rating] : 1,
    reviewStatus,
  };
}

export type QuizReviewInfo = {
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  /** Due date as YYYY-MM-DD (today when never scheduled). */
  dueISO: string;
  daysLeft: number;
  status: "overdue" | "today" | "later";
  reviewStatus: QuizReviewStatus;
};

/** Due state of one question as of today (never-reviewed = due now). */
export function getQuizReviewInfo(
  question: QuizQuestion,
  todayISO: string,
): QuizReviewInfo {
  const lastReviewedAt = question.lastReviewedAt ?? null;
  const nextReviewAt = question.nextReviewAt ?? null;
  const dueISO = nextReviewAt ?? todayISO;
  const daysLeft = daysBetween(todayISO, dueISO) ?? 0;

  return {
    lastReviewedAt,
    nextReviewAt,
    dueISO,
    daysLeft,
    status: daysLeft < 0 ? "overdue" : daysLeft === 0 ? "today" : "later",
    reviewStatus: question.reviewStatus ?? "new",
  };
}
