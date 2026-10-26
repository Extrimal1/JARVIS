export type Task = {
  id: string;
  title: string;
  time: string;
  done: boolean;
  priority: "Niedrig" | "Mittel" | "Hoch";
};

export const TASKS_STORAGE_KEY = "jarvis-tasks";

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
      item.priority === "Hoch")
  );
}

export function isTaskList(value: unknown): value is Task[] {
  return Array.isArray(value) && value.every(isTask);
}
