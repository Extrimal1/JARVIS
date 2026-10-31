export type Entry = {
  id: string;
  title: string;
  detail: string;
  date?: string;
  subject?: string;
  done?: boolean;
  /**
   * Revision tracking for learning topics. Optional so records saved
   * before this phase stay valid: absent means "never reviewed".
   * reviewStage counts completed reviews; lastReviewedAt is YYYY-MM-DD.
   */
  reviewStage?: number;
  lastReviewedAt?: string;
  /**
   * Topic-tree parent (another topic id) or null for roots. Absent
   * means "manual topic without tree position".
   */
  parentId?: string | null;
  /** Grounded source locations merged across documents. */
  sourceRefs?: TopicSourceRef[];
  /**
   * Evidence-based mastery. Absent means "not-started". Only quiz
   * performance, practice, and review history may advance this —
   * reading or generating a summary never does.
   */
  mastery?: TopicMastery;
  /** Quiz/review evidence behind the current mastery level. */
  masteryEvidence?: MasteryEvidence;
  /** Structured extraction payload (concepts, formulas, …). */
  topicData?: TopicData;
  /**
   * Exam preparation state (exams only): linked documents/topics
   * plus the flexible availability. Absent = no links, default
   * availability. Each exam row owns its state — exams never
   * share or overwrite each other's preparation.
   */
  examData?: ExamData;
};

/** Weekly minutes per weekday (Mon..Sun) + per-date exceptions. */
export type ExamAvailability = {
  weekly: [number, number, number, number, number, number, number];
  /** YYYY-MM-DD → minutes, null = day off. */
  exceptions: Record<string, number | null>;
};

export type ExamData = {
  documentIds: string[];
  topicIds: string[];
  availability: ExamAvailability;
  /** Stored study plan (4D-3); null/absent = never generated. */
  plan?: StudyPlan | null;
};

export type PlanTaskKind = "theory" | "exercise" | "quiz" | "review" | "mock";

export type PlanTaskPriority = "high" | "normal" | "low";

export type PlanTaskOrigin = "auto" | "manual" | "pinned";

export type PlanTaskStatus = "open" | "done" | "skipped" | "postponed";

export type PlanTask = {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  kind: PlanTaskKind;
  topicId: string | null;
  questionIds: string[];
  minutes: number;
  priority: PlanTaskPriority;
  /** German explanation of why this task was scheduled. */
  reason: string;
  origin: PlanTaskOrigin;
  status: PlanTaskStatus;
  /** Target date when postponed (YYYY-MM-DD). */
  postponedTo?: string;
};

export type StudyPlan = {
  examId: string;
  /** ISO datetime of generation. */
  generatedAt: string;
  /** Input signature — mismatch means the plan is stale. */
  inputsSignature: string;
  /** Unscheduled minutes (honest deficit, never overbooked). */
  deficitMinutes: number;
  warnings: string[];
  tasks: PlanTask[];
};

/** Max links per exam (keeps rows small and checks bounded). */
export const MAX_EXAM_LINKS = 200;

/** Max study minutes per day (sanity cap, not a recommendation). */
export const MAX_DAILY_MINUTES = 12 * 60;

function isDayMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_DAILY_MINUTES
  );
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isExamAvailability(value: unknown): value is ExamAvailability {
  if (typeof value !== "object" || value === null) return false;

  const availability = value as Record<string, unknown>;

  if (!Array.isArray(availability.weekly) || availability.weekly.length !== 7) {
    return false;
  }

  if (!availability.weekly.every(isDayMinutes)) return false;

  if (
    typeof availability.exceptions !== "object" ||
    availability.exceptions === null ||
    Array.isArray(availability.exceptions)
  ) {
    return false;
  }

  return Object.entries(
    availability.exceptions as Record<string, unknown>,
  ).every(
    ([date, minutes]) =>
      DATE_KEY.test(date) &&
      (minutes === null || isDayMinutes(minutes)),
  );
}

