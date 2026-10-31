import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeTopicMastery,
  examReadiness,
  FAIL_STREAK_TRIP,
  MIN_ATTEMPTS_MASTERED,
  MIN_ATTEMPTS_SCORED,
  recomputeMastery,
  RECENT_WINDOW,
  SCORE_MASTERED,
  SCORE_UNDERSTOOD,
  WEAK_RECENT_ACCURACY,
} from "@/src/lib/study/mastery";
import type { Entry } from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { QuizRating } from "@/src/lib/quizReview";
import {
  MAX_REVIEW_EVENTS,
  isReviewEvent,
  isReviewEventList,
  pushReviewEvent,
  type ReviewEvent,
} from "@/src/lib/study/reviewEvents";
import { isMasteryEvidence } from "@/src/lib/study";

const NOW = "2026-10-31T10:00:00.000Z";

function topic(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "t1",
    title: "Zinsrechnung",
    detail: "",
    subject: "Mathe",
    sourceRefs: [{ documentId: "doc-1", label: "Folie 1" }],
    ...overrides,
  };
}

function question(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: "q1",
    subject: "Mathe",
    examId: null,
    topicId: "t1",
    question: "Was ist Zins?",
    options: ["A", "B"],
    correctIndex: 0,
    explanation: "Weil.",
    ...overrides,
  };
}

function event(
  index: number,
  correct: boolean,
  rating: QuizRating = "good",
  overrides: Partial<ReviewEvent> = {},
): ReviewEvent {
  return {
    id: `e${index}`,
    questionId: "q1",
    topicId: "t1",
    examId: null,
    kind: "single",
    correct,
    rating,
    createdAt: `2026-10-${String(10 + index).padStart(2, "0")}T10:00:00.000Z`,
    ...overrides,
  };
}

function streak(
  count: number,
  correct: boolean,
  rating: QuizRating = "good",
): ReviewEvent[] {
  return Array.from({ length: count }, (_, index) =>
    event(index + 1, correct, rating),
  );
}

describe("computeTopicMastery", () => {
  it("starts unstarted and never credits reading alone", () => {
    const result = computeTopicMastery("t1", [], [], NOW);

    assert.equal(result.mastery, "not-started");
    assert.equal(result.evidence.reviews, 0);
    assert.equal(result.evidence.score, null);
    assert.ok(
      (result.evidence.reasons ?? []).some((reason) =>
        reason.includes("keine Fragen beantwortet"),
      ),
    );
  });

  it("keeps thin evidence at learning without a score", () => {
    const one = computeTopicMastery(
      "t1",
      [question({ reviewCount: 1, successCount: 1 })],
      [event(1, true, "easy")],
      NOW,
    );

    assert.equal(one.mastery, "learning");
    assert.equal(one.evidence.score, null);
    assert.ok(
      (one.evidence.reasons ?? []).some((reason) =>
        reason.includes("Zu wenig Versuche"),
      ),
    );
  });

  it("masters stable high performance with volume", () => {
    const events = streak(10, true, "easy");
    const result = computeTopicMastery(
      "t1",
      [question({ reviewCount: 10, successCount: 10, difficulty: 5 })],
      events,
      NOW,
    );

    assert.equal(result.mastery, "mastered");
    assert.ok((result.evidence.score ?? 0) >= SCORE_MASTERED);
    assert.equal(result.evidence.reviews, 10);
    assert.equal(result.evidence.quizAccuracy, 1);
  });

  it("withholds mastered below the volume bar", () => {
    const events = streak(5, true, "easy");
    const result = computeTopicMastery(
      "t1",
      [question({ reviewCount: 5, successCount: 5, difficulty: 5 })],
      events,
      NOW,
    );

    assert.notEqual(result.mastery, "mastered");
    assert.equal(result.mastery, "understood");
  });

  it("drops to needs-revision on repeated mistakes", () => {
    const events = [
      ...streak(5, true, "good"),
      ...streak(3, false, "again").map((entry, index) => ({
        ...entry,
        id: `f${index}`,
        createdAt: `2026-10-${20 + index}T10:00:00.000Z`,
      })),
    ];
    const result = computeTopicMastery(
      "t1",
      [question({ reviewCount: 8, successCount: 5 })],
      events,
      NOW,
    );

    assert.equal(result.mastery, "needs-revision");
    assert.ok(
      (result.evidence.reasons ?? []).some((reason) =>
        reason.includes(`${FAIL_STREAK_TRIP} Fehler in Folge`),
      ),
    );
  });

  it("recovers when recent answers turn correct", () => {
    const events = [
      ...streak(3, false, "again"),
      ...streak(7, true, "good").map((entry, index) => ({
        ...entry,
        id: `r${index}`,
        createdAt: `2026-10-${20 + index}T10:00:00.000Z`,
      })),
    ];
    const result = computeTopicMastery(
      "t1",
      [question({ reviewCount: 10, successCount: 7 })],
      events,
      NOW,
    );

    assert.notEqual(result.mastery, "needs-revision");
    assert.equal(result.evidence.quizAccuracy, 0.7);
  });

  it("weights recent answers over old ones", () => {
    const old = computeTopicMastery(
      "t1",
      [question({ reviewCount: 10, successCount: 10 })],
      streak(10, true, "good"),
      NOW,
    );
    const slipped = computeTopicMastery(
      "t1",
      [question({ reviewCount: 13, successCount: 10 })],
      [
        ...streak(7, true, "good"),
        ...streak(3, false, "hard").map((entry, index) => ({
          ...entry,
          id: `s${index}`,
          createdAt: `2026-10-${20 + index}T10:00:00.000Z`,
        })),
      ],
      NOW,
    );

    assert.equal(old.mastery, "mastered");
    assert.ok((slipped.evidence.score ?? 100) < (old.evidence.score ?? 0));
  });

  it("rewards question-kind breadth", () => {
    const singleKind = computeTopicMastery(
      "t1",
      [question({ reviewCount: 6, successCount: 6, kind: "single" })],
      streak(6, true, "good"),
      NOW,
    );
    const mixed = computeTopicMastery(
      "t1",
      [
        question({
          id: "q1",
          reviewCount: 3,
          successCount: 3,
          kind: "single",
        }),
        question({
          id: "q2",
          reviewCount: 3,
          successCount: 3,
          kind: "multiple",
        }),
      ],
      [
        ...streak(3, true, "good"),
        ...streak(3, true, "good").map((entry, index) => ({
          ...entry,
          id: `m${index}`,
          kind: "multiple" as const,
          createdAt: `2026-10-${20 + index}T10:00:00.000Z`,
        })),
      ],
      NOW,
    );

    assert.deepEqual(mixed.evidence.kinds, ["multiple", "single"]);
    assert.ok(
      (mixed.evidence.score ?? 0) > (singleKind.evidence.score ?? 100),
    );
  });

  it("uses counters when no event log exists yet", () => {
    const result = computeTopicMastery(
      "t1",
      [question({ reviewCount: 8, successCount: 7, difficulty: 4 })],
      [],
      NOW,
    );

    assert.equal(result.evidence.reviews, 8);
    assert.equal(result.evidence.quizAccuracy, 0.875);
    assert.ok(
      (result.evidence.reasons ?? []).some((reason) =>
        reason.includes("keine Detailhistorie"),
      ),
    );
  });

  it("publishes its thresholds", () => {
    assert.equal(RECENT_WINDOW, 10);
    assert.equal(MIN_ATTEMPTS_SCORED, 3);
    assert.equal(MIN_ATTEMPTS_MASTERED, 8);
    assert.equal(SCORE_MASTERED, 85);
    assert.equal(SCORE_UNDERSTOOD, 70);
    assert.equal(WEAK_RECENT_ACCURACY, 0.5);
  });
});

