import {
  isQuizQuestion,
  isQuizQuestionList,
  type QuizQuestion,
  type QuizReviewStatus,
} from "@/src/lib/quiz";
import { dbGetOne } from "@/src/lib/supabase/db";
import {
  pickPatch,
  requireId,
  type CheckResult,
  type CrudConfig,
} from "../crud";

function countOr(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : fallback;
}

function difficultyOr(value: unknown, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 5
    ? value
    : fallback;
}

function reviewStatusOr(
  value: unknown,
  fallback: QuizReviewStatus,
): QuizReviewStatus {
  return value === "new" ||
    value === "learning" ||
    value === "review" ||
    value === "mastered"
    ? value
    : fallback;
}

export function quizRowToDomain(row: Record<string, unknown>): unknown {
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
    documentId: row.document_id ?? null,
    source: row.source ?? "manual",
    sourceRefs: Array.isArray(row.source_refs)
      ? row.source_refs.filter(
          (ref): ref is string => typeof ref === "string",
        )
      : [],
    lastReviewedAt: row.last_reviewed_at ?? null,
    nextReviewAt: row.next_review_at ?? null,
    reviewCount: countOr(row.review_count, 0),
    successCount: countOr(row.success_count, 0),
    streak: countOr(row.streak, 0),
    difficulty: difficultyOr(row.difficulty, 3),
    reviewStatus: reviewStatusOr(row.review_status, "new"),
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
 * A referenced exam/topic/document must exist AND belong to the same
 * user, otherwise the write is rejected (never 404-oracle the id: a
 * missing row and a foreign row both fail validation the same way).
 */
async function referencesOwned(
  db: Parameters<CrudConfig["checkCreate"]>[0],
  examId: string | null,
  topicId: string | null,
  documentId: string | null | undefined,
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

  if (documentId !== undefined && documentId !== null) {
    const doc = await dbGetOne<Record<string, unknown>>(
      db,
      "study_documents",
      documentId,
    );

    if (doc === null) {
      return false;
    }
  }

  return true;
}

export function quizToDbRow(item: QuizQuestion): Record<string, unknown> {
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
    document_id: item.documentId ?? null,
    source: item.source ?? "manual",
    source_refs: item.sourceRefs ?? [],
    last_reviewed_at: item.lastReviewedAt ?? null,
    next_review_at: item.nextReviewAt ?? null,
    review_count: item.reviewCount ?? 0,
    success_count: item.successCount ?? 0,
    streak: item.streak ?? 0,
    difficulty: item.difficulty ?? 3,
    review_status: item.reviewStatus ?? "new",
  };
}

export const quizConfig: CrudConfig = {
  table: "quiz_questions",
  order: "created_at.asc",
  toDomain: quizRowToDomain,
  isList: isQuizQuestionList,
  checkCreate: async (db, body) => {
    if (!isQuizQuestion(body) || requireId(body) === null) {
      return { message: "Ungültige Frage." };
    }

    const item = body as QuizQuestion;

    if (
      !(await referencesOwned(
        db,
        item.examId,
        item.topicId,
        item.documentId,
      ))
    ) {
      return { message: "Verknüpfte Prüfung, Thema oder Dokument existiert nicht." };
    }

    return { row: quizToDbRow(item) };
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
      "documentId",
      "source",
      "sourceRefs",
      "lastReviewedAt",
      "nextReviewAt",
      "reviewCount",
      "successCount",
      "streak",
      "difficulty",
      "reviewStatus",
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

    if (
      !(await referencesOwned(
        db,
        item.examId,
        item.topicId,
        item.documentId,
      ))
    ) {
      return { message: "Verknüpfte Prüfung, Thema oder Dokument existiert nicht." };
    }

    const row = quizToDbRow(item);
    delete row.id;

    return { row };
  },
};
