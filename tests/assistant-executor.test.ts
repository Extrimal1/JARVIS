/**
 * Executor tests: target resolution, verified writes, confirmation and
 * undo behavior, idempotent retries. Stores are in-memory fakes behind
 * the same interface the real hooks expose.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CalendarEvent } from "@/src/lib/calendar";
import type { RemoteResult } from "@/src/lib/db/useRemoteResource";
import {
  EMPTY_FINANCE,
  type FinanceData,
  type Transaction,
} from "@/src/lib/finance";
import {
  clearExecutionCache,
  executePending,
  executePlan,
  executeUndo,
  resolveEventReference,
  type ActionPlan,
  type ExecutorDeps,
  type PendingAction,
} from "@/src/lib/assistant/executor";

const EVENT_A: CalendarEvent = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  title: "Treffen mit Max",
  date: "2026-10-28",
  start: "15:30",
  end: "16:30",
  type: "personal",
  description: "",
  location: "",
};

const EVENT_B: CalendarEvent = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  title: "Zahnarzt",
  date: "2026-10-29",
  start: "09:00",
  end: "10:00",
  type: "personal",
  description: "",
  location: "Praxis",
};

const EVENT_C: CalendarEvent = {
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  title: "Essen mit Max",
  date: "2026-10-28",
  start: "19:00",
  end: "20:00",
  type: "personal",
  description: "",
  location: "",
};

const TX_FOOD: Transaction = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Lidl",
  amount: 2450,
  type: "expense",
  category: "Lebensmittel",
  date: "2026-10-20",
  currency: "EUR",
  importStatus: "manual",
};

const TX_PAY: Transaction = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "Gehalt",
  amount: 250000,
  type: "income",
  category: "Gehalt",
  date: "2026-10-01",
  currency: "EUR",
  importStatus: "manual",
};

type FakeCalendar = {
  events: CalendarEvent[];
  calls: string[];
};

type FakeFinance = {
  data: FinanceData;
  calls: string[];
};

function makeDeps(
  calendar: FakeCalendar,
  finance: FakeFinance,
  locale: "de" | "ru" = "de",
): ExecutorDeps {
  return {
    events: calendar.events,
    finance: finance.data,
    calendar: {
      create: async (event) => {
        calendar.calls.push(`create:${event.id}`);
        calendar.events.push(event);

        return { ok: true, data: event };
      },
      update: async (id, patch) => {
        calendar.calls.push(`update:${id}`);

        const index = calendar.events.findIndex((item) => item.id === id);

        if (index === -1) {
          return { ok: false, error: "Eintrag nicht gefunden." };
        }

        const merged = { ...calendar.events[index], ...patch, id };
        calendar.events[index] = merged;

        return { ok: true, data: merged };
      },
      remove: async (id) => {
        calendar.calls.push(`remove:${id}`);
        calendar.events = calendar.events.filter((item) => item.id !== id);

        return { ok: true, data: null };
      },
    },
    transactions: {
      saveTransaction: async (tx) => {
        finance.calls.push(`save:${tx.id}`);

        const index = finance.data.transactions.findIndex(
          (item) => item.id === tx.id,
        );

        if (index === -1) {
          finance.data.transactions.push(tx);
        } else {
          finance.data.transactions[index] = tx;
        }

        return { ok: true, data: tx };
      },
      deleteTransaction: async (id) => {
        finance.calls.push(`delete:${id}`);
        finance.data.transactions = finance.data.transactions.filter(
          (item) => item.id !== id,
        );

        return { ok: true, data: null };
      },
    },
    locale,
  };
}

function freshCalendar(...events: CalendarEvent[]): FakeCalendar {
  return { events: [...events], calls: [] };
}

function freshFinance(...txs: Transaction[]): FakeFinance {
  return {
    data: { ...EMPTY_FINANCE, transactions: [...txs] },
    calls: [],
  };
}

let keyCounter = 0;

function freshKey(): string {
  keyCounter += 1;

  return `00000000-0000-0000-0000-${String(keyCounter).padStart(12, "0")}`;
}

beforeEach(() => {
  clearExecutionCache();
});

describe("resolveEventReference", () => {
  const events = [EVENT_A, EVENT_B, EVENT_C];

  it("matches full phrases", () => {
    const matches = resolveEventReference(
      { titleQuery: "Treffen mit Max" },
      events,
    );

    assert.deepEqual(
      matches.map((event) => event.id),
      [EVENT_A.id],
    );
  });

  it("matches across prepositions (beim Zahnarzt → Zahnarzt)", () => {
    const matches = resolveEventReference(
      { titleQuery: "beim Zahnarzt" },
      events,
    );

    assert.deepEqual(
      matches.map((event) => event.id),
      [EVENT_B.id],
    );
  });

  it("returns every candidate on ambiguity, chronologically", () => {
    const matches = resolveEventReference({ titleQuery: "mit Max" }, events);

    assert.deepEqual(
      matches.map((event) => event.id),
      [EVENT_A.id, EVENT_C.id],
    );
  });

  it("honors date restrictions", () => {
    const matches = resolveEventReference(
      { titleQuery: "mit Max", date: "2026-10-28" },
      events,
    );

    assert.equal(matches.length, 2);

    const none = resolveEventReference(
      { titleQuery: "mit Max", date: "2026-10-29" },
      events,
    );

    assert.equal(none.length, 0);
  });
});

describe("calendar.create execution", () => {
  const plan: ActionPlan = {
    type: "calendar.create",
    event: {
      title: "Treffen mit Max",
      date: "2026-10-28",
      start: "15:30",
      end: "16:30",
      type: "personal",
      description: "",
      location: "",
    },
  };

  it("creates with the idempotency key as id and confirms the record", async () => {
    const calendar = freshCalendar();
    const deps = makeDeps(calendar, freshFinance());
    const key = freshKey();
    const report = await executePlan(plan, key, deps);

    assert.equal(report.status, "done");

    if (report.status !== "done") return;

    assert.deepEqual(calendar.calls, [`create:${key}`]);
    assert.match(report.message, /Treffen mit Max/);
    assert.match(report.message, /15:30–16:30/);
    assert.equal(report.href, "/calendar");
    assert.deepEqual(report.undo, { kind: "remove-event", id: key });
  });

  it("executes exactly once per key (double-submit safe)", async () => {
    const calendar = freshCalendar();
    const deps = makeDeps(calendar, freshFinance());
    const key = freshKey();

    const [first, second] = await Promise.all([
      executePlan(plan, key, deps),
      executePlan(plan, key, deps),
    ]);

    assert.deepEqual(calendar.calls, [`create:${key}`]);
    assert.deepEqual(first, second);
  });

  it("warns about conflicts without blocking", async () => {
    const calendar = freshCalendar(EVENT_A);
    const deps = makeDeps(calendar, freshFinance());

    const report = await executePlan(
      {
        type: "calendar.create",
        event: {
          title: "Anruf",
          date: "2026-10-28",
          start: "16:00",
          end: "16:30",
          type: "personal",
          description: "",
          location: "",
        },
      },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "done");

    if (report.status !== "done") return;

    assert.match(report.message, /Überschneidung mit „Treffen mit Max“/);
  });

  it("reports store failures honestly", async () => {
    const calendar = freshCalendar();
    const deps = makeDeps(calendar, freshFinance());
    deps.calendar.create = async () => ({
      ok: false,
      error: "Keine Verbindung.",
    });

    const report = await executePlan(plan, freshKey(), deps);

    assert.equal(report.status, "error");

    if (report.status !== "error") return;

    assert.match(report.message, /Speichern fehlgeschlagen/);
  });
});

describe("calendar.list execution", () => {
  it("lists matches and links to the calendar", async () => {
    const deps = makeDeps(freshCalendar(EVENT_A, EVENT_B), freshFinance());
    const report = await executePlan(
      {
        type: "calendar.list",
        from: "2026-10-28",
        to: "2026-10-29",
        label: "28.–29.10.",
      },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "done");

    if (report.status !== "done") return;

    assert.match(report.message, /Treffen mit Max/);
    assert.match(report.message, /Zahnarzt/);
    assert.equal(report.href, "/calendar");
  });

  it("says so when nothing matches", async () => {
    const deps = makeDeps(freshCalendar(), freshFinance());
    const report = await executePlan(
      {
        type: "calendar.list",
        from: "2026-10-28",
        to: "2026-10-28",
        label: "morgen",
      },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "done");

    if (report.status !== "done") return;

    assert.match(report.message, /Keine Termine/);
  });
});

describe("calendar.update / delete confirmation flow", () => {
  it("asks for confirmation on a single delete match", async () => {
    const deps = makeDeps(freshCalendar(EVENT_A), freshFinance());
    const report = await executePlan(
      { type: "calendar.delete", ref: { titleQuery: "mit Max" } },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "confirm");

    if (report.status !== "confirm") return;

    assert.match(report.summary, /Wirklich löschen/);
    assert.equal(report.pending.kind, "calendar.delete");
  });

  it("asks which one on ambiguity (max four options)", async () => {
    const deps = makeDeps(freshCalendar(EVENT_A, EVENT_C), freshFinance());
    const report = await executePlan(
      { type: "calendar.delete", ref: { titleQuery: "mit Max" } },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "pick");

    if (report.status !== "pick") return;

    assert.equal(report.options.length, 2);
    assert.deepEqual(
      report.options.map((option) => option.eventId),
      [EVENT_A.id, EVENT_C.id],
    );
  });

  it("errors when nothing matches", async () => {
    const deps = makeDeps(freshCalendar(EVENT_A), freshFinance());
    const report = await executePlan(
      { type: "calendar.delete", ref: { titleQuery: "Unbekannt" } },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "error");
  });

  it("applies confirmed updates and offers undo of the snapshot", async () => {
    const calendar = freshCalendar(EVENT_A);
    const deps = makeDeps(calendar, freshFinance());
    const pending: PendingAction = {
      kind: "calendar.update",
      id: EVENT_A.id,
      patch: { start: "16:00", end: "17:00" },
      previous: EVENT_A,
      summary: "summary",
    };

    const report = await executePending(pending, freshKey(), deps);

    assert.equal(report.status, "done");

    if (report.status !== "done") return;

    assert.match(report.message, /16:00–17:00/);
    assert.deepEqual(report.undo, {
      kind: "restore-event-patch",
      id: EVENT_A.id,
      previous: EVENT_A,
    });

    const undone = await executeUndo(report.undo!, deps);

    assert.equal(undone.ok, true);
    assert.equal(calendar.events[0].start, "15:30");
  });

  it("restores deleted events on undo", async () => {
    const calendar = freshCalendar(EVENT_A);
    const deps = makeDeps(calendar, freshFinance());
    const pending: PendingAction = {
      kind: "calendar.delete",
      event: EVENT_A,
      summary: "summary",
    };

    const report = await executePending(pending, freshKey(), deps);

    assert.equal(report.status, "done");
    assert.equal(calendar.events.length, 0);

    if (report.status !== "done" || report.undo === undefined) return;

    const undone = await executeUndo(report.undo, deps);

    assert.equal(undone.ok, true);
    assert.equal(calendar.events.length, 1);
    assert.equal(calendar.events[0].id, EVENT_A.id);
  });
});

describe("finance.create execution", () => {
  it("saves expenses and confirms the persisted record", async () => {
    const finance = freshFinance();
    const deps = makeDeps(freshCalendar(), finance);
    const key = freshKey();

    const report = await executePlan(
      {
        type: "finance.create",
        transaction: {
          title: "Lidl",
          amountCents: 2450,
          type: "expense",
          category: "Lebensmittel",
          date: "2026-10-27",
          currency: "EUR",
          note: "",
        },
      },
      key,
      deps,
    );

    assert.equal(report.status, "done");

    if (report.status !== "done") return;

    assert.deepEqual(finance.calls, [`save:${key}`]);
    // NBSP-tolerant: Intl separates "24,50" and "€" with U+00A0.
    assert.equal(
      report.message.replace(/\s/g, " "),
      "Ausgabe gespeichert: 24,50 € bei Lidl · Lebensmittel.",
    );
    assert.equal(report.href, "/finance");
    assert.deepEqual(report.undo, { kind: "remove-transaction", id: key });

    const undone = await executeUndo(report.undo!, deps);

    assert.equal(undone.ok, true);
    assert.equal(finance.data.transactions.length, 0);
  });

  it("coerces unknown categories to Sonstiges", async () => {
    const finance = freshFinance();
    const deps = makeDeps(freshCalendar(), finance);

    const report = await executePlan(
      {
        type: "finance.create",
        transaction: {
          title: "Shop",
          amountCents: 100,
          type: "expense",
          category: "Erfunden",
          date: "2026-10-27",
          currency: "EUR",
          note: "",
        },
      },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "done");
    assert.equal(finance.data.transactions[0].category, "Sonstiges");
  });
});

describe("finance.list / finance.summary execution", () => {
  it("lists newest first", async () => {
    const deps = makeDeps(
      freshCalendar(),
      freshFinance(TX_FOOD, TX_PAY),
    );

    const report = await executePlan(
      { type: "finance.list", limit: 10 },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "done");

    if (report.status !== "done") return;

    const foodAt = report.message.indexOf("Lidl");
    const payAt = report.message.indexOf("Gehalt");

    assert.ok(foodAt !== -1 && payAt !== -1 && foodAt < payAt);
  });

  it("summarizes a month with budget usage", async () => {
    const finance = freshFinance(TX_FOOD, TX_PAY);
    finance.data.monthlyBudgetCents = 50000;
    const deps = makeDeps(freshCalendar(), finance);

    const report = await executePlan(
      {
        type: "finance.summary",
        monthKey: "2026-10",
        from: null,
        to: null,
        category: null,
        label: "dieser Monat",
      },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "done");

    if (report.status !== "done") return;

    assert.match(report.message, /Ausgaben 24,50/);
    assert.match(report.message, /Einnahmen 2\.500,00/);
    assert.match(report.message, /2 Buchungen/);
    assert.match(report.message, /Budget zu 5 %/);
  });

  it("counts foreign currencies separately instead of converting", async () => {
    const finance = freshFinance(TX_FOOD, {
      ...TX_FOOD,
      id: "33333333-3333-3333-3333-333333333333",
      amount: 50000,
      currency: "RUB",
    });
    const deps = makeDeps(freshCalendar(), finance);

    const report = await executePlan(
      {
        type: "finance.summary",
        monthKey: "2026-10",
        from: null,
        to: null,
        category: null,
        label: "dieser Monat",
      },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "done");

    if (report.status !== "done") return;

    assert.match(report.message, /Ausgaben 24,50/);
    assert.match(report.message, /1 Fremdwährungsbuchungen/);
  });
});

describe("localized confirmations", () => {
  it("confirms in Russian when asked", async () => {
    const deps = makeDeps(freshCalendar(), freshFinance(), "ru");

    const report = await executePlan(
      {
        type: "calendar.create",
        event: {
          title: "Встреча с Максом",
          date: "2026-10-28",
          start: "15:30",
          end: "16:30",
          type: "personal",
          description: "",
          location: "",
        },
      },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "done");

    if (report.status !== "done") return;

    assert.match(report.message, /Сохранено/);
    assert.equal(report.undoLabel, "Отменить");
  });
});

describe("failure propagation", () => {
  it("never claims success before the store confirms", async () => {
    const deps = makeDeps(freshCalendar(), freshFinance());
    deps.transactions.saveTransaction = (async () => ({
      ok: false,
      error: "Abgelehnt.",
    })) as (tx: Transaction) => Promise<RemoteResult<Transaction>>;

    const report = await executePlan(
      {
        type: "finance.create",
        transaction: {
          title: "Lidl",
          amountCents: 100,
          type: "expense",
          category: "Lebensmittel",
          date: "2026-10-27",
          currency: "EUR",
          note: "",
        },
      },
      freshKey(),
      deps,
    );

    assert.equal(report.status, "error");

    if (report.status !== "error") return;

    assert.match(report.message, /Abgelehnt/);
    assert.doesNotMatch(report.message, /gespeichert/);
  });
});
