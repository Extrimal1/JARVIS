/**
 * Conversation engine tests: domain validators, history budgeting,
 * persistent multi-turn runs, transcript sequencing, and
 * reload-safe storage shapes. Inference is scripted; resources are
 * in-memory fakes behind the hook interfaces.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CalendarEvent } from "@/src/lib/calendar";
import { EMPTY_FINANCE, type Transaction } from "@/src/lib/finance";
import { EMPTY_STUDY } from "@/src/lib/study";
import type { LifestylePreferences } from "@/src/lib/lifestyle/types";
import {
  createMessage,
  createThread,
  isConversationMessage,
  isConversationMessageList,
  isConversationThread,
  isConversationThreadList,
  type ConversationMessage,
  type ConversationThread,
} from "@/src/lib/conversation";
import {
  buildConversationHistory,
  HISTORY_TRUNCATION_NOTE,
  sendConversationTurn,
  threadMessages,
  type MessageResource,
  type ThreadResource,
} from "@/src/lib/assistant/conversation";
import { createHeuristicChat } from "@/src/lib/assistant/heuristicChat";
import type {
  AgentChat,
  AgentData,
  AgentMessage,
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
    finance: EMPTY_FINANCE,
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

function makeStores() {
  const calls: string[] = [];

  return {
    calls,
    calendar: {
      create: async (event: CalendarEvent) => {
        calls.push(`create:${event.id}`);

        return { ok: true as const, data: event };
      },
      update: async (id: string, patch: Partial<CalendarEvent>) => ({
        ok: true as const,
        data: { ...EVENT_A, ...patch, id },
      }),
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
  };
}

function makeThreads(): ThreadResource {
  const backing: ConversationThread[] = [];

  return {
    items: backing,
    loading: false,
    create: async (item) => {
      backing.push(item);

      return { ok: true, data: item };
    },
    update: async (id, patch) => {
      const index = backing.findIndex((entry) => entry.id === id);

      if (index === -1) return { ok: false, error: "missing" };

      const merged = { ...backing[index], ...patch, id };

      if (!isConversationThread(merged)) {
        return { ok: false, error: "invalid" };
      }

      backing[index] = merged;

      return { ok: true, data: merged };
    },
    remove: async (id) => {
      const index = backing.findIndex((entry) => entry.id === id);

      if (index !== -1) backing.splice(index, 1);

      return { ok: true, data: null };
    },
  };
}

function makeMessages(): MessageResource {
  const backing: ConversationMessage[] = [];

  return {
    items: backing,
    loading: false,
    create: async (item) => {
      backing.push(item);

      return { ok: true, data: item };
    },
    remove: async (id) => {
      const index = backing.findIndex((entry) => entry.id === id);

      if (index !== -1) backing.splice(index, 1);

      return { ok: true, data: null };
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

const NOW = new Date("2026-10-30T12:00:00.000Z");

describe("conversation domain", () => {
  it("validates threads and messages strictly", () => {
    const thread = createThread(
      { title: "Hallo", locale: "de", module: "assistant" },
      NOW,
    );
    const message = createMessage(
      {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "Hallo",
      },
      NOW,
    );

    assert.equal(isConversationThread(thread), true);
    assert.equal(isConversationMessage(message), true);
    assert.equal(isConversationThreadList([thread]), true);
    assert.equal(isConversationMessageList([message]), true);

    assert.equal(
      isConversationThread({ ...thread, locale: "en" }),
      false,
    );
    assert.equal(
      isConversationThread({ ...thread, module: "spaceship" }),
      false,
    );
    assert.equal(isConversationThread({ ...thread, version: 2 }), false);
    assert.equal(
      isConversationMessage({ ...message, role: "root" }),
      false,
    );
    assert.equal(isConversationMessage({ ...message, seq: -1 }), false);
    assert.equal(isConversationMessage({ ...message, content: "" }), false);
    assert.equal(
      isConversationMessage({ ...message, toolName: "x".repeat(65) }),
      false,
    );
  });

  it("factories slice overlong titles and contents", () => {
    const thread = createThread(
      { title: `  ${"t".repeat(200)}  `, locale: "ru", module: "memory" },
      NOW,
    );
    const message = createMessage(
      {
        threadId: thread.id,
        seq: 0,
        role: "user",
        content: "c".repeat(9000),
      },
      NOW,
    );

    assert.equal(thread.title.length, 120);
    assert.equal(thread.locale, "ru");
    assert.equal(message.content.length, 8000);
    assert.equal(message.toolName, null);
    assert.equal(isConversationThread(thread), true);
    assert.equal(isConversationMessage(message), true);
  });
});

describe("threadMessages", () => {
  it("filters by thread and sorts by seq", () => {
    const other = createThread(
      { title: "fremd", locale: "de", module: "assistant" },
      NOW,
    );
    const mine = createThread(
      { title: "mein", locale: "de", module: "assistant" },
      NOW,
    );
    const items = [
      createMessage(
        { threadId: mine.id, seq: 2, role: "tool", content: "r" },
        NOW,
      ),
      createMessage(
        { threadId: other.id, seq: 0, role: "user", content: "x" },
        NOW,
      ),
      createMessage(
        { threadId: mine.id, seq: 0, role: "user", content: "u" },
        NOW,
      ),
      createMessage(
        { threadId: mine.id, seq: 1, role: "assistant", content: "a" },
        NOW,
      ),
    ];

    const ordered = threadMessages(items, mine.id);

    assert.deepEqual(
      ordered.map((message) => message.seq),
      [0, 1, 2],
    );
  });
});

describe("buildConversationHistory", () => {
  function historyMessages(count: number): ConversationMessage[] {
    return Array.from({ length: count }, (_, seq) =>
      createMessage(
        {
          threadId: "thread-1",
          seq,
          role: seq % 2 === 0 ? "user" : "assistant",
          content: `Nachricht ${seq} mit etwas Inhalt zum Zählen.`,
        },
        NOW,
      ),
    );
  }

  it("maps roles and caps the message count", () => {
    const { history, truncated } = buildConversationHistory(
      historyMessages(10),
      { maxMessages: 4, maxChars: 100000 },
    );

    assert.equal(truncated, true);
    assert.equal(history.length, 5);
    assert.equal(history[0]?.role, "system");
    assert.equal(history[0]?.content, HISTORY_TRUNCATION_NOTE);
    assert.equal(history[1]?.role, "user");
    assert.equal(history[1]?.content, "Nachricht 6 mit etwas Inhalt zum Zählen.");
    assert.equal(history[4]?.content, "Nachricht 9 mit etwas Inhalt zum Zählen.");
  });

  it("cuts by characters but always keeps the newest message", () => {
    const { history, truncated } = buildConversationHistory(
      historyMessages(6),
      { maxChars: 50 },
    );

    assert.equal(truncated, true);
    assert.equal(history.length, 2);
    assert.match(history[1]?.content ?? "", /Nachricht 5/);
  });

  it("keeps short histories whole without a note", () => {
    const { history, truncated } = buildConversationHistory(
      historyMessages(3),
    );

    assert.equal(truncated, false);
    assert.equal(history.length, 3);
    assert.equal(history[0]?.role, "user");
  });
});

describe("sendConversationTurn", () => {
  it("creates a thread and persists the transcript in order", async () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const chat = scriptChat([
      tool("calendar.today"),
      final("Du hast 1 Termin."),
    ]);

    const result = await sendConversationTurn({
      threadId: null,
      text: "Was habe ich heute?",
      locale: "de",
      module: "assistant",
      chat,
      data: makeData(),
      stores: makeStores(),
      threads,
      messages,
      now: NOW,
    });

    assert.notEqual(result.thread, null);
    assert.equal(result.thread?.title, "Was habe ich heute?");
    assert.equal(result.thread?.locale, "de");
    assert.equal(result.outcome.status, "done");

    const stored = threadMessages(messages.items, result.thread?.id ?? "");

    assert.deepEqual(
      stored.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.deepEqual(
      stored.map((message) => message.seq),
      [0, 1, 2, 3],
    );
    assert.equal(stored[0]?.content, "Was habe ich heute?");
    assert.match(stored[1]?.content ?? "", /calendar\.today/);
    assert.match(stored[2]?.content ?? "", /Treffen mit Max/);
    assert.equal(stored[2]?.toolName, "calendar.today");
    assert.equal(stored[3]?.toolName, null);
  });

  it("retains context across messages in one thread", async () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const data = makeData();
    const stores = makeStores();

    const first = await sendConversationTurn({
      threadId: null,
      text: "Ich heiße Max.",
      locale: "de",
      chat: scriptChat([final("Hallo Max!")]),
      data,
      stores,
      threads,
      messages,
      now: NOW,
    });

    assert.equal(first.outcome.status, "done");

    const secondChat = scriptChat([final("Du heißt Max.")]);
    const second = await sendConversationTurn({
      threadId: first.thread?.id ?? null,
      text: "Wie heiße ich?",
      locale: "de",
      chat: secondChat,
      data,
      stores,
      threads,
      messages,
      now: NOW,
    });

    assert.equal(second.outcome.status, "done");
    assert.equal(second.thread?.id, first.thread?.id);

    const seen = secondChat.seen[0] ?? [];
    const contents = seen.map((message) => message.content).join("\n");

    assert.match(contents, /Ich heiße Max/);
    assert.match(contents, /Hallo Max/);
    assert.match(contents, /Wie heiße ich/);
    assert.equal(threadMessages(messages.items, first.thread?.id ?? "").length, 4);
  });

  it("truncates long histories before inference", async () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const thread = createThread(
      { title: "lang", locale: "de", module: "assistant" },
      NOW,
    );
    threads.items.push(thread);

    for (let seq = 0; seq < 10; seq += 1) {
      messages.items.push(
        createMessage(
          {
            threadId: thread.id,
            seq,
            role: seq % 2 === 0 ? "user" : "assistant",
            content: `Alter Inhalt ${seq} zum Vergessen.`,
          },
          NOW,
        ),
      );
    }

    const chat = scriptChat([final("Neu.")]);
    const result = await sendConversationTurn({
      threadId: thread.id,
      text: "Neue Frage?",
      locale: "de",
      chat,
      data: makeData(),
      stores: makeStores(),
      threads,
      messages,
      history: { maxMessages: 2 },
      now: NOW,
    });

    assert.equal(result.outcome.status, "done");

    const seen = chat.seen[0] ?? [];
    const contents = seen.map((message) => message.content).join("\n");

    assert.match(contents, /Alter Inhalt 9/);
    assert.equal(contents.includes(HISTORY_TRUNCATION_NOTE), true);
    assert.doesNotMatch(contents, /Alter Inhalt 0/);
  });

  it("stores only the user message on failed turns", async () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const chat = scriptChat([new Error("Das KI-Modell ist nicht erreichbar.")]);

    const result = await sendConversationTurn({
      threadId: null,
      text: "Hallo?",
      locale: "de",
      chat,
      data: makeData(),
      stores: makeStores(),
      threads,
      messages,
      now: NOW,
    });

    assert.equal(result.outcome.status, "error");

    const stored = threadMessages(messages.items, result.thread?.id ?? "");

    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.role, "user");
    assert.equal(stored[0]?.content, "Hallo?");
  });

  it("keeps the transcript behind confirmations", async () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const chat = scriptChat([
      tool("calendar.delete", { ref: { titleQuery: "Treffen mit Max" } }),
    ]);

    const result = await sendConversationTurn({
      threadId: null,
      text: "Lösche das Treffen",
      locale: "de",
      chat,
      data: makeData(),
      stores: makeStores(),
      threads,
      messages,
      now: NOW,
    });

    assert.equal(result.outcome.status, "confirm");

    const stored = threadMessages(messages.items, result.thread?.id ?? "");

    assert.deepEqual(
      stored.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.match(stored[1]?.content ?? "", /calendar\.delete/);
  });

  it("reports persistence failures honestly", async () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const failingMessages: MessageResource = {
      ...messages,
      create: async () => ({ ok: false, error: "Platte voll." }),
    };
    const chat = scriptChat([final("Hallo!")]);

    const result = await sendConversationTurn({
      threadId: null,
      text: "Hallo",
      locale: "de",
      chat,
      data: makeData(),
      stores: makeStores(),
      threads,
      messages: failingMessages,
      now: NOW,
    });

    assert.notEqual(result.thread, null);
    assert.equal(result.outcome.status, "error");

    if (result.outcome.status !== "error") return;

    assert.match(result.outcome.message, /nicht im Verlauf gespeichert/);
  });

  it("rejects empty texts and unknown threads", async () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const chat = scriptChat([final("Hi")]);
    const base = {
      locale: "de" as const,
      chat,
      data: makeData(),
      stores: makeStores(),
      threads,
      messages,
      now: NOW,
    };

    await assert.rejects(
      sendConversationTurn({ ...base, threadId: null, text: "   " }),
      /text must not be empty/,
    );
    await assert.rejects(
      sendConversationTurn({
        ...base,
        threadId: "00000000-0000-0000-0000-000000000000",
        text: "Hallo",
      }),
      /unknown thread id/,
    );
  });
});

describe("heuristic turns through the engine", () => {
  const chat = createHeuristicChat({
    todayISO: "2026-10-30",
    nowTime: "12:00",
    timezone: "Europe/Berlin",
    locale: "de",
  });

  it("clarifies, then executes the follow-up fragment", async () => {
    const threads = makeThreads();
    const messages = makeMessages();
    const stores = makeStores();
    const base = {
      locale: "de" as const,
      chat,
      data: makeData({ events: [] }),
      stores,
      threads,
      messages,
      now: NOW,
    };

    const first = await sendConversationTurn({
      ...base,
      threadId: null,
      text: "Plane um 15 Uhr ein Treffen mit Max",
    });

    assert.equal(first.outcome.status, "done");

    const second = await sendConversationTurn({
      ...base,
      threadId: first.thread?.id ?? null,
      text: "morgen",
    });

    assert.equal(second.outcome.status, "done");
    assert.equal(stores.calls.length, 1);
    assert.match(stores.calls[0] ?? "", /^create:/);

    const stored = threadMessages(messages.items, first.thread?.id ?? "");

    assert.deepEqual(
      stored.map((message) => message.role),
      ["user", "assistant", "user", "assistant", "tool", "assistant"],
    );
  });

  it("answers reads from real tool data, formatted", async () => {
    const threads = makeThreads();
    const messages = makeMessages();

    const result = await sendConversationTurn({
      threadId: null,
      text: "Was habe ich heute?",
      locale: "de",
      chat,
      data: makeData(),
      stores: makeStores(),
      threads,
      messages,
      now: NOW,
    });

    assert.equal(result.outcome.status, "done");

    if (result.outcome.status !== "done") return;

    assert.match(result.outcome.answer, /Treffen mit Max/);
    assert.doesNotMatch(result.outcome.answer, /\{"ok"/);
  });
});

describe("conversation reload safety", () => {
  it("round-trips threads and messages through JSON validation", () => {
    const thread = createThread(
      { title: "Hallo", locale: "de", module: "study" },
      NOW,
    );
    const items = [
      createMessage(
        { threadId: thread.id, seq: 0, role: "user", content: "Hi" },
        NOW,
      ),
      createMessage(
        {
          threadId: thread.id,
          seq: 1,
          role: "assistant",
          content: final("Hallo!"),
        },
        NOW,
      ),
    ];

    // Same path useLocalStorage takes: stringify on save, parse +
    // validate on reload; invalid shapes fall back, valid ones stay.
    const reloadedThreads: unknown = JSON.parse(
      JSON.stringify([thread]),
    ) as unknown;
    const reloadedMessages: unknown = JSON.parse(
      JSON.stringify(items),
    ) as unknown;

    assert.equal(isConversationThreadList(reloadedThreads), true);
    assert.equal(isConversationMessageList(reloadedMessages), true);
    assert.deepEqual(reloadedThreads, [thread]);
    assert.deepEqual(reloadedMessages, items);
    assert.equal(isConversationThreadList([{ ...thread, version: 99 }]), false);
    assert.equal(isConversationMessageList([{ nope: true }]), false);
  });
});
