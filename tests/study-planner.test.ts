import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTopicMinutes,
  FINAL_PHASE_DAYS,
  generateStudyPlans,
  MOCK_MINUTES,
  planInputsSignature,
  prerequisiteLevels,
  REVIEW_MINUTES_PER_QUESTION,
  topicAccuracy,
} from "@/src/lib/study/planner";
import { isExamData, isStudyPlan, type Entry } from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";

const TODAY = "2026-10-31"; // Saturday

function entry(overrides: Partial<Entry> = {}): Entry {
  return { id: "e1", title: "Eintrag", detail: "", ...overrides };
}

function exam(
  id: string,
  date: string,
  topicIds: string[],
  availability?: Entry["examData"],
): Entry {
  return entry({
    id,
    title: `Prüfung ${id}`,
    date,
    subject: "Mathe",
    examData: availability ?? {
      documentIds: [],
      topicIds,
      availability: {
        weekly: [60, 60, 60, 60, 60, 0, 0],
        exceptions: {},
      },
    },
  });
}

function topic(
  id: string,
  title: string,
  overrides: Partial<Entry> = {},
): Entry {
  return entry({
    id,
    title,
    subject: "Mathe",
    topicData: { concepts: ["a", "b"], formulas: [], examples: [], prerequisites: [] },
    sourceRefs: [{ documentId: "doc-1", label: "Folie 1" }],
    ...overrides,
  });
}

function question(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: "q1",
    subject: "Mathe",
    examId: null,
    topicId: null,
    question: "Was ist Zins?",
    options: ["A", "B"],
    correctIndex: 0,
    explanation: "Weil.",
    ...overrides,
  };
}

function tasksOf(result: ReturnType<typeof generateStudyPlans>, examId: string) {
  return result.plans.find((plan) => plan.examId === examId)?.tasks ?? [];
}

describe("estimateTopicMinutes", () => {
  it("scales with material, mastery, and weakness", () => {
    const small = estimateTopicMinutes(topic("t1", "Zins"), []);

    assert.deepEqual(small, { theory: 15, practice: 14 });

    const big = estimateTopicMinutes(
      topic("t2", "Rente", {
        topicData: {
          concepts: ["a", "b", "c", "d", "e", "f"],
          formulas: [{ text: "x", variables: [] }],
          examples: ["e1", "e2"],
          prerequisites: [],
        },
      }),
      [],
    );

    assert.ok(big.theory + big.practice > small.theory + small.practice);

    assert.deepEqual(
      estimateTopicMinutes(
        topic("t3", "Fertig", { mastery: "mastered" }),
        [],
      ),
      { theory: 0, practice: 0 },
    );

    const weak = estimateTopicMinutes(topic("t1", "Zins"), [
      question({ topicId: "t1", reviewCount: 10, successCount: 4 }),
    ]);
    const strong = estimateTopicMinutes(topic("t1", "Zins"), [
      question({ topicId: "t1", reviewCount: 10, successCount: 9 }),
    ]);

    assert.ok(weak.theory + weak.practice > strong.theory + strong.practice);
  });

  it("computes accuracy over attempted questions", () => {
    assert.equal(
      topicAccuracy("t1", [
        question({ topicId: "t1", reviewCount: 4, successCount: 2 }),
        question({ topicId: "t1", reviewCount: 2, successCount: 2 }),
      ]),
      0.75,
    );
    assert.equal(topicAccuracy("t1", [question({ topicId: "t1" })]), null);
  });
});

describe("prerequisiteLevels", () => {
  it("levels chains and reports unknown names", () => {
    const graph = prerequisiteLevels([
      topic("t1", "Zinsrechnung"),
      topic("t2", "Rentenrechnung", {
        topicData: {
          concepts: [],
          formulas: [],
          examples: [],
          prerequisites: ["Zinsrechnung", "Erfundenes Gebiet"],
        },
      }),
    ]);

    assert.equal(graph.levels.get("t1"), 0);
    assert.equal(graph.levels.get("t2"), 1);
    assert.deepEqual(graph.unknown, ["Erfundenes Gebiet"]);
  });

  it("survives cycles", () => {
    const graph = prerequisiteLevels([
      topic("t1", "Alpha", {
        topicData: {
          concepts: [],
          formulas: [],
          examples: [],
          prerequisites: ["Beta"],
        },
      }),
      topic("t2", "Beta", {
        topicData: {
          concepts: [],
          formulas: [],
          examples: [],
          prerequisites: ["Alpha"],
        },
      }),
    ]);

    assert.equal(typeof graph.levels.get("t1"), "number");
    assert.equal(typeof graph.levels.get("t2"), "number");
  });
});

