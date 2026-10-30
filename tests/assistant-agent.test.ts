/**
 * Agent loop tests: envelope protocol, read/write tool execution,
 * bounds (steps, mistakes, duplicates), and confirm/pick surfacing.
 * Inference is a scripted stub; stores are in-memory fakes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CalendarEvent } from "@/src/lib/calendar";
import {
  EMPTY_FINANCE,
  type FinanceData,
  type Transaction,
} from "@/src/lib/finance";
import { EMPTY_STUDY } from "@/src/lib/study";
import type { LifestylePreferences } from "@/src/lib/lifestyle/types";
import {
  buildAgentSystemPrompt,
  createApiChat,
  runAgent,
  type AgentChat,
  type AgentData,
  type AgentMessage,
  type AgentOutcome,
} from "@/src/lib/assistant/agent";

const EVENT_A: CalendarEvent = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  title: "Treffen mit Max",
  date: "2026-10-30",
  start: "15:30",
  end: "16:30",
  type: "personal",
  description: "",
  location: "",
};

const EVENT_C: CalendarEvent = {
  id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  title: "Essen mit Max",
  date: "2026-10-30",
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

const PREFS: LifestylePreferences = {
  city: "",
  useGeolocation: false,
  latitude: null,
  longitude: null,
  radiusKm: 10,
  maxBudgetCents: null,
  categories: [],
  setting: "any",
  maxDurationMinutes: null,
  company: "any",
};

function makeData(overrides: Partial<AgentData> = {}): AgentData {
  return {
    events: [EVENT_A],
    finance: { ...EMPTY_FINANCE, transactions: [TX_FOOD] },
    tasks: [],
    study: EMPTY_STUDY,
    places: [],
    savedIds: [],
    plans: [],
    prefs: PREFS,
    memory: [],
    todayISO: "2026-10-30",
    nowTime: "12:00",
    ...overrides,
  };
}

type FakeStores = {
  events: CalendarEvent[];
  finance: FinanceData;
  calls: string[];
  calendar: {
    create: (event: CalendarEvent) => Promise<{ ok: true; data: CalendarEvent }>;
    update: (
      id: string,
      patch: Partial<CalendarEvent>,
    ) => Promise<{ ok: true; data: CalendarEvent } | { ok: false; error: string }>;
    remove: (id: string) => Promise<{ ok: true; data: null }>;
  };
  transactions: {
    saveTransaction: (
      tx: Transaction,
    ) => Promise<{ ok: true; data: Transaction }>;
    deleteTransaction: (id: string) => Promise<{ ok: true; data: null }>;
  };
};

function makeStores(): FakeStores {
  const events: CalendarEvent[] = [EVENT_A];
  const finance: FinanceData = { ...EMPTY_FINANCE, transactions: [TX_FOOD] };
  const calls: string[] = [];

  return {
    events,
    finance,
    calls,
    calendar: {
      create: async (event) => {
        calls.push(`create:${event.id}`);
        events.push(event);

        return { ok: true, data: event };
      },
      update: async (id, patch) => {
        calls.push(`update:${id}`);

        const index = events.findIndex((item) => item.id === id);

        if (index === -1) return { ok: false, error: "missing" };

        const merged = { ...events[index], ...patch, id };
        events[index] = merged;

        return { ok: true, data: merged };
      },
      remove: async (id) => {
        calls.push(`remove:${id}`);

        return { ok: true, data: null };
      },
    },
    transactions: {
      saveTransaction: async (tx) => {
        calls.push(`save:${tx.id}`);

        return { ok: true, data: tx };
      },
      deleteTransaction: async (id) => {
        calls.push(`delete:${id}`);

        return { ok: true, data: null };
      },
    },
  };
}

type ScriptedChat = AgentChat & { seen: AgentMessage[][] };

function scriptChat(responses: (string | Error)[]): ScriptedChat {
  const seen: AgentMessage[][] = [];
  let index = 0;

  const chat = (async (messages: AgentMessage[]): Promise<string> => {
    seen.push(messages);

    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;

    if (next instanceof Error) throw next;

    return next;
  }) as ScriptedChat;

  chat.seen = seen;

  return chat;
}

const final = (answer: string): string => JSON.stringify({ final: answer });

const tool = (id: string, args: Record<string, unknown> = {}): string =>
  JSON.stringify({ tool: id, args });

describe("runAgent", () => {
  it("returns direct finals without touching stores", async () => {
    const stores = makeStores();
    const chat = scriptChat([final("Hallo! Wie kann ich helfen?")]);

    const outcome = await runAgent("Hallo", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.answer, "Hallo! Wie kann ich helfen?");
    assert.deepEqual(outcome.steps, []);
    assert.equal(chat.seen.length, 1);
    assert.deepEqual(stores.calls, []);
  });

  it("runs a read tool and feeds the result back", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("calendar.today"),
      final("Du hast heute 1 Termin: Treffen mit Max."),
    ]);

    const outcome: AgentOutcome = await runAgent("Was habe ich heute?", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.match(outcome.answer, /Treffen mit Max/);
    assert.equal(outcome.steps.length, 1);
    assert.equal(outcome.steps[0]?.tool, "calendar.today");
    assert.equal(outcome.steps[0]?.ok, true);
    assert.deepEqual(stores.calls, []);

    const secondCall = chat.seen[1] ?? [];
    const toolMessage = secondCall.find(
      (message) => message.role === "tool",
    );

    assert.notEqual(toolMessage, undefined);
    assert.match(toolMessage?.content ?? "", /Treffen mit Max/);
  });

  it("threads model args into finance tools", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("finance.monthSummary", { monthKey: "2026-10" }),
      final("Im Oktober: 24,50 Euro Ausgaben."),
    ]);

    const outcome = await runAgent("Wie viel habe ich ausgegeben?", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.steps[0]?.tool, "finance.monthSummary");
    assert.equal(outcome.steps[0]?.ok, true);

    const toolMessage = (chat.seen[1] ?? []).find(
      (message) => message.role === "tool",
    );

    assert.match(toolMessage?.content ?? "", /2450/);
  });

  it("executes valid write proposals through the executor", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("calendar.create", {
        event: {
          title: "Zahnarzt",
          date: "2026-10-31",
          start: "09:00",
          end: "10:00",
          type: "personal",
          description: "",
          location: "Praxis",
        },
      }),
      final("Gespeichert: Zahnarzt morgen um 9 Uhr."),
    ]);

    const outcome = await runAgent("Zahnarzt morgen 9 Uhr", {
      chat,
      data: makeData({ events: [] }),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.steps[0]?.tool, "calendar.create");
    assert.equal(outcome.steps[0]?.ok, true);
    assert.equal(stores.calls.length, 1);
    assert.match(stores.calls[0] ?? "", /^create:/);
  });

  it("lists arbitrary ranges including past events", async () => {
    const stores = makeStores();
    const past: CalendarEvent = {
      ...EVENT_A,
      id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
      title: "Gestern",
      date: "2026-10-29",
    };
    const chat = scriptChat([
      tool("calendar.list", { from: "2026-10-29", to: "2026-10-30" }),
      final("Zwei Termine."),
    ]);

    const outcome = await runAgent("Was war los?", {
      chat,
      data: makeData({ events: [past, EVENT_A] }),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.steps[0]?.tool, "calendar.list");
    assert.equal(outcome.steps[0]?.ok, true);

    const toolMessage = (chat.seen[1] ?? []).find(
      (message) => message.role === "tool",
    );

    assert.match(toolMessage?.content ?? "", /Gestern/);
    assert.match(toolMessage?.content ?? "", /Treffen mit Max/);
  });

  it("lists recent finance entries and default-month summaries", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("finance.list", { limit: 5 }),
      tool("finance.summary", {}),
      final("Fertig."),
    ]);

    const outcome = await runAgent("Finanzen bitte", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.deepEqual(
      outcome.steps.map((step) => step.tool),
      ["finance.list", "finance.summary"],
    );
    assert.equal(
      outcome.steps.every((step) => step.ok),
      true,
    );
  });

  it("tolerates an optional thought field on envelopes", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      JSON.stringify({
        thought: "Frage braucht heutige Termine",
        tool: "calendar.today",
        args: {},
      }),
      JSON.stringify({ thought: "Fertig", final: "Du hast 1 Termin." }),
    ]);

    const outcome = await runAgent("Was habe ich heute?", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.answer, "Du hast 1 Termin.");
    assert.equal(outcome.steps.length, 1);
  });

  it("carries undo handles for executed writes", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("calendar.create", {
        event: {
          title: "Zahnarzt",
          date: "2026-10-31",
          start: "09:00",
          end: "10:00",
          type: "personal",
          description: "",
          location: "",
        },
      }),
      final("Gespeichert."),
    ]);

    const outcome = await runAgent("Zahnarzt morgen 9 Uhr", {
      chat,
      data: makeData({ events: [] }),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.undos.length, 1);
    assert.equal(outcome.undos[0]?.tool, "calendar.create");
    assert.equal(outcome.undos[0]?.undo.kind, "remove-event");
  });

  it("carries the plan behind disambiguations", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("calendar.delete", { ref: { titleQuery: "Max" } }),
    ]);

    const outcome = await runAgent("Lösche Max", {
      chat,
      data: makeData({ events: [EVENT_A, EVENT_C] }),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "pick");

    if (outcome.status !== "pick") return;

    assert.equal(outcome.plan.type, "calendar.delete");
  });

  it("repairs one invalid envelope, then answers", async () => {
    const stores = makeStores();
    const chat = scriptChat(["kein json {{{", final("Alles klar.")]);

    const outcome = await runAgent("Hallo", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");
    assert.equal(chat.seen.length, 2);

    const correction = (chat.seen[1] ?? []).find(
      (message) =>
        message.role === "user" && message.content.includes("GENAU einem"),
    );

    assert.notEqual(correction, undefined);
  });

  it("aborts honestly after two invalid envelopes", async () => {
    const stores = makeStores();
    const chat = scriptChat(["kein json", "immer noch keins"]);

    const outcome = await runAgent("Hallo", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "error");

    if (outcome.status !== "error") return;

    assert.match(outcome.message, /zweimal ungültig/);
    assert.deepEqual(stores.calls, []);
  });

  it("rejects unknown tools and aborts on repetition", async () => {
    const stores = makeStores();
    const chat = scriptChat([tool("sql.query"), tool("sql.query")]);

    const outcome = await runAgent("Lösche alles", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "error");
    assert.deepEqual(stores.calls, []);

    const feedback = (chat.seen[1] ?? []).find(
      (message) => message.role === "tool",
    );

    assert.match(feedback?.content ?? "", /nicht erlaubt/);
  });

  it("rejects invalid write plans without executing", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("calendar.create", { event: { title: "Halb" } }),
      final("Mir fehlt das Datum. Wann soll der Termin sein?"),
    ]);

    const outcome = await runAgent("Halber Termin", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");
    assert.deepEqual(stores.calls, []);
  });

  it("never executes a repeated write twice", async () => {
    const stores = makeStores();
    const create = tool("calendar.create", {
      event: {
        title: "Zahnarzt",
        date: "2026-10-31",
        start: "09:00",
        end: "10:00",
        type: "personal",
        description: "",
        location: "",
      },
    });
    const chat = scriptChat([create, create, final("Bereits gespeichert.")]);

    const outcome = await runAgent("Zahnarzt morgen 9 Uhr", {
      chat,
      data: makeData({ events: [] }),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");
    assert.equal(stores.calls.length, 1);
  });

  it("surfaces confirmations instead of confirming", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("calendar.delete", { ref: { titleQuery: "Treffen mit Max" } }),
    ]);

    const outcome = await runAgent("Lösche das Treffen mit Max", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "confirm");

    if (outcome.status !== "confirm") return;

    assert.match(outcome.summary, /Wirklich löschen/);
    assert.equal(outcome.pending.kind, "calendar.delete");
    assert.deepEqual(stores.calls, []);
  });

  it("surfaces disambiguation instead of guessing", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("calendar.delete", { ref: { titleQuery: "Max" } }),
    ]);

    const outcome = await runAgent("Lösche Max", {
      chat,
      data: makeData({ events: [EVENT_A, EVENT_C] }),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "pick");

    if (outcome.status !== "pick") return;

    assert.equal(outcome.options.length, 2);
    assert.deepEqual(stores.calls, []);
  });

  it("stops after maxSteps with an honest message", async () => {
    const stores = makeStores();
    const chat = scriptChat([tool("calendar.today")]);

    const outcome = await runAgent("Was habe ich heute?", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
      maxSteps: 1,
    });

    assert.equal(outcome.status, "error");

    if (outcome.status !== "error") return;

    assert.match(outcome.message, /Zu viele Schritte/);
  });

  it("surfaces transport failures honestly", async () => {
    const stores = makeStores();
    const chat = scriptChat([new Error("Das KI-Modell ist nicht erreichbar.")]);

    const outcome = await runAgent("Hallo", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "error");

    if (outcome.status !== "error") return;

    assert.match(outcome.message, /nicht erreichbar/);
  });

  it("honors cancellation between steps", async () => {
    const stores = makeStores();
    const chat = scriptChat([final("zu spät")]);
    const controller = new AbortController();
    controller.abort();

    const outcome = await runAgent("Hallo", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
      signal: controller.signal,
    });

    assert.equal(outcome.status, "error");

    if (outcome.status !== "error") return;

    assert.equal(outcome.message, "Abgebrochen.");
    assert.equal(chat.seen.length, 0);
  });

  it("challenges long finals that skipped tools", async () => {
    const stores = makeStores();
    const invented =
      "Heute hast du angeblich drei Termine, die ich mir alle ausgedacht habe, " +
      "ohne ein einziges Werkzeug aufzurufen, was streng verboten ist. Diese Antwort " +
      "ist absichtlich sehr lang formuliert, damit sie die konfigurierte Schwelle " +
      "von zweihundert Zeichen sicher überschreitet und die Prüfung auslöst.";
    const chat = scriptChat([
      final(invented),
      tool("calendar.today"),
      final("Du hast 1 Termin."),
    ]);

    const outcome = await runAgent("Was habe ich heute?", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.answer, "Du hast 1 Termin.");
    assert.equal(outcome.steps.length, 1);
    assert.equal(chat.seen.length, 3);

    const challenge = (chat.seen[1] ?? []).find(
      (message) =>
        message.role === "user" && message.content.includes("kein Werkzeug"),
    );

    assert.notEqual(challenge, undefined);
  });

  it("accepts a repeated bare final after one challenge", async () => {
    const stores = makeStores();
    const answer =
      "Eine lange Antwort ohne Werkzeugnutzung, die trotzdem akzeptiert wird, " +
      "weil die Herausforderung nur einmal pro Durchlauf stattfindet. Dieser Text " +
      "ist absichtlich sehr lang formuliert, damit er die Schwelle von zweihundert " +
      "Zeichen sicher überschreitet und beide Aufrufe challenged werden müssten.";
    const chat = scriptChat([final(answer), final(answer)]);

    const outcome = await runAgent("Erzähl was", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.answer, answer);
    assert.equal(chat.seen.length, 2);
  });

  it("skips the challenge when disabled or no tools are granted", async () => {
    const stores = makeStores();
    const answer =
      "Eine lange Antwort ohne Werkzeugnutzung, die sofort akzeptiert wird, " +
      "weil die Herausforderung deaktiviert oder sinnlos ist. Dieser Text ist " +
      "absichtlich sehr lang formuliert, damit er die Schwelle von zweihundert " +
      "Zeichen sicher überschreitet und ohne Schutz sofort durchginge.";
    const direct = scriptChat([final(answer)]);

    const disabled = await runAgent("Erzähl was", {
      chat: direct,
      data: makeData(),
      stores,
      locale: "de",
      challengeBareFinals: false,
    });

    assert.equal(disabled.status, "done");
    assert.equal(direct.seen.length, 1);

    const ungranted = scriptChat([final(answer)]);

    const outcome = await runAgent("Erzähl was", {
      chat: ungranted,
      data: makeData(),
      stores,
      locale: "de",
      granted: [],
    });

    assert.equal(outcome.status, "done");
    assert.equal(ungranted.seen.length, 1);
  });

  it("withholds ungranted write tools", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("finance.create", {
        transaction: {
          title: "Test",
          amountCents: 100,
          type: "expense",
          category: "Sonstiges",
          date: "2026-10-30",
          currency: "EUR",
          note: "",
        },
      }),
      final("Darf ich nicht."),
    ]);

    const outcome = await runAgent("Buche 1 Euro", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
      granted: ["read"],
    });

    assert.equal(outcome.status, "done");
    assert.deepEqual(stores.calls, []);
  });
});

describe("buildAgentSystemPrompt", () => {
  it("lists granted tools with date, time, and guardrails", () => {
    const prompt = buildAgentSystemPrompt({
      locale: "de",
      todayISO: "2026-10-30",
      nowTime: "12:00",
      granted: ["read", "write"],
    });

    assert.match(prompt, /2026-10-30/);
    assert.match(prompt, /12:00/);
    assert.match(prompt, /calendar\.today/);
    assert.match(prompt, /finance\.create/);
    assert.match(prompt, /kein SQL/);
    assert.match(prompt, /erfinde NIEMALS Werte/);
  });

  it("hides ungranted tools from the catalog", () => {
    const prompt = buildAgentSystemPrompt({
      locale: "de",
      todayISO: "2026-10-30",
      nowTime: "12:00",
      granted: ["read"],
    });

    assert.match(prompt, /calendar\.today/);
    assert.doesNotMatch(prompt, /calendar\.create/);
  });
});

describe("createApiChat", () => {
  it("posts history and returns content", async () => {
    const seen: { url: unknown; init?: RequestInit }[] = [];
    const fetcher = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url, init });

      return {
        status: 200,
        json: async () => ({ ok: true, data: { content: "Hallo" } }),
      };
    }) as unknown as typeof fetch;

    const chat = createApiChat(fetcher);
    const content = await chat([{ role: "user", content: "Hallo" }]);

    assert.equal(content, "Hallo");
    assert.equal(seen[0]?.url, "/api/llm/chat");

    const body = JSON.parse(seen[0]?.init?.body as string) as {
      messages: unknown[];
      options: Record<string, unknown>;
    };

    assert.equal(body.messages.length, 1);
    assert.equal(body.options.format, "json");
  });

  it("throws the server message on error envelopes", async () => {
    const fetcher = (async () => ({
      status: 502,
      json: async () => ({
        ok: false,
        error: { code: "upstream-error", message: "Modell weg." },
      }),
    })) as unknown as typeof fetch;

    await assert.rejects(
      createApiChat(fetcher)([{ role: "user", content: "Hi" }]),
      /Modell weg\./,
    );
  });

  it("aborts honestly on cancellation", async () => {
    const seen: { init?: RequestInit }[] = [];
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      seen.push({ init });

      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      createApiChat(fetcher, controller.signal)([
        { role: "user", content: "Hi" },
      ]),
      /Abgebrochen\./,
    );
    assert.equal(seen.length, 0);
  });

  it("maps 401 and network failures honestly", async () => {
    const unauthorized = (async () => ({
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await assert.rejects(
      createApiChat(unauthorized)([{ role: "user", content: "Hi" }]),
      /Sitzung abgelaufen/,
    );

    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await assert.rejects(
      createApiChat(broken)([{ role: "user", content: "Hi" }]),
      /Keine Verbindung/,
    );
  });
});
