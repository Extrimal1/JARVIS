/**
 * Calendar API guards: end-after-start is enforced server-side (the
 * UI and the assistant already enforce it client-side), and task
 * due-date clearing round-trips explicitly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calendarConfig } from "@/src/lib/api/modules/calendar";
import { checkFailed } from "@/src/lib/api/crud";
import type { CalendarEvent } from "@/src/lib/calendar";

function event(patch: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "e1",
    title: "Vorlesung",
    date: "2026-11-05",
    start: "09:00",
    end: "10:00",
    type: "lecture",
    description: "",
    location: "",
    ...patch,
  };
}

describe("calendar end-after-start", () => {
  const db = null as never;

  it("accepts valid ranges on create", async () => {
    const result = await calendarConfig.checkCreate(db, event());

    assert.ok(!checkFailed(result));
  });

  it("rejects reversed and zero-length ranges on create", async () => {
    assert.ok(
      checkFailed(
        await calendarConfig.checkCreate(
          db,
          event({ start: "10:00", end: "09:00" }),
        ),
      ),
    );
    assert.ok(
      checkFailed(
        await calendarConfig.checkCreate(
          db,
          event({ start: "10:00", end: "10:00" }),
        ),
      ),
    );
  });

  it("rejects patches that break the order", async () => {
    const existing = event();

    assert.ok(
      checkFailed(
        await calendarConfig.checkUpdate(db, { start: "11:00" }, existing),
      ),
    );
    assert.ok(
      checkFailed(
        await calendarConfig.checkUpdate(db, { end: "08:00" }, existing),
      ),
    );

    const moved = await calendarConfig.checkUpdate(
      db,
      { start: "10:00", end: "11:00" },
      existing,
    );

    assert.ok(!checkFailed(moved));
  });
});
