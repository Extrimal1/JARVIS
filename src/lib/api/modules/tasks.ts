import { isTask, isTaskList } from "@/src/lib/tasks";
import {
  pickPatch,
  requireId,
  type CheckResult,
  type CrudConfig,
} from "../crud";

function toDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    title: row.title,
    time: row.time,
    done: row.done,
    priority: row.priority,
  };
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
      },
    };
  },
  checkUpdate: (_db, patch, existing): CheckResult => {
    const picked = pickPatch(patch, ["title", "time", "done", "priority"]);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isTask(merged)) {
      return { message: "Ungültige Änderung." };
    }

    return {
      row: {
        title: merged.title,
        time: merged.time,
        done: merged.done,
        priority: merged.priority,
      },
    };
  },
};
