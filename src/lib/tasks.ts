import { parseISODateLocal } from "@/src/lib/calendar";

export type Task = {
  id: string;
  title: string;
  time: string;
  done: boolean;
  priority: "Niedrig" | "Mittel" | "Hoch";
  /**
   * Optional due date as local YYYY-MM-DD. Absent (or unparseable
   * legacy values are rejected, never guessed) means "no deadline":
   * such tasks behave exactly like before (time-of-day list items).
   */
  dueDate?: string;
};

export const TASKS_STORAGE_KEY = "jarvis-tasks";

/** Shared empty initial value (never mutated; the storage hook replaces it). */
export const NO_TASKS: Task[] = [];

export function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    typeof item.time === "string" &&
    typeof item.done === "boolean" &&
    (item.priority === "Niedrig" ||
      item.priority === "Mittel" ||
      item.priority === "Hoch") &&
    (item.dueDate === undefined ||
      (typeof item.dueDate === "string" &&
        parseISODateLocal(item.dueDate) !== null))
  );
}

export function isTaskList(value: unknown): value is Task[] {
  return Array.isArray(value) && value.every(isTask);
}

/**
 * True for open tasks whose due date is strictly before `todayISO`
 * (local YYYY-MM-DD string comparison — no timezone involved).
 * Done tasks and tasks without a due date are never overdue.
 */
export function isTaskOverdue(task: Task, todayISO: string): boolean {
  if (task.done) return false;
  if (task.dueDate === undefined) return false;

  return task.dueDate < todayISO;
}

/** Short local due label ("05.11."). Falls back to raw input if invalid. */
export function formatDueDate(dueDate: string): string {
  const parts = dueDate.split("-");

  if (parts.length !== 3) return dueDate;

  return `${parts[2]}.${parts[1]}.`;
}
