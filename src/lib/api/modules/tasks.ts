import { isTask, isTaskList, type Task } from "@/src/lib/tasks";
import {
  pickPatch,
  requireId,
  type CheckResult,
  type CrudConfig,
} from "../crud";

function toDomain(row: Record<string, unknown>): unknown {
  const item: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    time: row.time,
    done: row.done,
    priority: row.priority,
  };

  // `due_date` is optional and additive (migration 0015): rows from
  // databases without the column simply carry no due date.
  if (typeof row.due_date === "string" && row.due_date !== "") {
    item.dueDate = row.due_date;
  }

  return item;
}

/** Only send `due_date` when set, so pre-0015 databases keep working. */
function dueDateColumn(item: Task): Record<string, unknown> {
  return item.dueDate === undefined ? {} : { due_date: item.dueDate };
}

export const tasksConfig: CrudConfig = {
  table: "tasks",
  order: "created_at.asc",
  toDomain,
  isList: isTaskList,
  checkCreate: (_db, body) => {
    if (!isTask(body) || requireId(body) === null) {
      return { message: "Ungültige Aufgabe." };
    }

    return {
      row: {
        id: body.id,
        title: body.title,
        time: body.time,
        done: body.done,
        priority: body.priority,
        ...dueDateColumn(body),
      },
    };
  },
  checkUpdate: (_db, patch, existing): CheckResult => {
    const picked = pickPatch(patch, [
      "title",
      "time",
      "done",
      "priority",
      "dueDate",
    ]);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    // Explicit null clears the due date; an absent key leaves it
    // untouched. Track the clear separately: after merging, both
    // look like `undefined` on the domain object.
    const clearsDueDate = picked.dueDate === null;

    if (clearsDueDate) {
      delete picked.dueDate;
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (clearsDueDate) {
      delete merged.dueDate;
    }

    if (!isTask(merged)) {
      return { message: "Ungültige Änderung." };
    }

    const item = merged as unknown as Task;

    return {
      row: {
        title: item.title,
        time: item.time,
        done: item.done,
        priority: item.priority,
        ...(clearsDueDate
          ? { due_date: null }
          : picked.dueDate === undefined
            ? dueDateColumn(item)
            : { due_date: item.dueDate ?? null }),
      },
    };
  },
};
