/**
 * Briefing rendering tests: push payloads stay within title/body
 * limits with stable tag/url/date, and the full text renders every
 * section from real values (empty sections stay honest).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  composeBriefing,
  type BriefingInput,
} from "@/src/lib/briefing/compose";
import {
  PUSH_BODY_LIMIT,
  PUSH_TITLE_LIMIT,
  toPushPayload,
  toText,
  truncate,
} from "@/src/lib/briefing/format";
import { EMPTY_FINANCE } from "@/src/lib/finance";
import { EMPTY_STUDY } from "@/src/lib/study";

function baseInput(): BriefingInput {
  return {
    todayISO: "2026-11-03",
    generatedAt: "2026-11-03T06:30:00Z",
    timezone: "Europe/Berlin",
    city: null,
    weatherReport: null,
    weatherError: "offline",
    events: [],
    tasks: [
      { id: "t1", title: "Steuer machen", time: "x", done: false, priority: "Hoch" },
    ],
    study: { ...EMPTY_STUDY },
    questions: [],
    newsItems: [],
    newsError: null,
    interests: "",
    finance: { ...EMPTY_FINANCE },
  };
}

describe("truncate", () => {
  it("keeps short values and truncates with ellipsis", () => {
    assert.equal(truncate("Hallo", 10), "Hallo");
    assert.equal(truncate("  Hallo   Welt  ", 20), "Hallo Welt");
    assert.equal(truncate("abcdefghij", 5), "abcd…");
  });
});

describe("toPushPayload", () => {
  it("builds a bounded payload with stable tag/url/date", () => {
    const payload = toPushPayload(composeBriefing(baseInput()));

    assert.ok(payload.title.length <= PUSH_TITLE_LIMIT);
    assert.ok(payload.body.length <= PUSH_BODY_LIMIT);
    assert.equal(payload.url, "/briefing");
    assert.equal(payload.tag, "morning-briefing-2026-11-03");
    assert.equal(payload.date, "2026-11-03");
    assert.match(payload.body, /Steuer machen/);
  });

  it("falls back to a generic body when every section is empty", () => {
    const input = baseInput();
    input.tasks = [];

    const payload = toPushPayload(composeBriefing(input));

    assert.equal(payload.body, "Dein Morgen-Briefing ist da.");
  });
});

describe("toText", () => {
  it("renders all sections with real values", () => {
    const input = baseInput();
    input.events = [
      {
        id: "e1",
        title: "Vorlesung",
        date: "2026-11-03",
        start: "10:00",
        end: "11:30",
        type: "lecture",
        description: "",
        location: "HS 1",
      },
    ];
    input.newsItems = [
      {
        id: "n1",
        feedId: "a",
        feedLabel: "Tagesschau",
        title: "Wichtiges Ereignis",
        link: "https://example.com/x",
        publishedAt: "",
        excerpt: "",
      },
    ];

    const text = toText(composeBriefing(input));

    for (const header of [
      "WETTER",
      "HEUTE IM KALENDER",
      "AUFGABEN",
      "PRÜFUNGEN & THEMEN",
      "WIEDERHOLUNGEN",
      "NACHRICHTEN",
      "FINANZEN",
      "EMPFEHLUNG",
    ]) {
      assert.ok(text.includes(header), `missing ${header}`);
    }

    assert.ok(text.includes("Vorlesung"));
    assert.ok(text.includes("HS 1"));
    assert.ok(text.includes("Wichtiges Ereignis"));
    assert.ok(text.includes("Quelle:"));
  });

  it("renders honest empty states without filler", () => {
    const input = baseInput();
    input.tasks = [];

    const text = toText(composeBriefing(input));

    assert.ok(text.includes("Keine Termine."));
    assert.ok(text.includes("Keine offenen Aufgaben."));
    assert.ok(
      text.includes("Keine Datengrundlage — keine Empfehlung möglich."),
    );
  });
});
