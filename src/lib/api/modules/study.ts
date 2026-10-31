import { parseISODateLocal } from "@/src/lib/calendar";
import {
  isEntry,
  isExamData,
  isMasteryEvidence,
  isTopicData,
  isTopicMastery,
  isTopicSourceRefList,
  type Entry,
} from "@/src/lib/study";
import { dbGetOne, type DbClient } from "@/src/lib/supabase/db";
import {
  pickPatch,
  requireId,
  type CheckResult,
  type CrudConfig,
} from "../crud";

export const STUDY_SECTIONS = [
  "subjects",
  "exams",
  "topics",
  "materials",
] as const;

export type StudySection = (typeof STUDY_SECTIONS)[number];

export function isStudySection(value: unknown): value is StudySection {
  return (
    typeof value === "string" &&
    (STUDY_SECTIONS as readonly string[]).includes(value)
  );
}

export type StudyRow = Entry & { section: StudySection };

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0
  );
}

/** Stricter than the shared isEntry: optional fields are type-checked. */
function isValidEntry(value: unknown): value is Entry {
  if (!isEntry(value)) return false;

  const item = value as Record<string, unknown>;

  if (
    item.detail !== undefined &&
    item.detail !== null &&
    typeof item.detail !== "string"
  ) {
    return false;
  }

  if (
    item.date !== undefined &&
    !(typeof item.date === "string" && parseISODateLocal(item.date) !== null)
  ) {
    return false;
  }

  if (item.subject !== undefined && typeof item.subject !== "string") {
    return false;
  }

  if (item.done !== undefined && typeof item.done !== "boolean") {
    return false;
  }

  if (
    item.reviewStage !== undefined &&
    !isNonNegativeInt(item.reviewStage)
  ) {
    return false;
  }

  if (
    item.lastReviewedAt !== undefined &&
    !(
      typeof item.lastReviewedAt === "string" &&
      parseISODateLocal(item.lastReviewedAt) !== null
    )
  ) {
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

function toDomain(row: Record<string, unknown>): unknown {
  const entry: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    detail: row.detail ?? "",
    section: row.section,
  };

  if (typeof row.date === "string") entry.date = row.date;
  if (typeof row.subject === "string") entry.subject = row.subject;
  if (typeof row.done === "boolean") entry.done = row.done;
  if (isNonNegativeInt(row.review_stage)) {
    entry.reviewStage = row.review_stage;
  }
  if (typeof row.last_reviewed_at === "string") {
    entry.lastReviewedAt = row.last_reviewed_at;
  }
  if (typeof row.parent_id === "string") {
    entry.parentId = row.parent_id;
  }
  if (isTopicSourceRefList(row.source_refs) && row.source_refs.length > 0) {
    entry.sourceRefs = row.source_refs;
  }
  if (isTopicMastery(row.mastery) && row.mastery !== "not-started") {
    entry.mastery = row.mastery;
  }
  if (isMasteryEvidence(row.mastery_evidence)) {
    entry.masteryEvidence = row.mastery_evidence;
  }
  if (isTopicData(row.topic_data)) {
    entry.topicData = row.topic_data;
  }
  if (isExamData(row.exam_data)) {
    entry.examData = row.exam_data;
  }

  return entry;
}

function isRowList(value: unknown): value is StudyRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        isStudySection((item as Record<string, unknown>).section) &&
        isValidEntry(item),
    )
  );
}

function toDbRow(section: StudySection, entry: Entry): Record<string, unknown> {
  return {
    id: entry.id,
    section,
    title: entry.title,
    detail: entry.detail ?? "",
    date: entry.date ?? null,
    subject: entry.subject ?? null,
    done: entry.done ?? null,
    review_stage: entry.reviewStage ?? null,
    last_reviewed_at: entry.lastReviewedAt ?? null,
    parent_id: entry.parentId ?? null,
    source_refs: entry.sourceRefs ?? [],
    mastery: entry.mastery ?? "not-started",
    mastery_evidence: entry.masteryEvidence ?? {},
    topic_data: entry.topicData ?? {},
    exam_data: entry.examData ?? {},
  };
}

/**
 * Every linked record must exist and be owned by the caller
 * (the RLS-scoped client returns null for foreign rows, so a
 * missing row and a foreign row fail identically). Exam links
 * and topic parents are validated; anything else links by
 * free-text title and needs no lookup.
 */
async function checkLinks(
  db: DbClient,
  section: StudySection,
  entry: Entry,
): Promise<string | null> {
  if (section === "exams" && entry.examData !== undefined) {
    for (const documentId of entry.examData.documentIds) {
      const doc = await dbGetOne<Record<string, unknown>>(
        db,
        "study_documents",
        documentId,
      );

      if (doc === null) {
        return "Unbekannte Dokumentverknüpfung.";
      }
    }

    for (const topicId of entry.examData.topicIds) {
      const topic = await dbGetOne<Record<string, unknown>>(
        db,
        "study_entries",
        topicId,
      );

      if (topic === null || topic.section !== "topics") {
        return "Unbekannte Themenverknüpfung.";
      }
    }
  }

  if (
    section === "topics" &&
    entry.parentId !== undefined &&
    entry.parentId !== null
  ) {
    const parent = await dbGetOne<Record<string, unknown>>(
      db,
      "study_entries",
      entry.parentId,
    );

    if (parent === null || parent.section !== "topics") {
      return "Unbekanntes übergeordnetes Thema.";
    }
  }

  return null;
}

export const studyConfig: CrudConfig = {
  table: "study_entries",
  order: "created_at.asc",
  toDomain,
  isList: isRowList,
  checkCreate: async (db, body) => {
    if (typeof body !== "object" || body === null) {
      return { message: "Ungültiger Eintrag." };
    }

    const record = body as Record<string, unknown>;

    if (!isStudySection(record.section)) {
      return { message: "Unbekannter Studienbereich." };
    }

    if (!isValidEntry(body) || requireId(body) === null) {
      return { message: "Ungültiger Eintrag." };
    }

    const links = await checkLinks(db, record.section, body as Entry);

    if (links !== null) {
      return { message: links };
    }

    return { row: toDbRow(record.section, body as Entry) };
  },
  checkUpdate: async (db, patch, existing): Promise<CheckResult> => {
    const picked = pickPatch(patch, [
      "title",
      "detail",
      "date",
      "subject",
      "done",
      "reviewStage",
      "lastReviewedAt",
      "parentId",
      "sourceRefs",
      "mastery",
      "masteryEvidence",
      "topicData",
      "examData",
    ]);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    // Explicit null clears an optional field.
    const normalized: Record<string, unknown> = { ...picked };

    for (const key of ["date", "subject", "done", "reviewStage", "lastReviewedAt"]) {
      if (normalized[key] === null) {
        normalized[key] = undefined;
      }
    }

    const current = existing as Record<string, unknown>;
    const merged = { ...current, ...normalized };

    if (typeof current.section !== "string" || !isStudySection(current.section)) {
      return { message: "Ungültige Änderung." };
    }

    if (!isValidEntry(merged)) {
      return { message: "Ungültige Änderung." };
    }

    const links = await checkLinks(
      db,
      current.section as StudySection,
      merged as unknown as Entry,
    );

    if (links !== null) {
      return { message: links };
    }

    const row = toDbRow(current.section, merged as unknown as Entry);
    delete row.id;
    delete row.section;

    return { row };
  },
};