describe("review events", () => {
  it("validates the shared cloud/local shape", () => {
    assert.equal(isReviewEvent(event(1, true)), true);
    assert.equal(isReviewEventList([event(1, true), event(2, false)]), true);
    assert.equal(isReviewEvent({ ...event(1, true), rating: "meh" }), false);
    assert.equal(isReviewEvent({}), false);
  });

  it("caps the ring buffer newest-first", () => {
    const full = Array.from({ length: MAX_REVIEW_EVENTS }, (_, index) =>
      event(index + 1, true),
    );
    const pushed = pushReviewEvent(full, event(999, false));

    assert.equal(pushed.length, MAX_REVIEW_EVENTS);
    assert.equal(pushed[0]?.id, "e999");
  });

  it("keeps old evidence records valid", () => {
    assert.equal(
      isMasteryEvidence({ quizAccuracy: 0.5, reviews: 4, ratedAt: null }),
      true,
    );
    assert.equal(
      isMasteryEvidence({
        quizAccuracy: null,
        reviews: 0,
        ratedAt: null,
        score: 80,
        reasons: ["Gut."],
        kinds: ["single"],
      }),
      true,
    );
    assert.equal(isMasteryEvidence({ quizAccuracy: 2, reviews: 1 }), false);
  });
});

describe("recomputeMastery", () => {
  it("scores every topic in stable order", () => {
    const out = recomputeMastery(
      [topic({ id: "t2", title: "B" }), topic({ id: "t1", title: "A" })],
      [question({ topicId: "t1", reviewCount: 4, successCount: 4 })],
      [],
      NOW,
    );

    assert.deepEqual([...out.keys()], ["t1", "t2"]);
    assert.equal(out.get("t2")?.mastery, "not-started");
  });
});

describe("examReadiness", () => {
  const exam: Entry = {
    id: "exam-1",
    title: "Klausur",
    detail: "",
    subject: "Mathe",
    date: "2026-11-10",
    examData: {
      documentIds: [],
      topicIds: ["t1"],
      availability: {
        weekly: [60, 60, 60, 60, 60, 0, 0],
        exceptions: {},
      },
      plan: {
        examId: "exam-1",
        generatedAt: NOW,
        inputsSignature: "{}",
        deficitMinutes: 0,
        warnings: [],
        tasks: [
          {
            id: "task-1",
            date: "2026-11-02",
            kind: "theory",
            topicId: "t1",
            questionIds: [],
            minutes: 15,
            priority: "normal",
            reason: "Grundlagen.",
            origin: "auto",
            status: "done",
          },
          {
            id: "task-2",
            date: "2026-11-03",
            kind: "quiz",
            topicId: "t1",
            questionIds: [],
            minutes: 15,
            priority: "normal",
            reason: "Abfrage.",
            origin: "auto",
            status: "open",
          },
        ],
      },
    },
  };

  it("combines mastery, accuracy, and plan completion", () => {
    const readiness = examReadiness(
      exam,
      [topic({ mastery: "understood" })],
      [question({ topicId: "t1", examId: "exam-1" })],
      streak(6, true, "good"),
    );

    assert.ok(readiness.score !== null && readiness.score >= 50);
    assert.ok(
      ["Gut vorbereitet", "Auf Kurs"].includes(readiness.label),
    );
    assert.ok(
      readiness.explanation.some((line) => line.includes("keine Erfolgsgarantie")),
    );
  });

  it("admits having no data", () => {
    const readiness = examReadiness(
      { ...exam, examData: undefined },
      [],
      [],
      [],
    );

    assert.equal(readiness.score, null);
    assert.equal(readiness.label, "Keine Daten");
  });
});
