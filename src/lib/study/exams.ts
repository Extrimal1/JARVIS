/**
 * Exam + subject management: availability math, upcoming-exam
 * ordering, and lossless rename/delete planners. Pure domain
 * logic — the study/quiz/document stores apply the returned
 * patches, identically in local and cloud mode. Deletion never
 * destroys documents, questions, or history: links are
 * reassigned or detached, and everything detached is reported.
 */

import { daysBetween } from "@/src/lib/briefing";
import {
  MAX_DAILY_MINUTES,
  type Entry,
  type ExamAvailability,
  type ExamData,
} from "@/src/lib/study";
import type { DocumentMeta } from "@/src/lib/documents";
import type { QuizQuestion } from "@/src/lib/quiz";

/** Default: one hour on weekdays, weekends off. */
export const DEFAULT_AVAILABILITY: ExamAvailability = {
  weekly: [60, 60, 60, 60, 60, 0, 0],
  exceptions: {},
};

export function defaultExamData(): ExamData {
  return {
    documentIds: [],
    topicIds: [],
    availability: {
      weekly: [...DEFAULT_AVAILABILITY.weekly] as ExamAvailability["weekly"],
      exceptions: {},
    },
  };
}

/** Fills a partial availability up to a valid full one. */
export function normalizeAvailability(
  value: Partial<ExamAvailability> | undefined,
): ExamAvailability {
  const weekly = [...DEFAULT_AVAILABILITY.weekly] as ExamAvailability["weekly"];

  if (value?.weekly !== undefined) {
    for (let day = 0; day < 7; day += 1) {
      const minutes = value.weekly[day];

      weekly[day] =
        typeof minutes === "number" &&
        Number.isInteger(minutes) &&
        minutes >= 0 &&
        minutes <= MAX_DAILY_MINUTES
          ? minutes
          : DEFAULT_AVAILABILITY.weekly[day] ?? 0;
    }
  }

  return { weekly, exceptions: { ...(value?.exceptions ?? {}) } };
}

/** Monday-based weekday index (Mon=0..Sun=6), null when invalid. */
function weekdayIndex(dateISO: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return null;

  const date = new Date(`${dateISO}T12:00:00Z`);

  if (Number.isNaN(date.getTime())) return null;

  return (date.getUTCDay() + 6) % 7;
}

/**
 * Study minutes for one date: per-date exceptions win (null =
 * day off), otherwise the weekday default. Unknown exams and
 * invalid dates yield 0 — never a crash, never a guess.
 */
export function minutesForDate(exam: Entry, dateISO: string): number {
  const availability = exam.examData?.availability;

  if (availability === undefined) {
    const fallback = weekdayIndex(dateISO);

    return fallback === null ? 0 : (DEFAULT_AVAILABILITY.weekly[fallback] ?? 0);
  }

  const exception = availability.exceptions[dateISO];

  if (exception !== undefined) return exception ?? 0;

  const day = weekdayIndex(dateISO);

  return day === null ? 0 : (availability.weekly[day] ?? 0);
}

/** German validation message, or null when the value is usable. */
export function validateAvailability(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return "Ungültige Verfügbarkeit.";
  }

  const availability = value as Record<string, unknown>;

  if (
    !Array.isArray(availability.weekly) ||
    availability.weekly.length !== 7 ||
    !availability.weekly.every(
      (minutes): minutes is number =>
        typeof minutes === "number" &&
        Number.isInteger(minutes) &&
        minutes >= 0 &&
        minutes <= MAX_DAILY_MINUTES,
    )
  ) {
    return "Jeder Wochentag braucht 0–720 Minuten.";
  }

  if (
    typeof availability.exceptions !== "object" ||
    availability.exceptions === null ||
    Array.isArray(availability.exceptions)
  ) {
    return "Ungültige Ausnahmen.";
  }

  for (const [date, minutes] of Object.entries(
    availability.exceptions as Record<string, unknown>,
  )) {
    if (
      weekdayIndex(date) === null ||
      (minutes !== null &&
        !(
          typeof minutes === "number" &&
          Number.isInteger(minutes) &&
          minutes >= 0 &&
          minutes <= MAX_DAILY_MINUTES
        ))
    ) {
      return `Ungültige Ausnahme: ${date}.`;
    }
  }

  return null;
}

export type UpcomingExam = {
  exam: Entry;
  /** Days until the exam; null when no date is set. */
  daysLeft: number | null;
};

/**
 * Exams ordered by date (soonest first, dateless last). Past
 * exams are included — the caller decides what to show.
 */
export function upcomingExams(
  exams: Entry[],
  todayISO: string,
): UpcomingExam[] {
  return exams
    .map((exam) => ({
      exam,
      daysLeft:
        exam.date === undefined ? null : daysBetween(todayISO, exam.date),
    }))
    .sort((a, b) => {
      if (a.daysLeft === null && b.daysLeft === null) return 0;
      if (a.daysLeft === null) return 1;
      if (b.daysLeft === null) return -1;

      return a.daysLeft - b.daysLeft;
    });
}

// ---------------------------------------------------------- subject plans

export type SubjectRenamePlan = {
  /** Subject row id → new title. */
  subjectId: string;
  toTitle: string;
  entryPatches: { id: string; subject: string }[];
  docPatches: { id: string; subject: string }[];
  questionPatches: { id: string; subject: string }[];
};

/**
 * Renames a subject across every title-linked record (subject
 * row, topics, exams, documents, questions). Titles stay the
 * linking key — the plan updates all of them at once.
 */
