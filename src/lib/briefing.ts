import { parseISODateLocal } from "@/src/lib/calendar";
import type { Entry } from "@/src/lib/study";
import type { StudyData } from "@/src/lib/study";
import type { Task } from "@/src/lib/tasks";

export type Deadline = {
  id: string;
  title: string;
  subject: string | null;
  /** Local date as YYYY-MM-DD (always valid). */
  date: string;
  /** Whole days from today; negative means overdue. */
  daysLeft: number;
  kind: "exam" | "topic";
};

/**
 * Whole days from `fromISO` to `toISO`, compared as local calendar dates
 * (UTC-midnight difference, immune to DST and time zones).
 * Returns null when either value is not a valid YYYY-MM-DD date.
 */
export function daysBetween(fromISO: string, toISO: string): number | null {
  const from = parseISODateLocal(fromISO);
  const to = parseISODateLocal(toISO);

  if (from === null || to === null) return null;

  const utcFrom = Date.UTC(
    from.getFullYear(),
    from.getMonth(),
    from.getDate(),
  );
  const utcTo = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());

  return Math.round((utcTo - utcFrom) / 86_400_000);
}

const DAY_SHORT_FORMAT = new Intl.DateTimeFormat("de-DE", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** Short local date label ("26. Okt."). Falls back to raw input if invalid. */
export function formatDayShort(dateISO: string): string {
  if (parseISODateLocal(dateISO) === null) return dateISO;

  return DAY_SHORT_FORMAT.format(new Date(`${dateISO}T12:00:00Z`));
}

export function formatDaysLeft(daysLeft: number): string {
  if (daysLeft === 0) return "Heute";
  if (daysLeft === 1) return "Morgen";
  if (daysLeft > 1) return `In ${daysLeft} Tagen`;
  if (daysLeft === -1) return "Seit gestern überfällig";

  return `Seit ${-daysLeft} Tagen überfällig`;
}

/**
 * Exams and open learning topics with a valid date, sorted ascending
 * (most overdue first). Records without a date — or with an invalid
 * one — are skipped defensively.
 */
export function collectDeadlines(
  study: StudyData,
  todayISO: string,
): Deadline[] {
  const deadlines: Deadline[] = [];

  function push(kind: Deadline["kind"], entry: Entry) {
    if (entry.date === undefined) return;
    if (kind === "topic" && entry.done === true) return;

    const daysLeft = daysBetween(todayISO, entry.date);
    if (daysLeft === null) return;

    deadlines.push({
      id: `${kind}-${entry.id}`,
      title: entry.title,
      subject: entry.subject ?? null,
      date: entry.date,
      daysLeft,
      kind,
    });
  }

  for (const exam of study.exams) {
    push("exam", exam);
  }

  for (const topic of study.topics) {
    push("topic", topic);
  }

  deadlines.sort((a, b) => a.date.localeCompare(b.date));

  return deadlines;
}

const PRIORITY_RANK = { Hoch: 0, Mittel: 1, Niedrig: 2 } as const;

/** Incomplete tasks, highest priority first (stable for equal priority). */
export function openTasks(tasks: Task[]): Task[] {
  return tasks
    .filter((task) => !task.done)
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}
