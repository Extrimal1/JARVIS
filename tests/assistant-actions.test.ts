/**
 * Contract tests: request/plan validation, timezone-safe date math.
 * Run with `npm test` (Node's built-in runner, no dependencies).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addDaysISO,
  compareISO,
  describePlan,
  isAssistantPlan,
  isAssistantRequest,
  isISODateString,
  isMonthKey,
  isNluContext,
  isTimeString,
  mondayOfISO,
  weekdayOfISO,
  type AssistantPlan,
} from "@/src/lib/assistant/actions";

const REQUEST = {
  text: "Plane morgen um 15:30 ein Treffen mit Max",
  todayISO: "2026-10-27",
  nowTime: "10:00",
  timezone: "Europe/Berlin",
  locale: "de",
  idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
};

describe("assistant request validation", () => {
  it("accepts a complete valid request", () => {
    assert.equal(isAssistantRequest(REQUEST), true);
  });

  it("rejects empty and oversized text", () => {
    assert.equal(isAssistantRequest({ ...REQUEST, text: "   " }), false);
    assert.equal(
      isAssistantRequest({ ...REQUEST, text: "x".repeat(2001) }),
      false,
    );
  });

  it("rejects malformed dates, times, and idempotency keys", () => {
    assert.equal(
      isAssistantRequest({ ...REQUEST, todayISO: "2026-13-40" }),
      false,
    );
    assert.equal(
      isAssistantRequest({ ...REQUEST, nowTime: "25:00" }),
      false,
    );
    assert.equal(
      isAssistantRequest({ ...REQUEST, idempotencyKey: "not-a-uuid" }),
      false,
    );
  });

  it("rejects unknown locales", () => {
    assert.equal(isAssistantRequest({ ...REQUEST, locale: "en" }), false);
  });
});

describe("assistant context validation", () => {
  it("accepts valid contexts and rejects bad ones", () => {
    assert.equal(
      isNluContext({
        todayISO: "2026-10-27",
        nowTime: "10:00",
        timezone: "Europe/Berlin",
        locale: "ru",
      }),
      true,
    );
    assert.equal(
      isNluContext({
        todayISO: "27.10.2026",
        nowTime: "10:00",
        timezone: "Europe/Berlin",
        locale: "de",
      }),
      false,
    );
  });
});

describe("calendar scalar validators", () => {
  it("validates real calendar dates only", () => {
    assert.equal(isISODateString("2026-10-27"), true);
    assert.equal(isISODateString("2024-02-29"), true);
    assert.equal(isISODateString("2026-02-29"), false);
    assert.equal(isISODateString("2026-13-01"), false);
    assert.equal(isISODateString("27.10.2026"), false);
    assert.equal(isISODateString(""), false);
    assert.equal(isISODateString(null), false);
  });

  it("validates HH:MM times", () => {
    assert.equal(isTimeString("15:30"), true);
    assert.equal(isTimeString("00:00"), true);
    assert.equal(isTimeString("24:00"), false);
    assert.equal(isTimeString("15:60"), false);
    assert.equal(isTimeString("15.30"), false);
  });

  it("validates month keys", () => {
    assert.equal(isMonthKey("2026-10"), true);
    assert.equal(isMonthKey("2026-13"), false);
    assert.equal(isMonthKey("2026-1"), false);
  });
});

describe("timezone-safe date math", () => {
  it("shifts across month and year boundaries", () => {
    assert.equal(addDaysISO("2026-01-31", 1), "2026-02-01");
    assert.equal(addDaysISO("2026-12-31", 1), "2027-01-01");
    assert.equal(addDaysISO("2026-10-27", -1), "2026-10-26");
    assert.equal(addDaysISO("2024-02-28", 1), "2024-02-29");
  });

  it("finds the Monday of a week", () => {
    // 2026-10-27 is a Tuesday.
    assert.equal(mondayOfISO("2026-10-27"), "2026-10-26");
    assert.equal(mondayOfISO("2026-11-01"), "2026-10-26");
    assert.equal(mondayOfISO("2026-10-26"), "2026-10-26");
  });

  it("reports UTC weekdays (0 = Sunday)", () => {
    assert.equal(weekdayOfISO("2026-10-27"), 2);
    assert.equal(weekdayOfISO("2026-11-01"), 0);
  });

  it("compares ISO dates lexicographically", () => {
    assert.equal(compareISO("2026-10-27", "2026-10-28"), -1);
    assert.equal(compareISO("2026-10-28", "2026-10-28"), 0);
    assert.equal(compareISO("2026-10-29", "2026-10-28"), 1);
  });
});

describe("assistant plan validation", () => {
  const createPlan: AssistantPlan = {
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

  it("accepts a valid calendar.create plan", () => {
    assert.equal(isAssistantPlan(createPlan), true);
  });

  it("rejects events ending before they start", () => {
    assert.equal(
      isAssistantPlan({
        type: "calendar.create",
        event: { ...createPlan.event, start: "16:30", end: "16:30" },
      }),
      false,
    );
  });

  it("rejects empty update patches and unknown patch keys", () => {
    assert.equal(
      isAssistantPlan({
        type: "calendar.update",
        ref: { titleQuery: "Max" },
        patch: {},
      }),
      false,
    );
    assert.equal(
      isAssistantPlan({
        type: "calendar.update",
        ref: { titleQuery: "Max" },
        patch: { start: "16:00", id: "evil" },
      }),
      false,
    );
  });

  it("validates finance plans strictly", () => {
    assert.equal(
      isAssistantPlan({
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
      }),
      true,
    );
    assert.equal(
      isAssistantPlan({
        type: "finance.create",
        transaction: {
          title: "Lidl",
          amountCents: 0,
          type: "expense",
          category: "Lebensmittel",
          date: "2026-10-27",
          currency: "EUR",
          note: "",
        },
      }),
      false,
    );
    assert.equal(
      isAssistantPlan({
        type: "finance.create",
        transaction: {
          title: "Lidl",
          amountCents: 2450,
          type: "expense",
          category: "Lebensmittel",
          date: "2026-10-27",
          currency: "EURO",
          note: "",
        },
      }),
      false,
    );
  });

  it("bounds list limits and clarify options", () => {
    assert.equal(
      isAssistantPlan({ type: "finance.list", limit: 10 }),
      true,
    );
    assert.equal(
      isAssistantPlan({ type: "finance.list", limit: 99 }),
      false,
    );
    assert.equal(
      isAssistantPlan({
        type: "clarify",
        question: "Wann?",
        options: [
          { label: "a", text: "a" },
          { label: "b", text: "b" },
          { label: "c", text: "c" },
          { label: "d", text: "d" },
          { label: "e", text: "e" },
        ],
      }),
      false,
    );
  });

  it("rejects unknown plan types", () => {
    assert.equal(isAssistantPlan({ type: "calendar.teleport" }), false);
    assert.equal(isAssistantPlan(null), false);
    assert.equal(isAssistantPlan("calendar.create"), false);
  });
});

describe("describePlan", () => {
  it("summarizes action plans with key facts", () => {
    const summary = describePlan(
      {
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
      },
      "de",
    );

    assert.match(summary, /Treffen mit Max/);
    assert.match(summary, /2026-10-28/);
    assert.match(summary, /15:30/);
  });

  it("renders clarify and unsupported plans verbatim", () => {
    assert.equal(
      describePlan(
        { type: "clarify", question: "Wann?", options: [] },
        "de",
      ),
      "Wann?",
    );
    assert.equal(
      describePlan({ type: "unsupported", message: "Nein." }, "ru"),
      "Nein.",
    );
  });
});
