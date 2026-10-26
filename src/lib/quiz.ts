/**
 * Manual practice questions. Created by the user only — no AI is
 * involved in this phase. Future AI-generated questions must be
 * labelled explicitly and never mixed in silently.
 */
export type QuestionKind = "single" | "multiple" | "free";

export type QuizQuestion = {
  id: string;
  /** Subject title, consistent with `Entry.subject`. */
  subject: string;
  examId: string | null;
  topicId: string | null;
  question: string;
  /** At least two options; exactly one is correct. */
  options: string[];
  correctIndex: number;
  explanation: string;
  /** Absent means "single" (all pre-cloud records). */
  kind?: QuestionKind;
  /** Used when kind is "multiple". */
  correctIndices?: number[];
  /** Used when kind is "free". */
  gradingCriteria?: string;
};

export const QUIZ_STORAGE_KEY = "jarvis-quiz";

/** Shared empty initial value (never mutated; the storage hook replaces it). */
export const EMPTY_QUIZ: QuizQuestion[] = [];

/**
 * Stable unique id. Twin of the document id helper (kept local so the
 * quiz module does not depend on the document storage module).
 */
export function createQuizId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  );
}

export function isQuizQuestion(value: unknown): value is QuizQuestion {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  if (!isStringList(item.options) || item.options.length < 2) return false;

  return (
    typeof item.id === "string" &&
    item.id !== "" &&
    typeof item.subject === "string" &&
    (item.examId === null || typeof item.examId === "string") &&
    (item.topicId === null || typeof item.topicId === "string") &&
    typeof item.question === "string" &&
    typeof item.correctIndex === "number" &&
    Number.isInteger(item.correctIndex) &&
    item.correctIndex >= 0 &&
    item.correctIndex < item.options.length &&
    typeof item.explanation === "string" &&
    (item.kind === undefined ||
      item.kind === "single" ||
      item.kind === "multiple" ||
      item.kind === "free") &&
    (item.correctIndices === undefined ||
      (Array.isArray(item.correctIndices) &&
        item.correctIndices.every(
          (index): index is number =>
            typeof index === "number" && Number.isInteger(index),
        ))) &&
    (item.gradingCriteria === undefined ||
      typeof item.gradingCriteria === "string")
  );
}

export function isQuizQuestionList(value: unknown): value is QuizQuestion[] {
  return Array.isArray(value) && value.every(isQuizQuestion);
}
