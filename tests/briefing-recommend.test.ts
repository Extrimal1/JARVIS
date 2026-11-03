/**
 * Grounded recommendation tests: the single daily recommendation is
 * deterministic, prioritized (overdue → imminent exam → due reviews →
 * first event → budget → weather → top task), and every pick cites
 * the exact real data it was grounded in. No data → null (never
 * invented filler).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  pickRecommendation,
  type RecommendationInput,
} from "@/src/lib/briefing/recommend";

const EMPTY: RecommendationInput = {
  deadlines: [],
  dueReviewCount: 0,
  dueReviewSample: [],
  todaysEvents: [],
  openTasks: [],
  financeFlags: [],
  weatherCode: null,
  weatherHigh: null,
};

describe("pickRecommendation", () => {
  it("returns null when nothing grounds a recommendation", () => {
    assert.equal(pickRecommendation(EMPTY), null);
  });

  it("prioritizes overdue deadlines and cites them", () => {
    const rec = pickRecommendation({
      ...EMPTY,
      deadlines: [
        {
          id: "exam-1",
          title: "Analysis",
          subject: "Mathe",
          date: "2026-11-01",
          daysLeft: -2,
          kind: "exam",
        },
      ],
      dueReviewCount: 5,
      openTasks: [
        { id: "t", title: "Aufräumen", time: "x", done: false, priority: "Hoch" },
      ],
    });

    assert.ok(rec !== null);
    assert.match(rec.title, /Analysis/);
    assert.match(rec.source, /Analysis/);
    assert.match(rec.source, /2026-11-01/);
  });

  it("focuses an exam within seven days", () => {
    const rec = pickRecommendation({
      ...EMPTY,
      deadlines: [
        {
          id: "exam-2",
          title: "Physik",
          subject: null,
          date: "2026-11-06",
          daysLeft: 3,
          kind: "exam",
        },
      ],
    });

    assert.ok(rec !== null);
    assert.match(rec.title, /Physik/);
    assert.match(rec.detail, /in 3 Tagen/);
    assert.match(rec.source, /2026-11-06/);
  });

  it("ignores far-future exams when reviews are due", () => {
    const rec = pickRecommendation({
      ...EMPTY,
      deadlines: [
        {
          id: "exam-3",
          title: "Chemie",
          subject: null,
          date: "2026-12-20",
          daysLeft: 40,
          kind: "exam",
        },
      ],
      dueReviewCount: 3,
      dueReviewSample: [
        {
          subject: "Bio",
          question: "Was ist Photosynthese?",
          dueISO: "2026-11-02",
          daysOverdue: 1,
        },
      ],
    });

    assert.ok(rec !== null);
    assert.match(rec.title, /3 Wiederholungen/);
    assert.match(rec.source, /Photosynthese/);
  });

  it("prepares the first event of the day", () => {
    const rec = pickRecommendation({
      ...EMPTY,
      todaysEvents: [
        {
          id: "e1",
          title: "Vorlesung",
          date: "2026-11-03",
          start: "10:00",
          end: "11:30",
          type: "lecture",
          description: "",
          location: "Hörsaal 1",
        },
        {
          id: "e2",
          title: "Mensa",
          date: "2026-11-03",
          start: "12:00",
          end: "12:30",
          type: "personal",
          description: "",
          location: "",
        },
      ],
    });

    assert.ok(rec !== null);
    assert.match(rec.title, /10:00/);
    assert.match(rec.source, /Vorlesung/);
    assert.match(rec.source, /10:00/);
  });

  it("warns about exceeded budgets", () => {
    const rec = pickRecommendation({
      ...EMPTY,
      financeFlags: [
        { kind: "budget-exceeded", label: "Monatsbudget: 120 %", usage: 1.2 },
      ],
    });

    assert.ok(rec !== null);
    assert.match(rec.title, /Budget/);
    assert.match(rec.source, /Monatsbudget/);
  });

  it("reacts to bad weather with real conditions", () => {
    const rec = pickRecommendation({
      ...EMPTY,
      weatherCode: 61,
      weatherHigh: 9,
    });

    assert.ok(rec !== null);
    assert.match(rec.title, /Regen/);
    assert.match(rec.detail, /9 °C/);
    assert.match(rec.source, /Wettervorhersage/);
  });

  it("ignores fair weather in favor of the top task", () => {
    const rec = pickRecommendation({
      ...EMPTY,
      weatherCode: 1,
      weatherHigh: 21,
      openTasks: [
        { id: "t", title: "Steuer machen", time: "x", done: false, priority: "Hoch" },
      ],
    });

    assert.ok(rec !== null);
    assert.match(rec.title, /Steuer machen/);
    assert.match(rec.source, /Priorität Hoch/);
  });

  it("falls back to the next deadline, then any task", () => {
    const byDeadline = pickRecommendation({
      ...EMPTY,
      deadlines: [
        {
          id: "topic-1",
          title: "Kapitel 4",
          subject: null,
          date: "2026-11-20",
          daysLeft: 17,
          kind: "topic",
        },
      ],
    });

    assert.ok(byDeadline !== null);
    assert.match(byDeadline.source, /2026-11-20/);

    const byTask = pickRecommendation({
      ...EMPTY,
      openTasks: [
        { id: "t", title: "Lesen", time: "x", done: false, priority: "Niedrig" },
      ],
    });

    assert.ok(byTask !== null);
    assert.match(byTask.title, /Lesen/);
  });
});
