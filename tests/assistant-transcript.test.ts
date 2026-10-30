/**
 * Transcript view-model tests: persisted messages become renderable
 * turns, tool activity resolves to ok/failed, invalid envelopes are
 * skipped — never rendered as data.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMessage,
  type ConversationMessage,
} from "@/src/lib/conversation";
import {
  transcriptToTurns,
  turnHref,
} from "@/src/lib/assistant/transcript";

const NOW = new Date("2026-10-30T12:00:00.000Z");
const THREAD = "thread-1";

function msg(
  seq: number,
  role: ConversationMessage["role"],
  content: string,
): ConversationMessage {
  return createMessage({ threadId: THREAD, seq, role, content }, NOW);
}

describe("transcriptToTurns", () => {
  it("groups user turns with answers and tool steps", () => {
    const turns = transcriptToTurns([
      msg(0, "user", "Was habe ich heute?"),
      msg(1, "assistant", JSON.stringify({ tool: "calendar.today", args: {} })),
      msg(2, "tool", JSON.stringify({ ok: true, data: {} })),
      msg(3, "assistant", JSON.stringify({ final: "Du hast 1 Termin." })),
    ]);

    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0], {
      kind: "user",
      id: turns[0]?.id,
      text: "Was habe ich heute?",
    });

    const answer = turns[1];

    assert.equal(answer?.kind, "assistant");

    if (answer?.kind !== "assistant") return;

    assert.equal(answer.answer, "Du hast 1 Termin.");
    assert.equal(answer.steps.length, 1);
    assert.equal(answer.steps[0]?.tool, "calendar.today");
    assert.equal(answer.steps[0]?.label, "Heutige Termine");
    assert.equal(answer.steps[0]?.ok, true);
    assert.deepEqual(answer.clarify, []);
  });

  it("marks failed tools and extracts clarify options", () => {
    const turns = transcriptToTurns([
      msg(0, "user", "Plane um 15 Uhr ein Treffen"),
      msg(
        1,
        "assistant",
        JSON.stringify({
          final: "An welchem Tag?",
          clarify: {
            options: [
              { label: "Heute", text: "heute" },
              { label: "Morgen", text: "morgen" },
            ],
          },
        }),
      ),
      msg(2, "user", "Blödsinn"),
      msg(3, "assistant", JSON.stringify({ tool: "finance.monthSummary", args: {} })),
      msg(4, "tool", JSON.stringify({ ok: false, error: { message: "Monat fehlt." } })),
      msg(5, "assistant", JSON.stringify({ final: "Mir fehlt der Monat." })),
    ]);

    assert.equal(turns.length, 4);

    const first = turns[1];

    assert.equal(first?.kind, "assistant");

    if (first?.kind !== "assistant") return;

    assert.equal(first.answer, "An welchem Tag?");
    assert.deepEqual(
      first.clarify.map((option) => option.label),
      ["Heute", "Morgen"],
    );

    const second = turns[3];

    assert.equal(second?.kind, "assistant");

    if (second?.kind !== "assistant") return;

    assert.equal(second.steps[0]?.ok, false);
    assert.equal(second.steps[0]?.label, "Monatsübersicht Finanzen");
  });

  it("skips invalid envelopes, loop prompts, and system notes", () => {
    const turns = transcriptToTurns([
      msg(0, "system", "Ältere Nachrichten wurden gekürzt."),
      msg(1, "user", "Hallo"),
      msg(2, "assistant", "kein json {{{"),
      msg(3, "assistant", JSON.stringify({ final: "Hallo!" })),
      msg(
        4,
        "user",
        "Ungültig. Antworte mit GENAU einem JSON-Objekt: {\"final\": \"…\"} oder {\"tool\": \"<id>\", \"args\": {…}}. Kein Markdown, kein Fließtext.",
      ),
      msg(5, "assistant", JSON.stringify({ tool: "calendar.today", args: {} })),
    ]);

    assert.deepEqual(
      turns.map((turn) => turn.kind),
      ["user", "assistant"],
    );

    const answer = turns[1];

    if (answer?.kind !== "assistant") return;

    assert.equal(answer.answer, "Hallo!");
    assert.equal(answer.steps.length, 1);
    assert.equal(answer.steps[0]?.ok, null);
  });

  it("sorts by seq regardless of storage order", () => {
    const turns = transcriptToTurns([
      msg(2, "assistant", JSON.stringify({ final: "Spät." })),
      msg(0, "user", "Früh?"),
      msg(1, "assistant", JSON.stringify({ final: "Mitte." })),
    ]);

    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.kind, "user");

    if (turns[0]?.kind !== "user") return;

    assert.equal(turns[0].text, "Früh?");
  });
});

describe("turnHref", () => {
  it("links turns to their data module", () => {
    assert.equal(
      turnHref([{ tool: "calendar.today", label: "x", ok: true }]),
      "/calendar",
    );
    assert.equal(
      turnHref([{ tool: "finance.largest", label: "x", ok: true }]),
      "/finance",
    );
    assert.equal(turnHref([]), undefined);
    assert.equal(
      turnHref([{ tool: "memory.approved", label: "x", ok: true }]),
      undefined,
    );
  });
});
