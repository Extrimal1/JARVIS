/**
 * Practice questions. Manual questions are created by the user;
 * AI-generated questions come from grounded document generation
 * and MUST carry `source: "ai"` — never mixed in silently.
 */
export type QuestionKind = "single" | "multiple" | "free";

/** Origin label: absent means "manual" (all pre-AI records). */
export type QuestionSource = "manual" | "ai";

/**
 * Spaced-repetition state per question. Absent means "new".
 * "new" → reviewed at least once → "learning" → streak ≥ 2 →
 * "review" → streak ≥ 4 → "mastered".
 */
export type QuizReviewStatus = "new" | "learning" | "review" | "mastered";

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
  /** Source document id for AI-generated questions. */
  documentId?: string | null;
  /** Absent means "manual" (all pre-AI records). */
  source?: QuestionSource;
  /** Page/section labels the question was grounded in. */
  sourceRefs?: string[];
  /** Last review as YYYY-MM-DD (absent/null = never reviewed). */
  lastReviewedAt?: string | null;
  /** Next due date as YYYY-MM-DD (absent/null = due now). */
  nextReviewAt?: string | null;
  /** Total completed reviews. */
  reviewCount?: number;
  /** Total successful reviews (cumulative, never reset). */
  successCount?: number;
  /** Consecutive successful reviews (reset on failure). */
  streak?: number;
  /** Last self-reported difficulty, 1 (again) … 5 (easy). */
  difficulty?: number;
  /** Absent means "new" (all pre-AI records). */
  reviewStatus?: QuizReviewStatus;
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
      typeof item.gradingCriteria === "string") &&
    (item.documentId === undefined ||
      item.documentId === null ||
      typeof item.documentId === "string") &&
    (item.source === undefined ||
      item.source === "manual" ||
      item.source === "ai") &&
    (item.sourceRefs === undefined || isStringList(item.sourceRefs)) &&
    (item.lastReviewedAt === undefined ||
      item.lastReviewedAt === null ||
      typeof item.lastReviewedAt === "string") &&
    (item.nextReviewAt === undefined ||
      item.nextReviewAt === null ||
      typeof item.nextReviewAt === "string") &&
    (item.reviewCount === undefined ||
      (typeof item.reviewCount === "number" &&
        Number.isInteger(item.reviewCount) &&
        item.reviewCount >= 0)) &&
    (item.successCount === undefined ||
      (typeof item.successCount === "number" &&
        Number.isInteger(item.successCount) &&
        item.successCount >= 0)) &&
    (item.streak === undefined ||
      (typeof item.streak === "number" &&
        Number.isInteger(item.streak) &&
        item.streak >= 0)) &&
    (item.difficulty === undefined ||
      (typeof item.difficulty === "number" &&
        Number.isInteger(item.difficulty) &&
        item.difficulty >= 1 &&
        item.difficulty <= 5)) &&
    (item.reviewStatus === undefined ||
      item.reviewStatus === "new" ||
      item.reviewStatus === "learning" ||
      item.reviewStatus === "review" ||
      item.reviewStatus === "mastered")
  );
}

export function isQuizQuestionList(value: unknown): value is QuizQuestion[] {
  return Array.isArray(value) && value.every(isQuizQuestion);
}
