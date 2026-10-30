/**
 * Read-tool tests for the engine gap-fillers (arbitrary ranges,
 * recent lists, default-month summaries) plus registry/params
 * consistency: every registered tool must be model-addressable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_PARAMS } from "@/src/lib/assistant/agent";
import { ASSISTANT_TOOLS } from "@/src/lib/assistant/registry";
import {
  getCalendarList,
  getFinanceList,
  getFinanceSummary,
} from "@/src/lib/assistant/tools";
import type { CalendarEvent } from "@/src/lib/calendar";
import {
  EMPTY_FINANCE,
  type Transaction,
} from "@/src/lib/finance";

const EVENTS: CalendarEvent[] = [
  {
    id: "a",
    title: "Alt",
    date: "2026-10-28",
    start: "09:00",
    end: "10:00",
    type: "personal",
    description: "",
    location: "",
  },
  {
    id: "b",
    title: "Heute",
    date: "2026-10-30",
    start: "15:30",
    end: "16:30",
    type: "personal",
    description: "",
    location: "",
  },
  {
    id: "c",
    title: "Später",
    date: "2026-11-02",
    start: "08:00",
    end: "09:00",
    type: "lecture",
    description: "",
    location: "",
  },
];

function tx(partial: Partial<Transaction> & { id: string }): Transaction {
  return {
    title: "Tx",
    amount: 100,
    type: "expense",
    category: "Sonstiges",
    date: "2026-10-20",
    currency: "EUR",
    importStatus: "manual",
    ...partial,
  };
}

describe("getCalendarList", () => {
  it("filters arbitrary ranges including the past, sorted", () => {
    const result = getCalendarList({
      events: EVENTS,
      todayISO: "2026-10-30",
      from: "2026-10-28",
      to: "2026-10-30",
    });

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.deepEqual(
      result.data.events.map((event) => event.id),
      ["a", "b"],
    );
  });

  it("defaults to today and rejects bad ranges", () => {
    const today = getCalendarList({ events: EVENTS, todayISO: "2026-10-30" });

    assert.equal(today.ok, true);

    if (!today.ok) return;

    assert.deepEqual(
      today.data.events.map((event) => event.id),
      ["b"],
    );

    assert.equal(
      getCalendarList({ events: EVENTS, todayISO: "2026-10-30", from: "morgen" })
        .ok,
      false,
    );
    assert.equal(
      getCalendarList({
        events: EVENTS,
        todayISO: "2026-10-30",
        from: "2026-10-31",
        to: "2026-10-30",
      }).ok,
      false,
    );
    assert.equal(
      getCalendarList({ events: EVENTS, todayISO: null }).ok,
      false,
    );
  });
});

describe("getFinanceList", () => {
  const finance = {
    ...EMPTY_FINANCE,
    transactions: [
      tx({ id: "1", date: "2026-10-01", title: "Alt" }),
      tx({ id: "2", date: "2026-10-25", title: "Neu", currency: "USD" }),
      tx({ id: "3", date: "2026-10-20", title: "Mitte" }),
    ],
  };

  it("returns newest first with limit and currency", () => {
    const result = getFinanceList({ finance, limit: 2 });

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.deepEqual(
      result.data.map((row) => row.id),
      ["2", "3"],
    );
    assert.equal(result.data[0]?.currency, "USD");
  });

  it("rejects unusable input", () => {
    assert.equal(getFinanceList({ finance: null }).ok, false);
  });
});

describe("getFinanceSummary", () => {
  const finance = {
    ...EMPTY_FINANCE,
    transactions: [tx({ id: "1", date: "2026-10-20", amount: 2450 })],
  };

  it("defaults to the current month and validates months", () => {
    const current = getFinanceSummary({ finance, todayISO: "2026-10-30" });

    assert.equal(current.ok, true);

    if (!current.ok) return;

    assert.equal(current.data.monthKey, "2026-10");
    assert.equal(current.data.expenseCents, 2450);

    assert.equal(
      getFinanceSummary({ finance, todayISO: "2026-10-30", monthKey: "Okt" })
        .ok,
      false,
    );
    assert.equal(
      getFinanceSummary({ finance, todayISO: null }).ok,
      false,
    );
  });
});

describe("registry consistency", () => {
  it("every registered tool is model-addressable", () => {
    for (const tool of ASSISTANT_TOOLS) {
      assert.equal(
        typeof MODEL_PARAMS[tool.id],
        "string",
        `missing MODEL_PARAMS for ${tool.id}`,
      );
    }
  });
});
