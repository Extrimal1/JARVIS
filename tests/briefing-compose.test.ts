/**
 * Briefing composition tests: every section derives from real input
 * only — weather, today's events, open tasks, deadlines, due reviews,
 * news (interest-filtered), finance reminders, and the grounded
 * recommendation. Missing sources yield honest gaps, never filler.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  composeBriefing,
  summarizeBriefing,
  type BriefingInput,
} from "@/src/lib/briefing/compose";
import { EMPTY_FINANCE } from "@/src/lib/finance";
import { EMPTY_STUDY } from "@/src/lib/study";
import type { WeatherReport } from "@/src/lib/weather";

function weatherReport(): WeatherReport {
  return {
    city: {
      name: "München",
      latitude: 48.13,
      longitude: 11.57,
      detail: "Bayern",
    },
    now: {
      temperature: 8,
      feelsLike: 5,
      humidity: 80,
      windSpeed: 12,
      windDirection: 200,
      code: 61,
      isDay: true,
      high: 10,
      low: 4,
    },
    hourly: [],
    daily: [],
    fetchedAt: "2026-11-03T06:00:00Z",
  };
}

function baseInput(): BriefingInput {
  return {
    todayISO: "2026-11-03",
    generatedAt: "2026-11-03T06:30:00Z",
    timezone: "Europe/Berlin",
    city: null,
    weatherReport: weatherReport(),
    weatherError: null,
    events: [],
    tasks: [],
    study: { ...EMPTY_STUDY },
    questions: [],
    newsItems: [],
    newsError: null,
    interests: "",
    finance: { ...EMPTY_FINANCE },
  };
}

describe("composeBriefing", () => {
  it("derives every section from real input", () => {
    const input = baseInput();
    input.city = {
      name: "München",
      latitude: 48.13,
      longitude: 11.57,
      detail: "",
    };
    input.events = [
      {
        id: "e1",
        title: "Vorlesung",
        date: "2026-11-03",
        start: "10:00",
        end: "11:30",
        type: "lecture",
        description: "",
        location: "",
      },
      {
        id: "e2",
        title: "Morgen",
        date: "2026-11-04",
        start: "09:00",
        end: "10:00",
        type: "personal",
        description: "",
        location: "",
      },
    ];
    input.tasks = [
      { id: "t1", title: "A", time: "x", done: false, priority: "Hoch" },
      { id: "t2", title: "B", time: "x", done: true, priority: "Hoch" },
    ];
    input.study = {
      ...EMPTY_STUDY,
      exams: [
        { id: "ex1", title: "Analysis", detail: "", date: "2026-11-06" },
      ],
    };
    input.questions = [
      {
        id: "q1",
        subject: "Mathe",
        examId: null,
        topicId: null,
        question: "Integral?",
        options: ["a", "b"],
        correctIndex: 0,
        explanation: "",
        nextReviewAt: "2026-11-02",
      },
      {
        id: "q2",
        subject: "Mathe",
        examId: null,
        topicId: null,
        question: "Später?",
        options: ["a", "b"],
        correctIndex: 0,
        explanation: "",
        nextReviewAt: "2026-11-10",
      },
    ];
    input.newsItems = [
      {
        id: "n1",
        feedId: "tagesschau",
        feedLabel: "Tagesschau",
        title: "KI-Durchbruch",
        link: "https://example.com/ki",
        publishedAt: "2026-11-03T05:00:00Z",
        excerpt: "",
      },
    ];
    input.finance = {
      transactions: [
        {
          id: "tx1",
          title: "Miete",
          amount: 50000,
          type: "expense",
          category: "Miete",
          date: "2026-11-01",
        },
      ],
      monthlyBudgetCents: 60000,
      categoryBudgets: {},
      goals: [],
    };

    const briefing = composeBriefing(input);

    assert.equal(briefing.dateISO, "2026-11-03");
    assert.equal(briefing.weather.available, true);
    assert.equal(briefing.weather.usedDefaultCity, false);
    assert.equal(briefing.events.events.length, 1);
    assert.equal(briefing.events.events[0]?.title, "Vorlesung");
    assert.equal(briefing.tasks.totalOpen, 1);
    assert.equal(briefing.deadlines.total, 1);
    assert.equal(briefing.deadlines.deadlines[0]?.title, "Analysis");
    assert.equal(briefing.reviews.dueCount, 1);
    assert.equal(briefing.reviews.overdueCount, 1);
    assert.equal(briefing.reviews.totalQuestions, 2);
    assert.equal(briefing.news.items.length, 1);
    assert.equal(briefing.finance.reminders.length, 1);
    assert.match(briefing.finance.reminders[0]?.text ?? "", /83/);
    assert.ok(briefing.recommendation !== null);
    assert.match(briefing.recommendation.source, /Analysis/);
  });

  it("reports honest gaps for a fully empty briefing", () => {
    const input = baseInput();
    input.weatherReport = null;
    input.weatherError = "Wetterdienst nicht erreichbar.";
    input.newsItems = null;
    input.newsError = "Feeds offline.";

    const briefing = composeBriefing(input);

    assert.equal(briefing.weather.available, false);
    assert.equal(
      briefing.weather.unavailableReason,
      "Wetterdienst nicht erreichbar.",
    );
    assert.equal(briefing.news.unavailableReason, "Feeds offline.");
    assert.equal(briefing.recommendation, null);
    assert.ok(briefing.gaps.length >= 7);
    assert.ok(
      briefing.gaps.some((gap) => gap.startsWith("Wetter: keine Daten")),
    );
    assert.ok(
      briefing.gaps.some((gap) => gap.startsWith("Nachrichten: keine Daten")),
    );
    assert.ok(
      briefing.gaps.some((gap) => gap.startsWith("Empfehlung:")),
    );
  });

  it("filters news by interests without inventing items", () => {
    const input = baseInput();
    input.interests = "klima";
    input.newsItems = [
      {
        id: "n1",
        feedId: "a",
        feedLabel: "A",
        title: "Klimagipfel startet",
        link: "https://example.com/a",
        publishedAt: "",
        excerpt: "",
      },
      {
        id: "n2",
        feedId: "a",
        feedLabel: "A",
        title: "Fußballergebnisse",
        link: "https://example.com/b",
        publishedAt: "",
        excerpt: "",
      },
    ];

    const briefing = composeBriefing(input);

    assert.equal(briefing.news.items.length, 1);
    assert.equal(briefing.news.items[0]?.title, "Klimagipfel startet");
  });

  it("flags exceeded category budgets", () => {
    const input = baseInput();
    input.finance = {
      transactions: [
        {
          id: "tx1",
          title: "Essen",
          amount: 30000,
          type: "expense",
          category: "Lebensmittel",
          date: "2026-11-02",
        },
      ],
      monthlyBudgetCents: 0,
      categoryBudgets: { Lebensmittel: 20000 },
      goals: [],
    };

    const briefing = composeBriefing(input);

    assert.equal(briefing.finance.reminders.length, 1);
    assert.match(briefing.finance.reminders[0]?.text ?? "", /überschritten/);
    assert.equal(briefing.finance.flags.length, 1);
    assert.equal(briefing.finance.flags[0]?.kind, "category-exceeded");
  });

  it("truncates long lists but reports totals honestly", () => {
    const input = baseInput();
    input.tasks = Array.from({ length: 20 }, (_, index) => ({
      id: `t${index}`,
      title: `Aufgabe ${index}`,
      time: "x",
      done: false,
      priority: "Mittel" as const,
    }));

    const briefing = composeBriefing(input);

    assert.equal(briefing.tasks.totalOpen, 20);
    assert.equal(briefing.tasks.tasks.length, 8);
  });
});

describe("summarizeBriefing", () => {
  it("emits one short line per available section", () => {
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
        location: "",
      },
    ];

    const lines = summarizeBriefing(composeBriefing(input));

    assert.ok(lines.some((line) => line.includes("München")));
    assert.ok(lines.some((line) => line.includes("Vorlesung")));
    assert.ok(lines.every((line) => line.length <= 200));
  });

  it("emits no lines for empty data (no filler)", () => {
    const input = baseInput();
    input.weatherReport = null;
    input.newsItems = [];

    const lines = summarizeBriefing(composeBriefing(input));

    assert.deepEqual(lines, []);
  });
});
