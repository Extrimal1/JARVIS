import { daysBetween } from "@/src/lib/briefing";
import { parseISODateLocal, toISODateLocal } from "@/src/lib/calendar";
import type { Entry } from "@/src/lib/study";

/**
 * Fixed revision intervals in days: after the 1st review wait 1 day,
 * then 3, then 7, then 14 (stays at 14 for further reviews).
 * A simple transparent schedule — not AI-powered, not adaptive.
 */
export const REVISION_INTERVALS = [1, 3, 7, 14];

export type RevisionStatus = "overdue" | "today" | "later";

export type ReviewInfo = {
  /** Number of completed reviews (0 when never reviewed). */
  stage: number;
  lastReviewedAt: string | null;
  /** Days until the next review after marking it reviewed now. */
  intervalDays: number;
  /** Next due date as YYYY-MM-DD (today when never reviewed). */
  dueISO: string;
  daysLeft: number;
  status: RevisionStatus;
};

function validStage(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : 0;
}

export function addDaysISO(dateISO: string, days: number): string | null {
  const date = parseISODateLocal(dateISO);
  if (date === null) return null;

  date.setDate(date.getDate() + days);

  return toISODateLocal(date);
}

export function getReviewInfo(topic: Entry, todayISO: string): ReviewInfo {
  const stage = validStage(topic.reviewStage);
  const last =
    typeof topic.lastReviewedAt === "string"
      ? parseISODateLocal(topic.lastReviewedAt)
      : null;
  const lastISO = last === null ? null : toISODateLocal(last);
  // Next wait after reviewing now. The current due date of an already
  // reviewed topic used the previous step of the sequence instead, so
  // the realized waits are exactly 1, 3, 7, 14, 14, … days.
  const intervalDays =
    REVISION_INTERVALS[Math.min(stage, REVISION_INTERVALS.length - 1)];
  const pastWait =
    REVISION_INTERVALS[
      Math.min(Math.max(stage - 1, 0), REVISION_INTERVALS.length - 1)
    ];
  const dueISO =
    lastISO === null
      ? todayISO
      : (addDaysISO(lastISO, pastWait) ?? todayISO);
  const daysLeft = daysBetween(todayISO, dueISO) ?? 0;

  return {
    stage,
    lastReviewedAt: lastISO,
    intervalDays,
    dueISO,
    daysLeft,
    status: daysLeft < 0 ? "overdue" : daysLeft === 0 ? "today" : "later",
  };
}

/** Returns a copy of the topic with one more completed review as of today. */
export function markReviewed(topic: Entry, todayISO: string): Entry {
  return {
    ...topic,
    reviewStage: validStage(topic.reviewStage) + 1,
    lastReviewedAt: todayISO,
  };
}
