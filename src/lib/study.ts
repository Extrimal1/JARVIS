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
};

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

  return typeof item.id === "string" && typeof item.title === "string";
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
