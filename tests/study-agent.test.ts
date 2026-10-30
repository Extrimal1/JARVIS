/**
 * Agent study tests: async read tools (study.retrieve numbering
 * sources per turn) and citation integrity (one repair round, then
 * fabricated markers are stripped with a visible note).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runAgent,
  type AgentChat,
  type AgentData,
  type AgentMessage,
} from "@/src/lib/assistant/agent";
import { EMPTY_FINANCE } from "@/src/lib/finance";
import { EMPTY_STUDY } from "@/src/lib/study";
import type { LifestylePreferences } from "@/src/lib/lifestyle/types";
import type { ToolResult } from "@/src/lib/assistant/tools";

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

const DATA: AgentData = {
  events: [],
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
};

const STORES = {
  calendar: {
    create: async () => ({ ok: true as const, data: DATA.events[0]! }),
    update: async () => ({ ok: true as const, data: DATA.events[0]! }),
    remove: async () => ({ ok: true as const, data: null }),
  },
  transactions: {
    saveTransaction: async () => ({
      ok: true as const,
      data: DATA.finance.transactions[0]!,
    }),
    deleteTransaction: async () => ({ ok: true as const, data: null }),
  },
};

function scriptedChat(scripts: string[]): AgentChat & { calls: AgentMessage[][] } {
  const calls: AgentMessage[][] = [];
  let index = 0;

  const chat = (async (messages: AgentMessage[]) => {
    calls.push(messages);

    const next = scripts[Math.min(index, scripts.length - 1)] ?? "";
    index += 1;

    return next;
  }) as AgentChat & { calls: AgentMessage[][] };

  chat.calls = calls;

  return chat;
}

const RETRIEVAL: ToolResult<unknown> = {
  ok: true,
  data: {
    sources: [
      {
        documentId: "doc-1",
        documentName: "Bio.pdf",
        refLabel: "Seite 1",
        text: "Die Glykolyse spaltet Glukose.",
        score: 12.5,
        matchedTerms: ["glykolyse"],
      },
    ],
    totalCandidates: 1,
    terms: ["glykolyse"],
  },
};

describe("study.retrieve in the agent loop", () => {
  it("numbers sources and accepts resolving citations", async () => {
    const chat = scriptedChat([
      `{"tool": "study.retrieve", "args": {"query": "Glykolyse"}}`,
      `{"final": "Die Glykolyse spaltet Glukose [Q1]."}`,
    ]);

    const outcome = await runAgent("Was ist Glykolyse?", {
      chat,
      data: DATA,
      stores: STORES,
      locale: "de",
      granted: ["read"],
      asyncReads: { "study.retrieve": async () => RETRIEVAL },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.answer, "Die Glykolyse spaltet Glukose [Q1].");
    assert.deepEqual(
      outcome.steps.map((step) => step.tool),
      ["study.retrieve"],
    );

    const toolMessage = chat.calls[1]?.find(
      (message) => message.role === "tool",
    )?.content;
    assert.match(toolMessage ?? "", /"marker":"\[Q1\]"/);
    assert.match(toolMessage ?? "", /"documentName":"Bio\.pdf"/);
    assert.match(toolMessage ?? "", /"refLabel":"Seite 1"/);
  });

  it("repairs fabricated citations once, then accepts the fix", async () => {
    const chat = scriptedChat([
      `{"tool": "study.retrieve", "args": {"query": "Glykolyse"}}`,
      `{"final": "Fakt [Q1], Bluff [Q7]."}`,
      `{"final": "Nur Fakt [Q1]."}`,
    ]);

    const outcome = await runAgent("Was ist Glykolyse?", {
      chat,
      data: DATA,
      stores: STORES,
      locale: "de",
      granted: ["read"],
      asyncReads: { "study.retrieve": async () => RETRIEVAL },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.answer, "Nur Fakt [Q1].");
    // Tool call + bad final + repaired final = 3 inference rounds.
    assert.equal(chat.calls.length, 3);

    const repairPrompt = chat.calls
      .flat()
      .find(
        (message) =>
          message.role === "user" && message.content.includes("[Q7]"),
      )?.content;
    assert.match(repairPrompt ?? "", /existieren nicht/);
  });

  it("strips persistently fabricated markers with a visible note", async () => {
    const chat = scriptedChat([
      `{"tool": "study.retrieve", "args": {"query": "Glykolyse"}}`,
      `{"final": "Bluff [Q7]."}`,
      `{"final": "Weiter Bluff [Q9]."}`,
    ]);

    const outcome = await runAgent("Was ist Glykolyse?", {
      chat,
      data: DATA,
      stores: STORES,
      locale: "de",
      granted: ["read"],
      asyncReads: { "study.retrieve": async () => RETRIEVAL },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    const [body] = outcome.answer.split("Hinweis:");
    assert.ok(!(body ?? "").includes("[Q9]"));
    assert.match(outcome.answer, /\[Q9\] konnten nicht verifiziert/);
    assert.match(outcome.answer, /Bio\.pdf, Seite 1/);
  });

  it("keeps numbering stable across repeated retrieval calls", async () => {
    const chat = scriptedChat([
      `{"tool": "study.retrieve", "args": {"query": "eins"}}`,
      `{"tool": "study.retrieve", "args": {"query": "zwei"}}`,
      `{"final": "Erstens [Q1], zweitens [Q2]."}`,
    ]);

    const outcome = await runAgent("Fasse beides zusammen.", {
      chat,
      data: DATA,
      stores: STORES,
      locale: "de",
      granted: ["read"],
      asyncReads: { "study.retrieve": async () => RETRIEVAL },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.answer, "Erstens [Q1], zweitens [Q2].");
  });

  it("repairs citations that appear without any retrieval", async () => {
    const chat = scriptedChat([
      `{"final": "Angeblich Fakt [Q1]."}`,
      `{"final": "Ohne Beleg keine Aussage."}`,
    ]);

    const outcome = await runAgent("Was steht in meinen Unterlagen?", {
      chat,
      data: DATA,
      stores: STORES,
      locale: "de",
      granted: ["read"],
      asyncReads: { "study.retrieve": async () => RETRIEVAL },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    // Short final: no bare challenge — [Q1] with zero sources fails
    // citation validation and triggers the repair round instead.
    assert.equal(chat.calls.length, 2);
    assert.equal(outcome.answer, "Ohne Beleg keine Aussage.");

    const repairPrompt = chat.calls
      .flat()
      .find(
        (message) =>
          message.role === "user" && message.content.includes("[Q1]"),
      )?.content;
    assert.match(repairPrompt ?? "", /existieren nicht/);
  });

  it("surfaces async tool failures as failed steps", async () => {
    const chat = scriptedChat([
      `{"tool": "study.retrieve", "args": {"query": "x"}}`,
      `{"final": "Kurz."}`,
    ]);

    const outcome = await runAgent("Suche etwas.", {
      chat,
      data: DATA,
      stores: STORES,
      locale: "de",
      granted: ["read"],
      asyncReads: {
        "study.retrieve": async () => {
          throw new Error("Netzwerk weg.");
        },
      },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.steps[0]?.ok, false);
    assert.equal(outcome.steps[0]?.summary, "Netzwerk weg.");
  });
});
