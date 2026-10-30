/**
 * Heuristic chat adapter tests: rule-based plans become tool
 * envelopes, clarifications become finals with options, follow-up
 * fragments re-parse against history. Real parser, no mocks.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENT_CORRECTION } from "@/src/lib/assistant/agent";
import { createHeuristicChat } from "@/src/lib/assistant/heuristicChat";
import type { AgentMessage } from "@/src/lib/assistant/agent";

const BASE = {
  todayISO: "2026-10-27",
  nowTime: "10:00",
  timezone: "Europe/Berlin",
  locale: "de" as const,
};

const user = (content: string): AgentMessage => ({ role: "user", content });

function envelopeOf(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("createHeuristicChat", () => {
  it("maps action plans to tool envelopes", async () => {
    const chat = createHeuristicChat(BASE);
    const raw = await chat([
      user("Plane morgen um 15:30 Uhr ein einstündiges Treffen mit Max."),
    ]);
    const envelope = envelopeOf(raw);

    assert.equal(envelope.tool, "calendar.create");

    const args = envelope.args as { event: { date: string; start: string } };

    assert.equal(args.event.date, "2026-10-28");
    assert.equal(args.event.start, "15:30");
  });

  it("maps clarifications to finals with options", async () => {
    const chat = createHeuristicChat(BASE);
    const raw = await chat([user("Plane um 15 Uhr ein Treffen mit Max")]);
    const envelope = envelopeOf(raw);

    assert.equal(typeof envelope.final, "string");
    assert.match(envelope.final as string, /Datum|Wann|welchen Tag/);

    const clarify = envelope.clarify as {
      options: { label: string; text: string }[];
    };

    assert.deepEqual(
      clarify.options.map((option) => option.label),
      ["Heute", "Morgen"],
    );
  });

  it("maps unsupported input to final help texts", async () => {
    const chat = createHeuristicChat(BASE);
    const raw = await chat([user("Erzähle mir einen Witz")]);
    const envelope = envelopeOf(raw);

    assert.equal(envelope.tool, undefined);
    assert.equal(typeof envelope.final, "string");
  });

  it("re-parses follow-up fragments against history", async () => {
    const chat = createHeuristicChat(BASE);
    const raw = await chat([
      user("Plane ein Treffen mit Max"),
      { role: "assistant", content: '{"final": "Wann?"}' },
      user("morgen um 15:00"),
    ]);
    const envelope = envelopeOf(raw);

    assert.equal(envelope.tool, "calendar.create");
  });

  it("ignores the loop's own repair prompts", async () => {
    const chat = createHeuristicChat(BASE);
    const raw = await chat([
      user("Plane morgen um 15:30 Uhr ein einstündiges Treffen mit Max."),
      { role: "assistant", content: "kein json" },
      user(AGENT_CORRECTION),
    ]);
    const envelope = envelopeOf(raw);

    assert.equal(envelope.tool, "calendar.create");
  });

  it("detects Russian per message", async () => {
    const chat = createHeuristicChat(BASE);
    const raw = await chat([user("Привет, как дела?")]);
    const envelope = envelopeOf(raw);

    assert.equal(typeof envelope.final, "string");
  });

  it("answers write reports with the executor message", async () => {
    const chat = createHeuristicChat(BASE);
    const raw = await chat([
      user("Plane morgen um 15:30 Uhr ein einstündiges Treffen mit Max."),
      {
        role: "assistant",
        content: JSON.stringify({ tool: "calendar.create", args: {} }),
      },
      {
        role: "tool",
        content: JSON.stringify({ ok: true, message: "Gespeichert: Treffen." }),
      },
    ]);
    const envelope = envelopeOf(raw);

    assert.equal(envelope.final, "Gespeichert: Treffen.");
  });

  it("formats read results instead of repeating the call", async () => {
    const chat = createHeuristicChat(BASE);
    const raw = await chat([
      user("Was habe ich heute?"),
      {
        role: "assistant",
        content: JSON.stringify({ tool: "calendar.today", args: {} }),
      },
      {
        role: "tool",
        content: JSON.stringify({
          ok: true,
          data: {
            todayISO: "2026-10-27",
            events: [
              {
                title: "Treffen mit Max",
                date: "2026-10-27",
                start: "15:30",
                end: "16:30",
              },
            ],
          },
        }),
      },
    ]);
    const envelope = envelopeOf(raw);

    assert.match(envelope.final as string, /Treffen mit Max/);
    assert.match(envelope.final as string, /15:30/);
    assert.doesNotMatch(envelope.final as string, /\{"ok"/);
  });

  it("surfaces tool errors and truncated results honestly", async () => {
    const chat = createHeuristicChat(BASE);
    const failed = await chat([
      user("Zeig den Monat"),
      {
        role: "assistant",
        content: JSON.stringify({ tool: "finance.monthSummary", args: {} }),
      },
      {
        role: "tool",
        content: JSON.stringify({
          ok: false,
          error: { code: "invalid-input", message: "Monat fehlt." },
        }),
      },
    ]);

    assert.match((envelopeOf(failed).final as string) ?? "", /Monat fehlt/);

    const truncated = await chat([
      user("Zeig alles"),
      {
        role: "assistant",
        content: JSON.stringify({ tool: "finance.list", args: {} }),
      },
      { role: "tool", content: '{"ok": true, "data": [1, 2, …gekürzt' },
    ]);

    assert.match(
      (envelopeOf(truncated).final as string) ?? "",
      /eingrenzen/,
    );
  });
});
