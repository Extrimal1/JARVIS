import {
  isQuizQuestion,
  isQuizQuestionList,
  type QuizQuestion,
} from "@/src/lib/quiz";
import { dbGetOne } from "@/src/lib/supabase/db";
import {
  pickPatch,
  requireId,
  type CheckResult,
  type CrudConfig,
} from "../crud";

function toDomain(row: Record<string, unknown>): unknown {
  const item: Record<string, unknown> = {
    id: row.id,
    subject: row.subject ?? "",
    examId: row.exam_id ?? null,
    topicId: row.topic_id ?? null,
    question: row.question,
    options: row.options,
    correctIndex: row.correct_index,
    explanation: row.explanation ?? "",
    kind: row.kind ?? "single",
  };

  if (Array.isArray(row.correct_indices)) {
    item.correctIndices = row.correct_indices;
  }

  if (typeof row.grading_criteria === "string" && row.grading_criteria !== "") {
    item.gradingCriteria = row.grading_criteria;
  }

  return item;
}

/**
 * A referenced exam/topic must exist AND belong to the same user,
 * otherwise the write is rejected (never 404-oracle the id: a missing
 * row and a foreign row both fail validation the same way).
 */
async function referencesOwned(
  db: Parameters<CrudConfig["checkCreate"]>[0],
  examId: string | null,
  topicId: string | null,
): Promise<boolean> {
  for (const [id, section] of [
    [examId, "exams"],
    [topicId, "topics"],
  ] as const) {
    if (id === null) continue;

    const row = await dbGetOne<Record<string, unknown>>(
      db,
      "study_entries",
      id,
    );

    if (row === null || row.section !== section) {
      return false;
    }
  }

  return true;
}

function toDbRow(item: QuizQuestion): Record<string, unknown> {
  return {
    id: item.id,
    subject: item.subject,
    exam_id: item.examId,
    topic_id: item.topicId,
    question: item.question,
    options: item.options,
    correct_index: item.correctIndex,
    explanation: item.explanation,
    kind: item.kind ?? "single",
    correct_indices: item.correctIndices ?? null,
    grading_criteria: item.gradingCriteria ?? "",
  };
}

export const quizConfig: CrudConfig = {
  table: "quiz_questions",
  order: "created_at.asc",
  toDomain,
  isList: isQuizQuestionList,
  checkCreate: async (db, body) => {
    if (!isQuizQuestion(body) || requireId(body) === null) {
      return { message: "Ungültige Frage." };
    }

    const item = body as QuizQuestion;

    if (!(await referencesOwned(db, item.examId, item.topicId))) {
      return { message: "Verknüpfte Prüfung oder Thema existiert nicht." };
    }

    return { row: toDbRow(item) };
  },
  checkUpdate: async (db, patch, existing): Promise<CheckResult> => {
    const picked = pickPatch(patch, [
      "subject",
      "examId",
      "topicId",
      "question",
      "options",
      "correctIndex",
      "explanation",
      "kind",
      "correctIndices",
      "gradingCriteria",
    ]);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isQuizQuestion(merged)) {
      return { message: "Ungültige Änderung." };
    }

    const item = merged as unknown as QuizQuestion;

    if (!(await referencesOwned(db, item.examId, item.topicId))) {
      return { message: "Verknüpfte Prüfung oder Thema existiert nicht." };
    }

    const row = toDbRow(item);
    delete row.id;

    return { row };
  },
};
