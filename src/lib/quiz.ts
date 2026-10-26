/**
 * Manual practice questions. Created by the user only — no AI is
 * involved in this phase. Future AI-generated questions must be
 * labelled explicitly and never mixed in silently.
 */
export type QuizQuestion = {
  id: string;
  /** Subject title, consistent with `Entry.subject`. */
  subject: string;
  examId: number | null;
  topicId: number | null;
  question: string;
  /** At least two options; exactly one is correct. */
  options: string[];
  correctIndex: number;
  explanation: string;
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
    (item.examId === null || typeof item.examId === "number") &&
    (item.topicId === null || typeof item.topicId === "number") &&
    typeof item.question === "string" &&
    typeof item.correctIndex === "number" &&
    Number.isInteger(item.correctIndex) &&
    item.correctIndex >= 0 &&
    item.correctIndex < item.options.length &&
    typeof item.explanation === "string"
  );
}

export function isQuizQuestionList(value: unknown): value is QuizQuestion[] {
  return Array.isArray(value) && value.every(isQuizQuestion);
}