export function planSubjectRename(
  data: { subjects: Entry[]; exams: Entry[]; topics: Entry[] },
  docs: DocumentMeta[],
  questions: QuizQuestion[],
  fromTitle: string,
  toTitle: string,
):
  | { ok: true; plan: SubjectRenamePlan }
  | { ok: false; error: string } {
  const next = toTitle.trim();

  if (next === "") return { ok: false, error: "Der Name darf nicht leer sein." };

  const subject = data.subjects.find((entry) => entry.title === fromTitle);

  if (subject === undefined) {
    return { ok: false, error: "Fach nicht gefunden." };
  }

  if (
    data.subjects.some(
      (entry) => entry.id !== subject.id && entry.title === next,
    )
  ) {
    return { ok: false, error: "Ein Fach mit diesem Namen existiert bereits." };
  }

  if (next === fromTitle) {
    return {
      ok: true,
      plan: {
        subjectId: subject.id,
        toTitle: next,
        entryPatches: [],
        docPatches: [],
        questionPatches: [],
      },
    };
  }

  return {
    ok: true,
    plan: {
      subjectId: subject.id,
      toTitle: next,
      entryPatches: [...data.exams, ...data.topics]
        .filter((entry) => entry.subject === fromTitle)
        .map((entry) => ({ id: entry.id, subject: next })),
      docPatches: docs
        .filter((doc) => doc.subject === fromTitle)
        .map((doc) => ({ id: doc.id, subject: next })),
      questionPatches: questions
        .filter((question) => question.subject === fromTitle)
        .map((question) => ({ id: question.id, subject: next })),
    },
  };
}

export type SubjectDeletePlan = {
  subjectId: string;
  /** Documents/topics detached (subject cleared) when no target. */
  docPatches: { id: string; subject: string | null }[];
  entryPatches: { id: string; subject: string | null }[];
  /**
   * Questions require a subject title: reassigned when a target
   * is given, otherwise kept on the old title (never deleted).
   */
  questionPatches: { id: string; subject: string }[];
  keptQuestionIds: string[];
};

/**
 * Deletes a subject without destroying anything linked:
 * documents and topics move to the target subject (or detach),
 * questions move or keep their title as history. Exams keep
 * their rows; only their subject link follows the target.
 */
export function planSubjectDelete(
  data: { subjects: Entry[]; exams: Entry[]; topics: Entry[] },
  docs: DocumentMeta[],
  questions: QuizQuestion[],
  title: string,
  target: string | null,
):
  | { ok: true; plan: SubjectDeletePlan }
  | { ok: false; error: string } {
  const subject = data.subjects.find((entry) => entry.title === title);

  if (subject === undefined) {
    return { ok: false, error: "Fach nicht gefunden." };
  }

  const targetTitle = target === null ? null : target.trim();

  if (targetTitle !== null) {
    if (targetTitle === "") {
      return { ok: false, error: "Ungültiges Zielfach." };
    }

    if (
      targetTitle !== title &&
      !data.subjects.some((entry) => entry.title === targetTitle)
    ) {
      return { ok: false, error: "Zielfach nicht gefunden." };
    }
  }

  const moveTo = targetTitle === title ? null : targetTitle;
  const linkedQuestions = questions.filter(
    (question) => question.subject === title,
  );

  return {
    ok: true,
    plan: {
      subjectId: subject.id,
      docPatches: docs
        .filter((doc) => doc.subject === title)
        .map((doc) => ({ id: doc.id, subject: moveTo })),
      entryPatches: [...data.exams, ...data.topics]
        .filter((entry) => entry.subject === title)
        .map((entry) => ({ id: entry.id, subject: moveTo })),
      questionPatches:
        moveTo === null
          ? []
          : linkedQuestions.map((question) => ({
              id: question.id,
              subject: moveTo,
            })),
      keptQuestionIds:
        moveTo === null ? linkedQuestions.map((question) => question.id) : [],
    },
  };
}

// ------------------------------------------------------------- exam plans

/**
 * Deletes an exam: linked questions keep their rows and history,
 * only the exam link is cleared. Topics and documents are
 * untouched (they link by subject, not by exam).
 */
export function planExamDelete(
  questions: QuizQuestion[],
  examId: string,
): { id: string; examId: null }[] {
  return questions
    .filter((question) => question.examId === examId)
    .map((question) => ({ id: question.id, examId: null }));
}

export type ExamLinkCheck = {
  unknownDocuments: string[];
  unknownTopics: string[];
};

/**
 * Client-side precheck for exam links (fast feedback before
 * saving). The server re-validates ownership authoritatively —
 * this never replaces the server check.
 */
export function checkExamLinks(
  examData: ExamData,
  docs: { id: string }[],
  topics: Entry[],
): ExamLinkCheck {
  const docIds = new Set(docs.map((doc) => doc.id));
  const topicIds = new Set(topics.map((topic) => topic.id));

  return {
    unknownDocuments: [...new Set(examData.documentIds)].filter(
      (id) => !docIds.has(id),
    ),
    unknownTopics: [...new Set(examData.topicIds)].filter(
      (id) => !topicIds.has(id),
    ),
  };
}

/** Topics + documents reachable for one exam (subject scope). */
export function examCandidates(
  exam: Entry,
  docs: DocumentMeta[],
  topics: Entry[],
): { docs: DocumentMeta[]; topics: Entry[] } {
  if (exam.subject === undefined || exam.subject === "") {
    return { docs: [...docs], topics: [...topics] };
  }

  return {
    docs: docs.filter((doc) => doc.subject === exam.subject),
    topics: topics.filter((topic) => topic.subject === exam.subject),
  };
}
