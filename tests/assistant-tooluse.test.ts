/**
 * Tool-use + error-visibility regression tests (ISSUE 4 + ISSUE 5):
 * registry arg validation, requiresKeys, mistake semantics, safe
 * truncation, the place-search follow-up, error causes, the briefing
 * tool, new NLU intents, heuristic summaries, and write-plan safety.
 * Scripted chats and in-memory fakes; no network, no mocks of app code.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CalendarEvent } from "@/src/lib/calendar";
import { EMPTY_FINANCE, type Transaction } from "@/src/lib/finance";
import { EMPTY_STUDY, type StudyData } from "@/src/lib/study";
import type { Task } from "@/src/lib/tasks";
import type { MemoryEntry } from "@/src/lib/memory";
import type { LifestylePreferences } from "@/src/lib/lifestyle/types";
import {
  buildAgentSystemPrompt,
  classifyServerError,
  createApiChat,
  looksLikePlaceQuery,
  missingRequiresKey,
  runAgent,
  truncateJsonSafe,
  validateToolArgs,
  MODEL_PARAMS,
  type AgentChat,
  type AgentData,
  type AgentMessage,
} from "@/src/lib/assistant/agent";
import { ASSISTANT_TOOLS } from "@/src/lib/assistant/registry";
import { getBriefingToday } from "@/src/lib/assistant/tools";
import { isAssistantPlan, type NluContext } from "@/src/lib/assistant/actions";
import { parseCommand } from "@/src/lib/assistant/nlu";
import { createHeuristicChat } from "@/src/lib/assistant/heuristicChat";
import { transcriptToTurns, turnHref } from "@/src/lib/assistant/transcript";
import {
  createMessage,
  type ConversationMessage,
} from "@/src/lib/conversation";

// ---------------------------------------------------------------- fixtures

const EVENT_TODAY: CalendarEvent = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  title: "Treffen mit Max",
  date: "2026-10-30",
  start: "15:30",
  end: "16:30",
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

const TASK_OPEN: Task = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "Milch kaufen",
  time: "18:00",
  priority: "Hoch",
  done: false,
};

const STUDY: StudyData = {
  ...EMPTY_STUDY,
  exams: [
    {
      id: "33333333-3333-3333-3333-333333333333",
      title: "Mathe-Klausur",
      detail: "",
      date: "2026-11-02",
      subject: "Mathe",
    },
  ],
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
    events: [EVENT_TODAY],
    finance: { ...EMPTY_FINANCE, transactions: [TX_FOOD] },
    tasks: [TASK_OPEN],
    study: STUDY,
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

function makeStores() {
  const events: CalendarEvent[] = [EVENT_TODAY];
  const savedTasks: Task[] = [];
  const savedMemories: MemoryEntry[] = [];
  const calls: string[] = [];

  return {
    calls,
    savedTasks,
    savedMemories,
    calendar: {
      create: async (event: CalendarEvent) => {
        calls.push(`create:${event.title}`);
        events.push(event);

        return { ok: true as const, data: event };
      },
      update: async (id: string, patch: Partial<CalendarEvent>) => {
        calls.push(`update:${id}`);

        const index = events.findIndex((item) => item.id === id);

        if (index === -1) return { ok: false as const, error: "missing" };

        const merged = { ...events[index], ...patch, id };
        events[index] = merged;

        return { ok: true as const, data: merged };
      },
      remove: async (id: string) => {
        calls.push(`remove:${id}`);

        return { ok: true as const, data: null };
      },
    },
    transactions: {
      saveTransaction: async (tx: Transaction) => {
        calls.push(`save:${tx.id}`);

        return { ok: true as const, data: tx };
      },
      deleteTransaction: async (id: string) => {
        calls.push(`delete:${id}`);

        return { ok: true as const, data: null };
      },
    },
    memories: {
      saveMemory: async (entry: MemoryEntry) => {
        calls.push(`memory:${entry.title}`);
        savedMemories.push(entry);

        return { ok: true as const, data: entry };
      },
      deleteMemory: async (id: string) => {
        calls.push(`memory-delete:${id}`);

        return { ok: true as const, data: null };
      },
    },
    tasks: {
      saveTask: async (task: Task) => {
        calls.push(`task:${task.title}`);
        savedTasks.push(task);

        return { ok: true as const, data: task };
      },
      deleteTask: async (id: string) => {
        calls.push(`task-delete:${id}`);

        return { ok: true as const, data: null };
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

const CTX: NluContext = {
  todayISO: "2026-10-27",
  nowTime: "10:00",
  timezone: "Europe/Berlin",
  locale: "de",
};

// ------------------------------------------------------- arg validation

describe("validateToolArgs", () => {
  it("rejects out-of-range ints and wrong types by field name", () => {
    assert.match(
      validateToolArgs("calendar.upcoming", { days: 99 }) ?? "",
      /days/,
    );
    assert.match(
      validateToolArgs("calendar.upcoming", { days: "7" }) ?? "",
      /days/,
    );
    assert.equal(validateToolArgs("calendar.upcoming", { days: 7 }), null);
    assert.equal(validateToolArgs("calendar.upcoming", {}), null);
    assert.match(
      validateToolArgs("finance.list", { limit: 0 }) ?? "",
      /limit/,
    );
  });

  it("requires monthKey as YYYY-MM for month tools", () => {
    assert.match(
      validateToolArgs("finance.monthSummary", {}) ?? "",
      /monthKey/,
    );
    assert.match(
      validateToolArgs("finance.monthSummary", { monthKey: "2026-13" }) ?? "",
      /monthKey/,
    );
    assert.equal(
      validateToolArgs("finance.monthSummary", { monthKey: "2026-10" }),
      null,
    );
    assert.match(
      validateToolArgs("finance.largest", {
        monthKey: "2026-10",
        limit: 99,
      }) ?? "",
      /limit/,
    );
  });

  it("accepts explicit null for optional fields (heuristic compat)", () => {
    assert.equal(
      validateToolArgs("finance.summary", { monthKey: null }),
      null,
    );
    assert.equal(
      validateToolArgs("calendar.upcoming", { days: null }),
      null,
    );
  });

  it("rejects bad calendar ranges with real-day checks", () => {
    assert.match(
      validateToolArgs("calendar.list", {
        from: "2026-10-30",
        to: "2026-10-20",
      }) ?? "",
      /to/,
    );
    assert.match(
      validateToolArgs("calendar.list", { from: "2026-02-30" }) ?? "",
      /from/,
    );
    assert.equal(
      validateToolArgs("calendar.list", {
        from: "2026-10-20",
        to: "2026-10-30",
      }),
      null,
    );
  });

  it("ignores unknown keys but enforces known place-search fields", () => {
    assert.equal(
      validateToolArgs("finance.summary", {
        monthKey: "2026-10",
        label: "Oktober",
        from: null,
        to: null,
        category: null,
      }),
      null,
    );
    assert.match(
      validateToolArgs("lifestyle.placesSearch", { category: "bars" }) ?? "",
      /category/,
    );
    assert.match(
      validateToolArgs("lifestyle.placesSearch", { limit: 99 }) ?? "",
      /limit/,
    );
    assert.equal(
      validateToolArgs("lifestyle.placesSearch", {
        query: "Café",
        near: "Berlin",
        category: "food",
        limit: 5,
      }),
      null,
    );
  });

  it("requires a non-empty retrieve query within bounds", () => {
    assert.match(validateToolArgs("study.retrieve", {}) ?? "", /query/);
    assert.match(
      validateToolArgs("study.retrieve", { query: "  " }) ?? "",
      /query/,
    );
    assert.match(
      validateToolArgs("study.retrieve", { query: "x", limit: 0 }) ?? "",
      /limit/,
    );
    assert.equal(
      validateToolArgs("study.retrieve", { query: "Fotosynthese" }),
      null,
    );
  });
});

describe("missingRequiresKey", () => {
  it("reports the first unloaded storage key", () => {
    const data = makeData();

    assert.equal(missingRequiresKey("calendar.today", data), null);
    assert.equal(missingRequiresKey("briefing.today", data), null);

    const broken = makeData({
      events: null as unknown as CalendarEvent[],
    });

    assert.equal(
      missingRequiresKey("calendar.today", broken),
      "jarvis-calendar-events",
    );
    assert.equal(missingRequiresKey("unknown.tool", broken), null);
  });
});

// ------------------------------------------------- mistake semantics

describe("runAgent mistake semantics", () => {
  it("lets the model report failed reads instead of aborting", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("lifestyle.placesSearch", { query: "Café" }),
      final("Die Ortssuche ist gerade offline. Versuche es später erneut."),
    ]);

    const outcome = await runAgent("Finde ein Café", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
      asyncReads: {
        "lifestyle.placesSearch": async () => ({
          ok: false,
          error: { code: "unavailable", message: "Anbieter offline." },
        }),
      },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.steps.length, 1);
    assert.equal(outcome.steps[0]?.ok, false);
    assert.match(outcome.answer, /offline/);
  });

  it("still aborts on repeated protocol violations with cause model", async () => {
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

    assert.equal(outcome.code, "model");
    assert.equal(outcome.retryable, true);
  });

  it("aborts on repeated unknown tools with cause model", async () => {
    const stores = makeStores();
    const chat = scriptChat([tool("sql.query"), tool("shell.exec")]);

    const outcome = await runAgent("Hallo", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "error");

    if (outcome.status !== "error") return;

    assert.equal(outcome.code, "model");
  });

  it("aborts on repeated invalid write plans with cause model", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("tasks.create", { task: { title: "" } }),
      tool("tasks.create", { task: { title: "" } }),
    ]);

    const outcome = await runAgent("Hallo", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "error");

    if (outcome.status !== "error") return;

    assert.equal(outcome.code, "model");
    assert.deepEqual(stores.calls, []);
  });
});

describe("runAgent arg validation end to end", () => {
  it("returns field errors to the model without silent fallbacks", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("calendar.upcoming", { days: 999 }),
      tool("calendar.upcoming", { days: 7 }),
      final("Ein Termin in den nächsten 7 Tagen."),
    ]);

    const outcome = await runAgent("Was steht an?", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.steps.length, 2);
    assert.equal(outcome.steps[0]?.ok, false);
    assert.match(outcome.steps[0]?.summary ?? "", /days/);
    assert.equal(outcome.steps[1]?.ok, true);

    const firstTool = (chat.seen[1] ?? []).find(
      (message) => message.role === "tool",
    );

    assert.match(firstTool?.content ?? "", /invalid-input/);
    assert.match(firstTool?.content ?? "", /days/);
  });

  it("reports unloaded modules as not-loaded, never throws", async () => {
    const stores = makeStores();
    const chat = scriptChat([tool("calendar.today"), final("Keine Daten.")]);

    const outcome = await runAgent("Was habe ich heute?", {
      chat,
      data: makeData({ events: null as unknown as CalendarEvent[] }),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.steps[0]?.ok, false);
    assert.match(outcome.steps[0]?.summary ?? "", /nicht geladen/);
  });
});

// ------------------------------------------------------- safe truncation

describe("truncateJsonSafe", () => {
  it("passes short payloads through untouched", () => {
    const value = { ok: true, data: [1, 2, 3] };

    assert.equal(truncateJsonSafe(value, 4000), JSON.stringify(value));
  });

  it("always returns valid JSON with a visible marker", () => {
    const value = {
      ok: true,
      data: { text: "x".repeat(5000), items: [1, 2, 3] },
    };
    const raw = truncateJsonSafe(value, 500);
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    assert.equal(raw.length <= 500, true);
    assert.equal(parsed.ok, true);
    assert.match(raw, /gekürzt/);
  });

  it("preserves the ok flag and error message when summarizing", () => {
    const numbers = Array.from({ length: 2000 }, (_, index) => index);
    // Max below the raw size forces the shape-summary fallback.
    const raw = truncateJsonSafe({ ok: false, error: "Anbieter offline." }, 30);
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, "Anbieter offline.");
    assert.match(raw, /gekürzt/);

    const listRaw = truncateJsonSafe(numbers, 60);
    const listParsed = JSON.parse(listRaw) as Record<string, unknown>;

    assert.equal(listParsed.anzahl, 2000);
  });
});

// --------------------------------------------------- place-query follow-up

describe("place-query follow-up", () => {
  it("detects place questions in German and Russian", () => {
    assert.equal(looksLikePlaceQuery("Finde ein Café in Berlin"), true);
    assert.equal(looksLikePlaceQuery("Gute Restaurants in der Nähe?"), true);
    assert.equal(looksLikePlaceQuery("Wo kann man spazieren?"), true);
    assert.equal(looksLikePlaceQuery("Найди музей рядом"), true);
    assert.equal(looksLikePlaceQuery("Wie viel habe ich ausgegeben?"), false);
    assert.equal(looksLikePlaceQuery("Was habe ich heute?"), false);
  });

  it("challenges long place finals without a live search", async () => {
    const stores = makeStores();
    const invented =
      "Hier sind tolle Cafés: Café Fantasia, Musterstraße 1, geöffnet 8–20 Uhr, " +
      "beste Bewertung der Stadt, unbedingt hingehen, sehr zu empfehlen und gemütlich. " +
      "Außerdem das Bistro Wunderbar am Marktplatz 5 mit Sonnenterrasse und Kuchen.";
    const chat = scriptChat([
      tool("calendar.today"),
      final(invented),
      tool("lifestyle.placesSearch", { query: "Café" }),
      final("Echte Treffer aus OpenStreetMap."),
    ]);

    const outcome = await runAgent("Was habe ich heute? Finde ein Café dazu.", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
      asyncReads: {
        "lifestyle.placesSearch": async () => ({
          ok: true,
          data: { places: [], resolvedLocation: null, notice: null },
        }),
      },
    });

    assert.equal(outcome.status, "done");
    assert.equal(chat.seen.length, 4);

    // Seen arrays are live references; search all of them for the challenge.
    const challenged = chat.seen.some((messages) =>
      messages.some(
        (message) =>
          message.role === "user" &&
          /lifestyle\.placesSearch/.test(message.content) &&
          /VERBOTEN/.test(message.content),
      ),
    );

    assert.equal(challenged, true);

    if (outcome.status !== "done") return;

    assert.deepEqual(
      outcome.steps.map((step) => step.tool),
      ["calendar.today", "lifestyle.placesSearch"],
    );
  });

  it("lets short place finals pass (usually clarifying questions)", async () => {
    const stores = makeStores();
    const chat = scriptChat([final("In welcher Stadt soll ich suchen?")]);

    const outcome = await runAgent("Finde ein Café", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");
    assert.equal(chat.seen.length, 1);
  });

  it("skips the challenge once the search tool ran", async () => {
    const stores = makeStores();
    const longAnswer = `Echte Treffer: ${"Café Central, Hauptstraße 1. ".repeat(20)}`;
    const chat = scriptChat([
      tool("lifestyle.placesSearch", { query: "Café" }),
      final(longAnswer),
    ]);

    const outcome = await runAgent("Finde ein Café", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
      asyncReads: {
        "lifestyle.placesSearch": async () => ({
          ok: true,
          data: { places: [], resolvedLocation: null, notice: null },
        }),
      },
    });

    assert.equal(outcome.status, "done");
    assert.equal(chat.seen.length, 2);
  });

  it("requires the live search in the system prompt", () => {
    const prompt = buildAgentSystemPrompt({
      locale: "de",
      todayISO: "2026-10-30",
      nowTime: "12:00",
      granted: ["read", "write"],
    });

    assert.match(prompt, /lifestyle\.placesSearch auf/);
    assert.match(prompt, /zu erfinden ist VERBOTEN/);
  });
});

// ------------------------------------------------------ error causes

describe("classifyServerError", () => {
  it("maps typed envelopes to causes with retry hints", () => {
    const fail = (code: string) => ({ ok: false, error: { code, message: "x" } });

    assert.deepEqual(classifyServerError(401, fail("unauthorized")), {
      message: "x",
      code: "auth",
      retryable: false,
    });
    assert.deepEqual(classifyServerError(400, fail("bad-request")), {
      message: "x",
      code: "format",
      retryable: false,
    });
    assert.deepEqual(classifyServerError(502, fail("upstream-error")), {
      message: "x",
      code: "ollama",
      retryable: true,
    });
    assert.deepEqual(classifyServerError(503, fail("migration-pending")), {
      message: "x",
      code: "supabase",
      retryable: true,
    });
    assert.deepEqual(classifyServerError(503, fail("cloud-not-configured")), {
      message: "x",
      code: "provider",
      retryable: false,
    });
  });

  it("falls back to status codes without an envelope", () => {
    assert.equal(classifyServerError(401, null).code, "auth");
    assert.equal(classifyServerError(400, null).code, "format");
    assert.equal(classifyServerError(503, null).code, "ollama");
    assert.equal(classifyServerError(500, null).code, "unknown");
    assert.equal(classifyServerError(500, null).retryable, true);
  });
});

describe("createApiChat causes", () => {
  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status });

  it("maps 401, network, and upstream failures", async () => {
    const unauthorized = createApiChat(
      (async () => jsonResponse(401, { ok: true, data: {} })) as typeof fetch,
    );

    await assert.rejects(unauthorized([]), /Sitzung abgelaufen/);

    try {
      await unauthorized([]);
      assert.fail("must throw");
    } catch (error: unknown) {
      assert.equal(
        (error as { code?: string }).code,
        "auth",
      );
      assert.equal(
        (error as { retryable?: boolean }).retryable,
        false,
      );
    }

    const offline = createApiChat((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);

    try {
      await offline([]);
      assert.fail("must throw");
    } catch (error: unknown) {
      assert.equal((error as { code?: string }).code, "network");
      assert.equal((error as { retryable?: boolean }).retryable, true);
    }

    const upstream = createApiChat(
      (async () =>
        jsonResponse(502, {
          ok: false,
          error: { code: "upstream-error", message: "Ollama down." },
        })) as typeof fetch,
    );

    try {
      await upstream([]);
      assert.fail("must throw");
    } catch (error: unknown) {
      assert.equal((error as { code?: string }).code, "ollama");
      assert.equal((error as { retryable?: boolean }).retryable, true);
    }
  });

  it("returns content on success", async () => {
    const chat = createApiChat(
      (async () =>
        jsonResponse(200, {
          ok: true,
          data: { content: '{"final": "Hi"}' },
        })) as typeof fetch,
    );

    assert.equal(await chat([]), '{"final": "Hi"}');
  });
});

describe("runAgent error surfacing", () => {
  it("passes transport causes through to the outcome", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      new Error("Keine Verbindung zum Server."),
    ]);
    const plain = await runAgent("Hallo", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(plain.status, "error");

    if (plain.status !== "error") return;

    assert.equal(plain.code, "unknown");
    assert.equal(plain.retryable, true);
  });

  it("reports budget aborts and cancellations with causes", async () => {
    const stores = makeStores();
    const looping = scriptChat([
      tool("calendar.today"),
      tool("calendar.today"),
      tool("calendar.today"),
    ]);

    const exhausted = await runAgent("Hallo", {
      chat: looping,
      data: makeData(),
      stores,
      locale: "de",
      maxSteps: 2,
    });

    assert.equal(exhausted.status, "error");

    if (exhausted.status !== "error") return;

    assert.equal(exhausted.code, "budget");
    assert.equal(exhausted.retryable, true);

    const controller = new AbortController();
    controller.abort();

    const aborted = await runAgent("Hallo", {
      chat: scriptChat([final("ok")]),
      data: makeData(),
      stores,
      locale: "de",
      signal: controller.signal,
    });

    assert.equal(aborted.status, "error");

    if (aborted.status !== "error") return;

    assert.equal(aborted.code, "aborted");
  });
});

// ------------------------------------------------------- briefing tool

describe("getBriefingToday", () => {
  it("composes real module data without mocks", () => {
    const result = getBriefingToday({
      events: [EVENT_TODAY],
      tasks: [TASK_OPEN],
      study: STUDY,
      finance: { ...EMPTY_FINANCE, transactions: [TX_FOOD] },
      todayISO: "2026-10-30",
      nowTime: "12:00",
    });

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.equal(result.data.today.events.length, 1);
    assert.equal(result.data.tasks.open.length, 1);
    assert.equal(result.data.deadlines.deadlines.length, 1);
    assert.equal(result.data.deadlines.deadlines[0]?.title, "Mathe-Klausur");
    assert.equal(result.data.finance.expenseCents, 2450);
    assert.equal(result.data.finance.monthKey, "2026-10");
  });

  it("fails honestly naming the broken modules", () => {
    const result = getBriefingToday({
      events: null,
      tasks: [TASK_OPEN],
      study: STUDY,
      finance: EMPTY_FINANCE,
      todayISO: "2026-10-30",
      nowTime: "12:00",
    });

    assert.equal(result.ok, false);

    if (result.ok) return;

    assert.equal(result.error.code, "invalid-input");
    assert.match(result.error.message, /calendar/);
  });

  it("runs end to end through the agent loop", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("briefing.today"),
      final("Briefing erstellt."),
    ]);

    const outcome = await runAgent("Tagesbriefing", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.steps[0]?.tool, "briefing.today");
    assert.equal(outcome.steps[0]?.ok, true);

    const toolMessage = (chat.seen[1] ?? []).find(
      (message) => message.role === "tool",
    );
    const parsed = JSON.parse(toolMessage?.content ?? "{}") as {
      ok: boolean;
      data: { finance: { expenseCents: number } };
    };

    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.finance.expenseCents, 2450);
  });
});

// ---------------------------------------------------------- NLU intents

describe("new NLU intents", () => {
  it("parses memory.create with categories", () => {
    const { plan } = parseCommand("Merk dir, dass ich Milch mag", CTX);

    assert.equal(plan.type, "memory.create");

    if (plan.type !== "memory.create") return;

    assert.equal(plan.entry.category, "preferences");
    assert.match(plan.entry.content, /Milch mag/);
    assert.equal(isAssistantPlan(plan), true);
  });

  it("asks when there is nothing to remember", () => {
    const { plan } = parseCommand("Merk dir", CTX);

    assert.equal(plan.type, "clarify");
  });

  it("parses memory.create in Russian", () => {
    const { plan, locale } = parseCommand("Запомни, что я люблю чай", CTX);

    assert.equal(locale, "ru");
    assert.equal(plan.type, "memory.create");

    if (plan.type !== "memory.create") return;

    assert.equal(plan.entry.category, "preferences");
  });

  it("parses tasks.create with priority and time", () => {
    const { plan } = parseCommand(
      "Erstelle dringend Aufgabe: Milch kaufen um 18:00",
      CTX,
    );

    assert.equal(plan.type, "tasks.create");

    if (plan.type !== "tasks.create") return;

    assert.equal(plan.task.title, "Milch kaufen");
    assert.equal(plan.task.priority, "Hoch");
    assert.equal(plan.task.time, "18:00");
    assert.equal(isAssistantPlan(plan), true);
  });

  it("parses tasks.open for list questions", () => {
    const { plan } = parseCommand("Welche offenen Aufgaben habe ich?", CTX);

    assert.equal(plan.type, "tasks.open");
    assert.equal(isAssistantPlan(plan), true);
  });

  it("parses the daily briefing before calendar lists", () => {
    assert.equal(parseCommand("Tagesbriefing", CTX).plan.type, "briefing.today");
    assert.equal(
      parseCommand("Was steht heute an?", CTX).plan.type,
      "briefing.today",
    );
    assert.equal(
      parseCommand("Gib mir eine Tagesübersicht", CTX).plan.type,
      "briefing.today",
    );
  });

  it("parses saved places and live place search", () => {
    const saved = parseCommand("Zeig meine gemerkten Orte", CTX);

    assert.equal(saved.plan.type, "lifestyle.saved");

    const search = parseCommand("Finde ein Café in Berlin", CTX);

    assert.equal(search.plan.type, "lifestyle.placesSearch");

    if (search.plan.type !== "lifestyle.placesSearch") return;

    assert.equal(search.plan.query, "Café");
    assert.equal(search.plan.near, "Berlin");
    assert.equal(search.plan.category, "food");
    assert.equal(isAssistantPlan(search.plan), true);
  });

  it("parses study reads by sub-intent", () => {
    assert.equal(
      parseCommand("Wie ist mein Lernstand?", CTX).plan.type,
      "study.progress",
    );
    assert.equal(
      parseCommand("Welche Fristen habe ich?", CTX).plan.type,
      "study.deadlines",
    );

    const { plan } = parseCommand(
      "Offene Themen in den nächsten 30 Tagen",
      CTX,
    );

    assert.equal(plan.type, "study.attention");

    if (plan.type !== "study.attention") return;

    assert.equal(plan.withinDays, 30);
  });

  it("parses memory reads, study docs, and lecture overviews", () => {
    assert.equal(
      parseCommand("Was weißt du über mich?", CTX).plan.type,
      "memory.approved",
    );
    assert.equal(
      parseCommand("Welche Dokumente habe ich?", CTX).plan.type,
      "study.documents",
    );

    const { plan } = parseCommand(
      "Suche in den Unterlagen nach Photosynthese",
      CTX,
    );

    assert.equal(plan.type, "study.retrieve");

    if (plan.type !== "study.retrieve") return;

    assert.equal(plan.query, "Photosynthese");

    assert.equal(
      parseCommand("Zeig meine Aufnahmen", CTX).plan.type,
      "lecture.overview",
    );
  });

  it("keeps jokes unsupported", () => {
    assert.equal(
      parseCommand("Erzähle mir einen Witz", CTX).plan.type,
      "unsupported",
    );
  });

  it("validates every new query shape", () => {
    const valid: unknown[] = [
      { type: "briefing.today" },
      { type: "calendar.today" },
      { type: "calendar.upcoming", days: 7 },
      { type: "tasks.open" },
      { type: "study.deadlines" },
      { type: "study.progress" },
      { type: "study.attention", withinDays: 14 },
      { type: "lifestyle.preferences" },
      { type: "lifestyle.saved" },
      { type: "lifestyle.upcomingPlans" },
      { type: "lifestyle.placesSearch", query: "x", limit: 3 },
      { type: "memory.approved" },
      { type: "study.documents" },
      { type: "study.retrieve", query: "x" },
      { type: "lecture.overview" },
    ];

    for (const candidate of valid) {
      assert.equal(isAssistantPlan(candidate), true);
    }

    const invalid: unknown[] = [
      { type: "calendar.upcoming", days: 99 },
      { type: "study.attention", withinDays: -1 },
      { type: "lifestyle.placesSearch", category: "bars" },
      { type: "lifestyle.placesSearch", limit: 99 },
      { type: "study.retrieve" },
      { type: "study.retrieve", query: "" },
    ];

    for (const candidate of invalid) {
      assert.equal(isAssistantPlan(candidate), false);
    }
  });
});

// ------------------------------------------------ heuristic end to end

describe("heuristic engine performs the required actions", () => {
  const BASE = {
    todayISO: "2026-10-30",
    nowTime: "12:00",
    timezone: "Europe/Berlin",
    locale: "de" as const,
  };

  it("answers the briefing from real data", async () => {
    const stores = makeStores();

    const outcome = await runAgent("Tagesbriefing", {
      chat: createHeuristicChat(BASE),
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.steps[0]?.tool, "briefing.today");
    assert.match(outcome.answer, /Treffen mit Max/);
    assert.match(outcome.answer, /Aufgaben: 1 offen/);
    assert.match(outcome.answer, /Mathe-Klausur/);
  });

  it("creates tasks and memories through the executor", async () => {
    const stores = makeStores();

    const taskOutcome = await runAgent("Erstelle Aufgabe: Milch kaufen", {
      chat: createHeuristicChat(BASE),
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(taskOutcome.status, "done");
    assert.equal(stores.savedTasks.length, 1);
    assert.equal(stores.savedTasks[0]?.title, "Milch kaufen");

    const memoryOutcome = await runAgent("Merk dir, dass ich Tee mag", {
      chat: createHeuristicChat(BASE),
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(memoryOutcome.status, "done");
    assert.equal(stores.savedMemories.length, 1);
    assert.equal(stores.savedMemories[0]?.category, "preferences");
  });

  it("searches places live instead of inventing them", async () => {
    const stores = makeStores();
    const chat = createHeuristicChat(BASE);
    const raw = await chat([{ role: "user", content: "Finde ein Café" }]);
    const envelope = JSON.parse(raw) as {
      tool?: string;
      args?: Record<string, unknown>;
    };

    assert.equal(envelope.tool, "lifestyle.placesSearch");

    const outcome = await runAgent("Finde ein Café", {
      chat: createHeuristicChat(BASE),
      data: makeData(),
      stores,
      locale: "de",
      asyncReads: {
        "lifestyle.placesSearch": async () => ({
          ok: true,
          data: {
            places: [
              {
                name: "Café Central",
                address: "Hauptstraße 1",
                openingHours: "8–20",
              },
            ],
            resolvedLocation: "Berlin",
            notice: "",
          },
        }),
      },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.match(outcome.answer, /Café Central/);
    assert.match(outcome.answer, /OpenStreetMap/);
  });

  it("reports tool failures honestly", async () => {
    const stores = makeStores();

    const outcome = await runAgent("Finde ein Café", {
      chat: createHeuristicChat(BASE),
      data: makeData(),
      stores,
      locale: "de",
      asyncReads: {
        "lifestyle.placesSearch": async () => ({
          ok: false,
          error: { code: "unavailable", message: "Anbieter offline." },
        }),
      },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.match(outcome.answer, /Anbieter offline/);
  });

  it("lists documents and retrieval sources from real data", async () => {
    const stores = makeStores();
    const chat = createHeuristicChat(BASE);

    const docsRaw = await chat([
      { role: "user", content: "Welche Dokumente habe ich?" },
    ]);
    const docsEnvelope = JSON.parse(docsRaw) as { tool?: string };

    assert.equal(docsEnvelope.tool, "study.documents");

    const outcome = await runAgent("Welche Dokumente habe ich?", {
      chat: createHeuristicChat(BASE),
      data: makeData(),
      stores,
      locale: "de",
      asyncReads: {
        "study.documents": async () => ({
          ok: true,
          data: {
            documents: [
              {
                id: "d1",
                name: "Skript.pdf",
                kind: "pdf",
                subject: "Mathe",
                extractionStatus: "completed",
              },
            ],
          },
        }),
      },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.match(outcome.answer, /Skript\.pdf/);
  });
});

// ------------------------------------------------------- plan safety

describe("structured plan safety (no exec, validated)", () => {
  it("stores hostile text verbatim without executing anything", async () => {
    const stores = makeStores();
    const hostile = "x'; DROP TABLE tasks; --";
    const chat = scriptChat([
      tool("tasks.create", {
        task: { title: hostile, time: "Keine Frist", priority: "Mittel" },
      }),
      final("Gespeichert."),
    ]);

    const outcome = await runAgent(hostile, {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");
    assert.equal(stores.savedTasks.length, 1);
    assert.equal(stores.savedTasks[0]?.title, hostile);
    assert.equal(
      stores.calls.filter((call) => call.startsWith("task:")).length,
      1,
    );
  });

  it("ignores injected extra keys on write envelopes", async () => {
    const stores = makeStores();
    // Own "__proto__" key via JSON, as a hostile model would send it.
    const hostileArgs = JSON.parse(
      '{"task":{"title":"Echt","time":"Keine Frist","priority":"Mittel"},"sql":"DROP TABLE tasks","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const chat = scriptChat([
      tool("tasks.create", hostileArgs),
      final("Gespeichert."),
    ]);

    const outcome = await runAgent("Erstelle Aufgabe", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");
    assert.equal(stores.savedTasks.length, 1);
    assert.equal(stores.savedTasks[0]?.title, "Echt");
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("rejects malformed write envelopes twice, then aborts", async () => {
    const stores = makeStores();
    const chat = scriptChat([
      tool("tasks.create", { task: { title: "x".repeat(500) } }),
      tool("tasks.create", { task: { title: "y".repeat(500) } }),
    ]);

    const outcome = await runAgent("Hallo", {
      chat,
      data: makeData(),
      stores,
      locale: "de",
    });

    assert.equal(outcome.status, "error");
    assert.deepEqual(stores.calls, []);
  });
});

// ---------------------------------------------- transcript error detail

describe("transcriptToTurns failure detail", () => {
  const NOW = new Date("2026-10-30T12:00:00.000Z");

  const message = (
    seq: number,
    role: ConversationMessage["role"],
    content: string,
  ): ConversationMessage =>
    createMessage({ threadId: "t1", seq, role, content }, NOW);

  it("carries the tool error on failed steps, null on success", () => {
    const turns = transcriptToTurns([
      message(0, "user", "Finde ein Café"),
      message(
        1,
        "assistant",
        JSON.stringify({ tool: "lifestyle.placesSearch", args: {} }),
      ),
      message(
        2,
        "tool",
        JSON.stringify({
          ok: false,
          error: { code: "unavailable", message: "Anbieter offline." },
        }),
      ),
      message(
        3,
        "assistant",
        JSON.stringify({ tool: "calendar.today", args: {} }),
      ),
      message(
        4,
        "tool",
        JSON.stringify({ ok: true, data: { events: [] } }),
      ),
      message(5, "assistant", JSON.stringify({ final: "Fertig." })),
    ]);

    const assistant = turns.find((turn) => turn.kind === "assistant");

    assert.notEqual(assistant, undefined);

    if (assistant?.kind !== "assistant") return;

    assert.equal(assistant.steps.length, 2);
    assert.equal(assistant.steps[0]?.ok, false);
    assert.equal(assistant.steps[0]?.detail, "Anbieter offline.");
    assert.equal(assistant.steps[1]?.ok, true);
    assert.equal(assistant.steps[1]?.detail, null);
  });

  it("links lifestyle turns to the lifestyle page", () => {
    assert.equal(
      turnHref([
        { tool: "lifestyle.placesSearch", label: "x", ok: true, detail: null },
      ]),
      "/lifestyle",
    );
  });
});

// -------------------------------------------- registry/model consistency

describe("registry and model params stay consistent", () => {
  it("documents every tool for the model", () => {
    for (const entry of ASSISTANT_TOOLS) {
      assert.notEqual(
        MODEL_PARAMS[entry.id],
        undefined,
        `MODEL_PARAMS missing ${entry.id}`,
      );
    }
  });

  it("executes every sync read tool by registry id", async () => {
    const validArgs: Record<string, Record<string, unknown>> = {
      "finance.monthSummary": { monthKey: "2026-10" },
      "finance.largest": { monthKey: "2026-10", limit: 3 },
    };

    for (const entry of ASSISTANT_TOOLS) {
      if (entry.permission !== "read") continue;
      if (entry.id === "study.documents") continue;
      if (entry.id === "study.retrieve") continue;
      if (entry.id === "lifestyle.placesSearch") continue;

      const stores = makeStores();
      const chat = scriptChat([
        tool(entry.id, validArgs[entry.id] ?? {}),
        final("ok"),
      ]);

      const outcome = await runAgent("test", {
        chat,
        data: makeData(),
        stores,
        locale: "de",
      });

      assert.equal(outcome.status, "done", `tool ${entry.id} must run`);
    }
  });
});
