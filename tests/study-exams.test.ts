import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkExamLinks,
  defaultExamData,
  examCandidates,
  minutesForDate,
  normalizeAvailability,
  planExamDelete,
  planSubjectDelete,
  planSubjectRename,
  upcomingExams,
  validateAvailability,
  DEFAULT_AVAILABILITY,
} from "@/src/lib/study/exams";
import type { Entry, ExamData } from "@/src/lib/study";
import type { DocumentMeta } from "@/src/lib/documents";
import type { QuizQuestion } from "@/src/lib/quiz";

function entry(overrides: Partial<Entry> = {}): Entry {
  return { id: "e1", title: "Eintrag", detail: "", ...overrides };
}

function doc(overrides: Partial<DocumentMeta> = {}): DocumentMeta {
  return {
    id: "d1",
    name: "Skript.pdf",
    mimeType: "application/pdf",
    size: 10,
    kind: "pdf",
    subject: null,
    description: "",
    uploadedAt: "2026-10-01T10:00:00.000Z",
    extractionStatus: "completed",
    ...overrides,
  };
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

function examData(overrides: Partial<ExamData> = {}): ExamData {
  return { ...defaultExamData(), ...overrides };
}

describe("availability", () => {
  it("defaults to weekday hours with weekends off", () => {
    assert.deepEqual(DEFAULT_AVAILABILITY.weekly, [60, 60, 60, 60, 60, 0, 0]);
    assert.equal(minutesForDate(entry(), "2026-11-02"), 60); // Monday
    assert.equal(minutesForDate(entry(), "2026-11-01"), 0); // Sunday
  });

  it("reads weekday minutes and exceptions", () => {
    const exam = entry({
      examData: examData({
        availability: {
          weekly: [30, 30, 30, 30, 30, 90, 90],
          exceptions: { "2026-11-02": 120, "2026-11-03": null },
        },
      }),
    });

    assert.equal(minutesForDate(exam, "2026-11-02"), 120);
    assert.equal(minutesForDate(exam, "2026-11-03"), 0);
    assert.equal(minutesForDate(exam, "2026-11-04"), 30);
    assert.equal(minutesForDate(exam, "2026-11-07"), 90);
  });

  it("returns 0 for invalid dates, never throws", () => {
    assert.equal(minutesForDate(entry(), "kein-datum"), 0);
    assert.equal(minutesForDate(entry(), "2026-13-40"), 0);
  });

  it("normalizes partial availability", () => {
    assert.deepEqual(normalizeAvailability(undefined), DEFAULT_AVAILABILITY);
    assert.deepEqual(
      normalizeAvailability({ weekly: [10, 10, 10, 10, 10, 10, 10] }).weekly,
      [10, 10, 10, 10, 10, 10, 10],
    );
    assert.equal(
      normalizeAvailability({ weekly: [10, -5, 99999, 10, 10, 10, 10] })
        .weekly[1],
      60,
    );
  });

  it("validates availability with German messages", () => {
    assert.equal(validateAvailability(DEFAULT_AVAILABILITY), null);
    assert.equal(
      validateAvailability({ weekly: [60], exceptions: {} }),
      "Jeder Wochentag braucht 0–720 Minuten.",
    );
    assert.equal(
      validateAvailability({
        weekly: [60, 60, 60, 60, 60, 0, 0],
        exceptions: { "morgen": 30 },
      }),
      "Ungültige Ausnahme: morgen.",
    );
  });
});

describe("upcomingExams", () => {
  it("orders by date with dateless last", () => {
    const ordered = upcomingExams(
      [
        entry({ id: "a", date: "2026-12-01" }),
        entry({ id: "b" }),
        entry({ id: "c", date: "2026-11-05" }),
        entry({ id: "d", date: "2026-10-20" }),
      ],
      "2026-10-31",
    );

    assert.deepEqual(
      ordered.map((item) => item.exam.id),
      ["d", "c", "a", "b"],
    );
    assert.deepEqual(
      ordered.map((item) => item.daysLeft),
      [-11, 5, 31, null],
    );
  });
});

describe("planSubjectRename", () => {
  const data = {
    subjects: [entry({ id: "s1", title: "Mathe" })],
    exams: [entry({ id: "e1", title: "Klausur", subject: "Mathe" })],
    topics: [entry({ id: "t1", title: "Zins", subject: "Mathe" })],
  };
  const docs = [doc({ id: "d1", subject: "Mathe" })];
  const questions = [question({ id: "q1", subject: "Mathe" })];

  it("cascades the new title everywhere", () => {
    const renamed = planSubjectRename(data, docs, questions, "Mathe", "Mathematik");

    assert.equal(renamed.ok, true);

    if (!renamed.ok) return;

    assert.equal(renamed.plan.subjectId, "s1");
    assert.deepEqual(renamed.plan.entryPatches, [
      { id: "e1", subject: "Mathematik" },
      { id: "t1", subject: "Mathematik" },
    ]);
    assert.deepEqual(renamed.plan.docPatches, [
      { id: "d1", subject: "Mathematik" },
    ]);
    assert.deepEqual(renamed.plan.questionPatches, [
      { id: "q1", subject: "Mathematik" },
    ]);
  });

  it("rejects clashes, blanks, and unknown subjects", () => {
    const withOther = {
      ...data,
      subjects: [...data.subjects, entry({ id: "s2", title: "Physik" })],
    };

    assert.deepEqual(
      planSubjectRename(withOther, docs, questions, "Mathe", "Physik"),
      { ok: false, error: "Ein Fach mit diesem Namen existiert bereits." },
    );
    assert.deepEqual(
      planSubjectRename(data, docs, questions, "Mathe", "  "),
      { ok: false, error: "Der Name darf nicht leer sein." },
    );
    assert.deepEqual(
      planSubjectRename(data, docs, questions, "Bio", "Biologie"),
      { ok: false, error: "Fach nicht gefunden." },
    );
  });

  it("is a no-op for identical titles", () => {
    const same = planSubjectRename(data, docs, questions, "Mathe", "Mathe");

    assert.equal(same.ok, true);

    if (!same.ok) return;

    assert.deepEqual(same.plan.entryPatches, []);
    assert.deepEqual(same.plan.docPatches, []);
  });
});

describe("planSubjectDelete", () => {
  const data = {
    subjects: [
      entry({ id: "s1", title: "Mathe" }),
      entry({ id: "s2", title: "Physik" }),
    ],
    exams: [entry({ id: "e1", title: "Klausur", subject: "Mathe" })],
    topics: [entry({ id: "t1", title: "Zins", subject: "Mathe" })],
  };
  const docs = [doc({ id: "d1", subject: "Mathe" })];
  const questions = [question({ id: "q1", subject: "Mathe" })];

  it("reassigns everything to the target subject", () => {
    const deleted = planSubjectDelete(data, docs, questions, "Mathe", "Physik");

    assert.equal(deleted.ok, true);

    if (!deleted.ok) return;

    assert.equal(deleted.plan.subjectId, "s1");
    assert.deepEqual(deleted.plan.docPatches, [
      { id: "d1", subject: "Physik" },
    ]);
    assert.deepEqual(deleted.plan.entryPatches, [
      { id: "e1", subject: "Physik" },
      { id: "t1", subject: "Physik" },
    ]);
    assert.deepEqual(deleted.plan.questionPatches, [
      { id: "q1", subject: "Physik" },
    ]);
    assert.deepEqual(deleted.plan.keptQuestionIds, []);
  });

  it("detaches links but keeps questions without a target", () => {
    const deleted = planSubjectDelete(data, docs, questions, "Mathe", null);

    assert.equal(deleted.ok, true);

    if (!deleted.ok) return;

    assert.deepEqual(deleted.plan.docPatches, [{ id: "d1", subject: null }]);
    assert.deepEqual(deleted.plan.entryPatches, [
      { id: "e1", subject: null },
      { id: "t1", subject: null },
    ]);
    assert.deepEqual(deleted.plan.questionPatches, []);
    assert.deepEqual(deleted.plan.keptQuestionIds, ["q1"]);
  });

  it("rejects unknown subjects and targets", () => {
    assert.deepEqual(
      planSubjectDelete(data, docs, questions, "Bio", null),
      { ok: false, error: "Fach nicht gefunden." },
    );
    assert.deepEqual(
      planSubjectDelete(data, docs, questions, "Mathe", "Bio"),
      { ok: false, error: "Zielfach nicht gefunden." },
    );
  });
});

describe("planExamDelete", () => {
  it("clears only that exam's question links", () => {
    const patches = planExamDelete(
      [
        question({ id: "q1", examId: "exam-1" }),
        question({ id: "q2", examId: "exam-2" }),
        question({ id: "q3", examId: null }),
      ],
      "exam-1",
    );

    assert.deepEqual(patches, [{ id: "q1", examId: null }]);
  });
});

describe("checkExamLinks", () => {
  it("reports unknown documents and topics", () => {
    assert.deepEqual(
      checkExamLinks(
        examData({ documentIds: ["d1", "dx"], topicIds: ["t1", "tx"] }),
        [doc({ id: "d1" })],
        [entry({ id: "t1" })],
      ),
      { unknownDocuments: ["dx"], unknownTopics: ["tx"] },
    );
    assert.deepEqual(
      checkExamLinks(examData(), [doc({ id: "d1" })], [entry({ id: "t1" })]),
      { unknownDocuments: [], unknownTopics: [] },
    );
  });
});

describe("examCandidates", () => {
  it("scopes candidates by exam subject", () => {
    const exam = entry({ subject: "Mathe" });
    const scoped = examCandidates(
      exam,
      [doc({ id: "d1", subject: "Mathe" }), doc({ id: "d2", subject: "Physik" })],
      [entry({ id: "t1", subject: "Mathe" }), entry({ id: "t2" })],
    );

    assert.deepEqual(
      scoped.docs.map((d) => d.id),
      ["d1"],
    );
    assert.deepEqual(
      scoped.topics.map((t) => t.id),
      ["t1"],
    );

    const unscoped = examCandidates(
      entry(),
      [doc({ id: "d1" })],
      [entry({ id: "t1" })],
    );

    assert.equal(unscoped.docs.length, 1);
    assert.equal(unscoped.topics.length, 1);
  });
});