export function isExamData(value: unknown): value is ExamData {
  if (typeof value !== "object" || value === null) return false;

  const data = value as Record<string, unknown>;

  return (
    Array.isArray(data.documentIds) &&
    data.documentIds.length <= MAX_EXAM_LINKS &&
    data.documentIds.every(
      (id): id is string => typeof id === "string" && id !== "",
    ) &&
    Array.isArray(data.topicIds) &&
    data.topicIds.length <= MAX_EXAM_LINKS &&
    data.topicIds.every(
      (id): id is string => typeof id === "string" && id !== "",
    ) &&
    isExamAvailability(data.availability) &&
    (data.plan === undefined ||
      data.plan === null ||
      isStudyPlan(data.plan))
  );
}

const PLAN_KINDS: readonly string[] = [
  "theory",
  "exercise",
  "quiz",
  "review",
  "mock",
];

const PLAN_PRIORITIES: readonly string[] = ["high", "normal", "low"];

const PLAN_ORIGINS: readonly string[] = ["auto", "manual", "pinned"];

const PLAN_STATUSES: readonly string[] = ["open", "done", "skipped", "postponed"];

export function isPlanTask(value: unknown): value is PlanTask {
  if (typeof value !== "object" || value === null) return false;

  const task = value as Record<string, unknown>;

  return (
    typeof task.id === "string" &&
    task.id !== "" &&
    typeof task.date === "string" &&
    DATE_KEY.test(task.date) &&
    typeof task.kind === "string" &&
    PLAN_KINDS.includes(task.kind) &&
    (task.topicId === null || typeof task.topicId === "string") &&
    Array.isArray(task.questionIds) &&
    task.questionIds.every((id): id is string => typeof id === "string") &&
    typeof task.minutes === "number" &&
    Number.isInteger(task.minutes) &&
    task.minutes > 0 &&
    typeof task.priority === "string" &&
    PLAN_PRIORITIES.includes(task.priority) &&
    typeof task.reason === "string" &&
    typeof task.origin === "string" &&
    PLAN_ORIGINS.includes(task.origin) &&
    typeof task.status === "string" &&
    PLAN_STATUSES.includes(task.status) &&
    (task.postponedTo === undefined ||
      (typeof task.postponedTo === "string" && DATE_KEY.test(task.postponedTo)))
  );
}

export function isStudyPlan(value: unknown): value is StudyPlan {
  if (typeof value !== "object" || value === null) return false;

  const plan = value as Record<string, unknown>;

  return (
    typeof plan.examId === "string" &&
    typeof plan.generatedAt === "string" &&
    typeof plan.inputsSignature === "string" &&
    typeof plan.deficitMinutes === "number" &&
    Number.isInteger(plan.deficitMinutes) &&
    plan.deficitMinutes >= 0 &&
    Array.isArray(plan.warnings) &&
    plan.warnings.every((entry): entry is string => typeof entry === "string") &&
    Array.isArray(plan.tasks) &&
    plan.tasks.length <= 2000 &&
    plan.tasks.every(isPlanTask)
  );
}

/** Structured topic content merged across extraction runs. */
export type TopicData = {
  concepts: string[];
  formulas: { text: string; variables: string[] }[];
  examples: string[];
  prerequisites: string[];
  /** User-defined importance (absent = normal). */
  priority?: "high" | "normal" | "low";
};

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item): item is string => typeof item === "string")
  );
}

export function isTopicData(value: unknown): value is TopicData {
  if (typeof value !== "object" || value === null) return false;

  const data = value as Record<string, unknown>;

  return (
    isStringList(data.concepts) &&
    Array.isArray(data.formulas) &&
    data.formulas.every((formula) => {
      if (typeof formula !== "object" || formula === null) return false;

      const record = formula as Record<string, unknown>;

      return (
        typeof record.text === "string" && isStringList(record.variables)
      );
    }) &&
    isStringList(data.examples) &&
    isStringList(data.prerequisites) &&
    (data.priority === undefined ||
      data.priority === "high" ||
      data.priority === "normal" ||
      data.priority === "low")
  );
};

/** One grounded source location of a topic. */
export type TopicSourceRef = {
  documentId: string;
  label: string;
};

export type TopicMastery =
  | "not-started"
  | "learning"
  | "needs-revision"
  | "understood"
  | "mastered";

