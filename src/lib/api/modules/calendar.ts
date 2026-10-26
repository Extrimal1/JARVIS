import {
  isCalendarEvent,
  isCalendarEventList,
} from "@/src/lib/calendar";
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
    date: row.date,
    start: row.start_time,
    end: row.end_time,
    type: row.type,
    description: row.description,
    location: row.location,
  };
}

export const calendarConfig: CrudConfig = {
  table: "calendar_events",
  order: "date.asc,start_time.asc",
  toDomain,
  isList: isCalendarEventList,
  checkCreate: (_db, body) => {
    if (!isCalendarEvent(body) || requireId(body) === null) {
      return { message: "Ungültiger Termin." };
    }

    return {
      row: {
        id: body.id,
        title: body.title,
        date: body.date,
        start_time: body.start,
        end_time: body.end,
        type: body.type,
        description: body.description,
        location: body.location,
      },
    };
  },
  checkUpdate: (_db, patch, existing): CheckResult => {
    const picked = pickPatch(patch, [
      "title",
      "date",
      "start",
      "end",
      "type",
      "description",
      "location",
    ]);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isCalendarEvent(merged)) {
      return { message: "Ungültige Änderung." };
    }

    return {
      row: {
        title: merged.title,
        date: merged.date,
        start_time: merged.start,
        end_time: merged.end,
        type: merged.type,
        description: merged.description,
        location: merged.location,
      },
    };
  },
};