describe("generateStudyPlans", () => {
  const t1 = topic("t1", "Zinsrechnung");
  const t2 = topic("t2", "Rentenrechnung", {
    topicData: {
      concepts: ["a"],
      formulas: [],
      examples: [],
      prerequisites: ["Zinsrechnung"],
    },
  });

  it("respects daily limits and keeps days off empty", () => {
    const result = generateStudyPlans({
      exams: [exam("exam-1", "2026-11-10", ["t1", "t2"])],
      topics: [t1, t2],
      questions: [],
      todayISO: TODAY,
    });

    for (const day of result.combined) {
      assert.ok(
        day.plannedMinutes <= day.poolMinutes,
        `${day.date}: ${day.plannedMinutes} > ${day.poolMinutes}`,
      );
    }

    const tasks = tasksOf(result, "exam-1");
    const weekend = tasks.filter(
      (task) => task.date === "2026-10-31" || task.date === "2026-11-01",
    );

    assert.equal(weekend.length, 0);
    assert.ok(tasks.length > 0);
  });

  it("honors exceptions and custom weekdays", () => {
    const custom = exam("exam-1", "2026-11-04", ["t1"], {
      documentIds: [],
      topicIds: ["t1"],
      availability: {
        weekly: [0, 0, 0, 0, 0, 0, 0],
        exceptions: { "2026-11-02": 120, "2026-11-03": null },
      },
    });
    const result = generateStudyPlans({
      exams: [custom],
      topics: [t1],
      questions: [],
      todayISO: TODAY,
    });
    const tasks = tasksOf(result, "exam-1");

    assert.ok(tasks.length > 0);
    assert.ok(
      tasks.every((task) => task.date === "2026-11-02"),
      "tasks only on the exception day",
    );

    const pool = result.combined.find((day) => day.date === "2026-11-02");

    assert.equal(pool?.poolMinutes, 120);
  });

  it("orders prerequisites before dependents", () => {
    const heavy = topic("t1", "Zinsrechnung", {
      topicData: {
        concepts: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        formulas: [
          { text: "f1", variables: [] },
          { text: "f2", variables: [] },
          { text: "f3", variables: [] },
          { text: "f4", variables: [] },
          { text: "f5", variables: [] },
        ],
        examples: [],
        prerequisites: [],
      },
    });
    const result = generateStudyPlans({
      exams: [exam("exam-1", "2026-11-10", ["t1", "t2"])],
      topics: [heavy, t2],
      questions: [],
      todayISO: TODAY,
    });
    const tasks = tasksOf(result, "exam-1");
    const seqOf = (id: string): number =>
      Number.parseInt(id.split(":").pop() ?? "0", 10);
    const t1Tasks = tasks.filter((task) => task.topicId === "t1");
    const t2Tasks = tasks.filter((task) => task.topicId === "t2");

    assert.ok(t1Tasks.length > 0 && t2Tasks.length > 0);

    const lastT1 = t1Tasks.map((task) => task.date).sort().pop() as string;
    const firstT2 = t2Tasks.map((task) => task.date).sort()[0] as string;

    assert.ok(firstT2 >= lastT1, `${firstT2} >= ${lastT1}`);

    // Same-day order follows creation sequence (prerequisite first).
    const sameDay = t2Tasks.filter((task) => task.date === lastT1);

    for (const task of sameDay) {
      const dayT1 = t1Tasks.filter((entry) => entry.date === lastT1);

      assert.ok(
        dayT1.every((entry) => seqOf(entry.id) < seqOf(task.id)),
        "t1 slices precede t2 slices on the shared day",
      );
    }
  });

  it("prioritizes weak topics and due reviews", () => {
    const weak = topic("t1", "Zinsrechnung");
    const fine = topic("t2", "Rentenrechnung", {
      topicData: { concepts: ["a"], formulas: [], examples: [], prerequisites: [] },
    });
    const result = generateStudyPlans({
      exams: [exam("exam-1", "2026-11-10", ["t1", "t2"])],
      topics: [weak, fine],
      questions: [
        question({
          id: "q-weak",
          topicId: "t1",
          reviewCount: 10,
          successCount: 2,
          nextReviewAt: "2026-12-01",
        }),
        question({
          id: "q-due",
          topicId: "t2",
          nextReviewAt: "2026-10-30",
        }),
      ],
      todayISO: TODAY,
    });
    const tasks = tasksOf(result, "exam-1");
    const reviews = tasks.filter((task) => task.kind === "review");

    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.priority, "high");
    assert.equal(reviews[0]?.date, "2026-11-02");
    assert.equal(
      reviews[0]?.minutes,
      REVIEW_MINUTES_PER_QUESTION,
    );

    const weakTheory = tasks.find(
      (task) => task.topicId === "t1" && task.kind === "theory",
    );

    assert.match(weakTheory?.reason ?? "", /Trefferquote 20 %/);
    assert.equal(weakTheory?.priority, "high");
  });

  it("ranks needs-revision topics from new mastery first", () => {
    const struggling = topic("t1", "Zinsrechnung", {
      mastery: "needs-revision",
    });
    const result = generateStudyPlans({
      exams: [exam("exam-1", "2026-11-10", ["t1", "t2"])],
      topics: [struggling, t2],
      questions: [],
      todayISO: TODAY,
    });
    const firstTheory = tasksOf(result, "exam-1").find(
      (task) => task.kind === "theory",
    );

    assert.equal(firstTheory?.topicId, "t1");
    assert.match(firstTheory?.reason ?? "", /Wiederholung/);
  });

  it("keeps exam plans independent of each other's stored state", () => {
    const withPlan = exam("exam-a", "2026-11-03", ["t1"], {
      documentIds: [],
      topicIds: ["t1"],
      availability: {
        weekly: [60, 60, 60, 60, 60, 0, 0],
        exceptions: {},
      },
      plan: {
        examId: "exam-a",
        generatedAt: "2026-10-30T10:00:00.000Z",
        inputsSignature: "old",
        deficitMinutes: 0,
        warnings: [],
        tasks: [
          {
            id: "pinned-a",
            date: "2026-11-02",
            kind: "theory",
            topicId: "t1",
            questionIds: [],
            minutes: 60,
            priority: "high",
            reason: "Angepinnt.",
            origin: "pinned",
            status: "open",
          },
        ],
      },
    });
    const bare = exam("exam-a", "2026-11-03", ["t1"]);
    const examB = exam("exam-b", "2026-11-10", ["t2"]);
    const totals = (plan: { tasks: { minutes: number }[]; deficitMinutes: number }) => ({
      scheduled: plan.tasks.reduce((sum, task) => sum + task.minutes, 0),
      deficit: plan.deficitMinutes,
    });
    const withStored = generateStudyPlans({
      exams: [withPlan, examB],
      topics: [t1, t2],
      questions: [],
      todayISO: TODAY,
    });
    const fresh = generateStudyPlans({
      exams: [bare, examB],
      topics: [t1, t2],
      questions: [],
      todayISO: TODAY,
    });

    // A's stored plan may shift shared-day timing, but B's own
    // need, completion, and deficit are per-exam and identical.
    const planBStored = withStored.plans.find(
      (plan) => plan.examId === "exam-b",
    );
    const planBFresh = fresh.plans.find((plan) => plan.examId === "exam-b");

    assert.ok(planBStored !== undefined && planBFresh !== undefined);
    assert.deepEqual(totals(planBStored), totals(planBFresh));
    assert.equal(planBStored.deficitMinutes, 0);
  });

  it("lets user priority win over the default order", () => {
    const important = topic("t1", "Zinsrechnung", {
      topicData: {
        concepts: ["a", "b"],
        formulas: [],
        examples: [],
        prerequisites: [],
        priority: "high",
      },
    });
    const result = generateStudyPlans({
      exams: [exam("exam-1", "2026-11-10", ["t1", "t2"])],
      topics: [important, t2],
      questions: [],
      todayISO: TODAY,
    });
    const theory = tasksOf(result, "exam-1").find(
      (task) => task.topicId === "t1" && task.kind === "theory",
    );

    assert.match(theory?.reason ?? "", /als wichtig markiert/);
    assert.equal(theory?.priority, "high");
  });

  it("schedules mocks in the final phase", () => {
    const result = generateStudyPlans({
      exams: [exam("exam-1", "2026-11-20", ["t1"])],
      topics: [t1],
      questions: [question({ id: "q1", topicId: "t1" })],
      todayISO: TODAY,
    });
    const mocks = tasksOf(result, "exam-1").filter(
      (task) => task.kind === "mock",
    );

    assert.equal(mocks.length, 1);
    assert.equal(mocks[0]?.minutes, MOCK_MINUTES);
    assert.deepEqual(mocks[0]?.questionIds, ["q1"]);

    const daysToExam =
      (new Date("2026-11-20").getTime() -
        new Date(`${mocks[0]?.date}T12:00:00Z`).getTime()) /
      86400000;

    assert.ok(daysToExam <= FINAL_PHASE_DAYS);
  });

  it("shares the pool across exams without double-booking", () => {
    const examA = exam("exam-a", "2026-11-03", ["t1"]);
    const examB = exam("exam-b", "2026-11-10", ["t2"], {
      documentIds: [],
      topicIds: ["t2"],
      availability: {
        weekly: [10, 10, 10, 10, 10, 0, 0],
        exceptions: {},
      },
    });
    const result = generateStudyPlans({
      exams: [examA, examB],
      topics: [t1, t2],
      questions: [],
      todayISO: TODAY,
    });

    for (const day of result.combined) {
      assert.ok(
        day.plannedMinutes <= day.poolMinutes,
        `${day.date}: double-booked`,
      );
    }

    // Sooner deadline first: A is fully scheduled on the shared day.
    const planA = result.plans.find((plan) => plan.examId === "exam-a");

    assert.equal(planA?.deficitMinutes, 0);

    const shared = result.combined.find((day) => day.date === "2026-11-02");

    assert.ok((shared?.plannedMinutes ?? 0) > 0);
    assert.ok(
      result.conflicts.some((conflict) => conflict.date === "2026-11-02"),
      "expected a visible contention conflict",
    );
  });

  it("reports deficits honestly instead of overbooking", () => {
    const starved = exam("exam-1", "2026-11-03", ["t1", "t2"], {
      documentIds: [],
      topicIds: ["t1", "t2"],
      availability: {
        weekly: [5, 5, 5, 5, 5, 0, 0],
        exceptions: {},
      },
    });
    const result = generateStudyPlans({
      exams: [starved],
      topics: [t1, t2],
      questions: [],
      todayISO: TODAY,
    });
    const plan = result.plans.find((entry) => entry.examId === "exam-1");

    assert.ok((plan?.deficitMinutes ?? 0) > 0);
    assert.ok(
      plan?.warnings.some((warning) => warning.includes("reicht nicht")),
    );

    for (const day of result.combined) {
      assert.ok(day.plannedMinutes <= day.poolMinutes);
    }
  });

  it("skips study time for mastered topics", () => {
    const result = generateStudyPlans({
      exams: [exam("exam-1", "2026-11-10", ["t1"])],
      topics: [topic("t1", "Zins", { mastery: "mastered" })],
      questions: [],
      todayISO: TODAY,
    });

    assert.deepEqual(tasksOf(result, "exam-1"), []);
  });

  it("is deterministic for identical inputs", () => {
    const args = {
      exams: [exam("exam-1", "2026-11-10", ["t1", "t2"])],
      topics: [t1, t2],
      questions: [question({ id: "q1", topicId: "t1", nextReviewAt: "2026-10-30" })],
      todayISO: TODAY,
    };
    const normalize = (result: ReturnType<typeof generateStudyPlans>) =>
      JSON.stringify(result, (key, value: unknown) =>
        key === "generatedAt" ? "ts" : value,
      );

    assert.equal(normalize(generateStudyPlans(args)), normalize(generateStudyPlans(args)));
  });

  it("keeps manual work and completions across recalculation", () => {
    const first = generateStudyPlans({
      exams: [exam("exam-1", "2026-11-10", ["t1"])],
      topics: [t1],
      questions: [],
      todayISO: TODAY,
    });
    const plan = first.plans.find((entry) => entry.examId === "exam-1");

    assert.ok(plan !== undefined && plan.tasks.length >= 2);

    const [doneTask, pinnedTask] = plan.tasks as [
      (typeof plan.tasks)[number],
      (typeof plan.tasks)[number],
    ];
    const stored: Entry = exam("exam-1", "2026-11-10", ["t1"], {
      documentIds: [],
      topicIds: ["t1"],
      availability: {
        weekly: [60, 60, 60, 60, 60, 0, 0],
        exceptions: {},
      },
      plan: {
        ...plan,
        tasks: [
          { ...doneTask, status: "done" },
          { ...pinnedTask, origin: "pinned" },
          {
            id: "manual-1",
            date: "2026-11-05",
            kind: "exercise",
            topicId: "t1",
            questionIds: [],
            minutes: 25,
            priority: "normal",
            reason: "Manuell hinzugefügt.",
            origin: "manual",
            status: "open",
          },
          {
            ...pinnedTask,
            id: "post-1",
            status: "postponed",
            postponedTo: "2026-11-06",
          },
        ],
      },
    });
    const second = generateStudyPlans({
      exams: [stored],
      topics: [t1],
      questions: [],
      todayISO: TODAY,
    });
    const tasks = tasksOf(second, "exam-1");
    const byId = new Map(tasks.map((task) => [task.id, task]));

    // Done record kept verbatim.
    assert.equal(byId.get(doneTask.id)?.status, "done");
    // Pinned slot kept verbatim.
    assert.deepEqual(byId.get(pinnedTask.id), {
      ...pinnedTask,
      origin: "pinned",
    });
    // Manual task kept.
    assert.ok(byId.has("manual-1"));
    // Postponed moved to its target date as open work.
    const moved = tasks.filter((task) =>
      task.reason.includes("Verschoben vom"),
    );

    assert.equal(moved.length, 1);
    assert.equal(moved[0]?.date, "2026-11-06");
    assert.equal(moved[0]?.status, "open");

    // Covered minutes are not scheduled twice: the only fresh
    // auto work is the moved postponed task.
    const freshAuto = tasks.filter(
      (task) => task.origin === "auto" && task.status === "open",
    );

    assert.equal(freshAuto.length, 1);
    assert.ok(freshAuto[0]?.reason.includes("Verschoben vom"));
  });

  it("warns on missing dates and unknown prerequisites", () => {
    const result = generateStudyPlans({
      exams: [entry({ id: "exam-x", title: "Ohne Datum" })],
      topics: [t2],
      questions: [],
      todayISO: TODAY,
    });
    const plan = result.plans.find((entry) => entry.examId === "exam-x");

    assert.deepEqual(plan?.tasks, []);
    assert.ok(
      plan?.warnings.some((warning) => warning.includes("Prüfungstermin")),
    );

    const prereq = generateStudyPlans({
      exams: [
        exam("exam-1", "2026-11-10", ["t2"], {
          documentIds: [],
          topicIds: ["t2"],
          availability: {
            weekly: [60, 60, 60, 60, 60, 0, 0],
            exceptions: {},
          },
        }),
      ],
      topics: [
        topic("t2", "Rentenrechnung", {
          topicData: {
            concepts: [],
            formulas: [],
            examples: [],
            prerequisites: ["Erfundenes Gebiet"],
          },
        }),
      ],
      questions: [],
      todayISO: TODAY,
    });

    assert.ok(
      prereq.plans[0]?.warnings.some((warning) =>
        warning.includes("Erfundenes Gebiet"),
      ),
    );
  });

  it("changes signature when inputs change", () => {
    const base = exam("exam-1", "2026-11-10", ["t1"]);
    const before = planInputsSignature(base, [t1], []);
    const changed = exam("exam-1", "2026-11-10", ["t1"], {
      documentIds: [],
      topicIds: ["t1"],
      availability: {
        weekly: [30, 30, 30, 30, 30, 0, 0],
        exceptions: {},
      },
    });

    assert.notEqual(
      planInputsSignature(changed, [t1], []),
      before,
    );
  });

  it("emits guard-valid plans", () => {
    const result = generateStudyPlans({
      exams: [exam("exam-1", "2026-11-10", ["t1", "t2"])],
      topics: [t1, t2],
      questions: [question({ id: "q1", topicId: "t1" })],
      todayISO: TODAY,
    });

    for (const plan of result.plans) {
      assert.ok(isStudyPlan(plan));
      assert.ok(
        isExamData({
          documentIds: [],
          topicIds: [],
          availability: {
            weekly: [60, 60, 60, 60, 60, 0, 0],
            exceptions: {},
          },
          plan,
        }),
      );
    }
  });
});