export type MasteryEvidence = {
  /**
   * Recent quiz accuracy 0..1 (last attempts), null when no quiz
   * attempts yet. Recency-weighted: old results fade out.
   */
  quizAccuracy: number | null;
  /** Total answered questions behind this evidence. */
  reviews: number;
  /** Last evidence update as ISO datetime, null when never. */
  ratedAt: string | null;
  /** Composite score 0..100 (null = insufficient evidence). */
  score?: number | null;
  /** German explanation lines for the current level. */
  reasons?: string[];
  /** Question kinds attempted (breadth signal). */
  kinds?: string[];
};

export const TOPIC_MASTERIES: readonly TopicMastery[] = [
  "not-started",
  "learning",
  "needs-revision",
  "understood",
  "mastered",
];

export function isTopicMastery(value: unknown): value is TopicMastery {
  return (
    typeof value === "string" &&
    (TOPIC_MASTERIES as readonly string[]).includes(value)
  );
}

export function isTopicSourceRef(value: unknown): value is TopicSourceRef {
  if (typeof value !== "object" || value === null) return false;

  const ref = value as Record<string, unknown>;

  return (
    typeof ref.documentId === "string" &&
    ref.documentId !== "" &&
    typeof ref.label === "string" &&
    ref.label !== ""
  );
}

export function isTopicSourceRefList(
  value: unknown,
): value is TopicSourceRef[] {
  return Array.isArray(value) && value.every(isTopicSourceRef);
}

export function isMasteryEvidence(value: unknown): value is MasteryEvidence {
  if (typeof value !== "object" || value === null) return false;

  const evidence = value as Record<string, unknown>;

  return (
    (evidence.quizAccuracy === null ||
      (typeof evidence.quizAccuracy === "number" &&
        evidence.quizAccuracy >= 0 &&
        evidence.quizAccuracy <= 1)) &&
    typeof evidence.reviews === "number" &&
    Number.isInteger(evidence.reviews) &&
    evidence.reviews >= 0 &&
    (evidence.ratedAt === null || typeof evidence.ratedAt === "string") &&
    (evidence.score === undefined ||
      evidence.score === null ||
      (typeof evidence.score === "number" &&
        evidence.score >= 0 &&
        evidence.score <= 100)) &&
    (evidence.reasons === undefined ||
      (Array.isArray(evidence.reasons) &&
        evidence.reasons.every(
          (entry): entry is string => typeof entry === "string",
        ))) &&
    (evidence.kinds === undefined ||
      (Array.isArray(evidence.kinds) &&
        evidence.kinds.every(
          (entry): entry is string => typeof entry === "string",
        )))
  );
}

export type StudyData = {
  subjects: Entry[];
  exams: Entry[];
  topics: Entry[];
  materials: Entry[];
};

export const STUDY_STORAGE_KEY = "jarvis-study";

/** Shared empty initial value (never mutated; the storage hook replaces it). */
export const EMPTY_STUDY: StudyData = {
  subjects: [],
  exams: [],
  topics: [],
  materials: [],
};

export function isEntry(value: unknown): value is Entry {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  if (typeof item.id !== "string" || typeof item.title !== "string") {
    return false;
  }

  if (
    item.parentId !== undefined &&
    item.parentId !== null &&
    typeof item.parentId !== "string"
  ) {
    return false;
  }

  if (
    item.sourceRefs !== undefined &&
    !isTopicSourceRefList(item.sourceRefs)
  ) {
    return false;
  }

  if (item.mastery !== undefined && !isTopicMastery(item.mastery)) {
    return false;
  }

  if (
    item.masteryEvidence !== undefined &&
    !isMasteryEvidence(item.masteryEvidence)
  ) {
    return false;
  }

  if (item.topicData !== undefined && !isTopicData(item.topicData)) {
    return false;
  }

  if (item.examData !== undefined && !isExamData(item.examData)) {
    return false;
  }

  return true;
}

export function isEntryList(value: unknown): value is Entry[] {
  return Array.isArray(value) && value.every(isEntry);
}

export function isStudyData(value: unknown): value is StudyData {
  if (typeof value !== "object" || value === null) return false;

  const data = value as Record<string, unknown>;

  return (
    isEntryList(data.subjects) &&
    isEntryList(data.exams) &&
    isEntryList(data.topics) &&
    isEntryList(data.materials)
  );
}
