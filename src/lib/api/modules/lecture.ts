import {
  dbGetOne,
  type DbClient,
} from "@/src/lib/supabase/db";
import {
  pickPatch,
  requireId,
  type CheckResult,
  type CrudConfig,
} from "../crud";

// ------------------------------------------------------------------ sessions

export type SessionMeta = {
  id: string;
  courseId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
};

function isSessionMeta(value: unknown): value is SessionMeta {
  if (typeof value !== "object" || value === null) return false;

  const row = value as Record<string, unknown>;

  return (
    typeof row.id === "string" &&
    row.id !== "" &&
    (row.courseId === null || typeof row.courseId === "string") &&
    typeof row.title === "string" &&
    typeof row.createdAt === "string" &&
    typeof row.updatedAt === "string"
  );
}

function sessionToDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    courseId: (row.course_id as string | null) ?? null,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function courseOwned(
  db: DbClient,
  courseId: string | null | undefined,
): Promise<boolean> {
  if (courseId === null || courseId === undefined) return true;

  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "study_entries",
    courseId,
  );

  return row !== null;
}

export const sessionsConfig: CrudConfig = {
  table: "lecture_sessions",
  order: "updated_at.desc",
  toDomain: sessionToDomain,
  isList: (value: unknown): value is unknown[] =>
    Array.isArray(value) && value.every(isSessionMeta),
  checkCreate: async (db, body) => {
    if (typeof body !== "object" || body === null || requireId(body) === null) {
      return { message: "Ungültige Sitzung." };
    }

    const record = body as Record<string, unknown>;

    if (typeof record.title !== "string" || record.title.trim() === "") {
      return { message: "Ungültige Sitzung." };
    }

    const courseId =
      record.courseId === null || record.courseId === undefined
        ? null
        : typeof record.courseId === "string"
          ? record.courseId
          : undefined;

    if (courseId === undefined || !(await courseOwned(db, courseId))) {
      return { message: "Unbekanntes Fach." };
    }

    return {
      row: {
        id: record.id,
        course_id: courseId,
        title: record.title.trim(),
      },
    };
  },
  checkUpdate: async (db, patch, existing): Promise<CheckResult> => {
    const picked = pickPatch(patch, ["title", "courseId"]);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isSessionMeta(merged) || merged.title.trim() === "") {
      return { message: "Ungültige Änderung." };
    }

    if (!(await courseOwned(db, merged.courseId))) {
      return { message: "Unbekanntes Fach." };
    }

    return {
      row: {
        title: merged.title.trim(),
        course_id: merged.courseId,
      },
    };
  },
};

// ---------------------------------------------------------------- recordings

const RECORDING_STATUSES = [
  "recording",
  "saved_locally",
  "queued",
  "uploading",
  "uploaded",
  "transcribing",
  "analyzing",
  "ready",
  "failed",
] as const;

const UPLOAD_STATES = ["local", "queued", "uploading", "uploaded", "failed"] as const;

const PROCESSING_STATES = [
  "pending",
  "transcribing",
  "analyzing",
  "ready",
  "failed",
] as const;

const LANGUAGES = ["de", "en", "uk"] as const;

export type RecordingMeta = {
  id: string;
  sessionId: string | null;
  courseId: string | null;
  title: string;
  language: string;
  durationSeconds: number;
  audioStoragePath: string;
  audioSha256: string;
  fileSizeBytes: number;
  status: string;
  uploadState: string;
  processingState: string;
  errorCode: string;
  localRetained: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

function isRecordingMeta(value: unknown): value is RecordingMeta {
  if (typeof value !== "object" || value === null) return false;

  const row = value as Record<string, unknown>;

  return (
    typeof row.id === "string" &&
    row.id !== "" &&
    (row.sessionId === null || typeof row.sessionId === "string") &&
    (row.courseId === null || typeof row.courseId === "string") &&
    typeof row.title === "string" &&
    typeof row.language === "string" &&
    typeof row.durationSeconds === "number" &&
    typeof row.audioStoragePath === "string" &&
    typeof row.audioSha256 === "string" &&
    typeof row.fileSizeBytes === "number" &&
    typeof row.status === "string" &&
    typeof row.uploadState === "string" &&
    typeof row.processingState === "string" &&
    typeof row.errorCode === "string" &&
    typeof row.localRetained === "boolean" &&
    typeof row.createdAt === "string" &&
    typeof row.updatedAt === "string" &&
    (row.deletedAt === null || typeof row.deletedAt === "string")
  );
}

function recordingToDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    sessionId: (row.session_id as string | null) ?? null,
    courseId: (row.course_id as string | null) ?? null,
    title: row.title,
    language: row.language,
    durationSeconds: row.duration_seconds,
    audioStoragePath: row.audio_storage_path,
    audioSha256: row.audio_sha256,
    fileSizeBytes: row.file_size_bytes,
    status: row.status,
    uploadState: row.upload_state,
    processingState: row.processing_state,
    errorCode: row.error_code,
    localRetained: row.local_retained,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: (row.deleted_at as string | null) ?? null,
  };
}

async function sessionOwned(
  db: DbClient,
  sessionId: string | null | undefined,
): Promise<boolean> {
  if (sessionId === null || sessionId === undefined) return true;

  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "lecture_sessions",
    sessionId,
  );

  return row !== null;
}

function validEnums(item: {
  language: string;
  status: string;
  uploadState: string;
  processingState: string;
}): boolean {
  return (
    (LANGUAGES as readonly string[]).includes(item.language) &&
    (RECORDING_STATUSES as readonly string[]).includes(item.status) &&
    (UPLOAD_STATES as readonly string[]).includes(item.uploadState) &&
    (PROCESSING_STATES as readonly string[]).includes(item.processingState)
  );
}

const RECORDING_PATCH_KEYS = [
  "sessionId",
  "courseId",
  "title",
  "language",
  "durationSeconds",
  "audioStoragePath",
  "audioSha256",
  "fileSizeBytes",
  "status",
  "uploadState",
  "processingState",
  "errorCode",
  "localRetained",
  "deletedAt",
] as const;

export const recordingsConfig: CrudConfig = {
  table: "lecture_recordings",
  order: "created_at.desc",
  toDomain: recordingToDomain,
  isList: (value: unknown): value is unknown[] =>
    Array.isArray(value) && value.every(isRecordingMeta),
  checkCreate: async (db, body) => {
    if (typeof body !== "object" || body === null || requireId(body) === null) {
      return { message: "Ungültige Aufnahme." };
    }

    const record = body as Record<string, unknown>;
    const sessionId =
      record.sessionId === null || record.sessionId === undefined
        ? null
        : typeof record.sessionId === "string"
          ? record.sessionId
          : undefined;
    const courseId =
      record.courseId === null || record.courseId === undefined
        ? null
        : typeof record.courseId === "string"
          ? record.courseId
          : undefined;

    if (
      typeof record.title !== "string" ||
      record.title.trim() === "" ||
      sessionId === undefined ||
      courseId === undefined ||
      typeof record.language !== "string" ||
      !(LANGUAGES as readonly string[]).includes(record.language)
    ) {
      return { message: "Ungültige Aufnahme." };
    }

    if (
      !(await sessionOwned(db, sessionId)) ||
      !(await courseOwned(db, courseId))
    ) {
      return { message: "Unbekannte Sitzung oder unbekanntes Fach." };
    }

    return {
      row: {
        id: record.id,
        session_id: sessionId,
        course_id: courseId,
        title: record.title.trim(),
        language: record.language,
        duration_seconds:
          typeof record.durationSeconds === "number" &&
          Number.isFinite(record.durationSeconds) &&
          record.durationSeconds >= 0
            ? Math.floor(record.durationSeconds)
            : 0,
        audio_storage_path:
          typeof record.audioStoragePath === "string"
            ? record.audioStoragePath
            : "",
        audio_sha256:
          typeof record.audioSha256 === "string" ? record.audioSha256 : "",
        file_size_bytes:
          typeof record.fileSizeBytes === "number" &&
          Number.isInteger(record.fileSizeBytes) &&
          record.fileSizeBytes >= 0
            ? record.fileSizeBytes
            : 0,
      },
    };
  },
  checkUpdate: async (db, patch, existing): Promise<CheckResult> => {
    const picked = pickPatch(patch, RECORDING_PATCH_KEYS);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isRecordingMeta(merged)) {
      return { message: "Ungültige Änderung." };
    }

    if (!validEnums(merged)) {
      return { message: "Ungültiger Status." };
    }

    if (merged.title.trim() === "") {
      return { message: "Ungültige Änderung." };
    }

    if (
      merged.durationSeconds < 0 ||
      !Number.isFinite(merged.durationSeconds) ||
      merged.fileSizeBytes < 0 ||
      !Number.isInteger(merged.fileSizeBytes)
    ) {
      return { message: "Ungültige Änderung." };
    }

    if (
      !(await sessionOwned(db, merged.sessionId)) ||
      !(await courseOwned(db, merged.courseId))
    ) {
      return { message: "Unbekannte Sitzung oder unbekanntes Fach." };
    }

    return {
      row: {
        session_id: merged.sessionId,
        course_id: merged.courseId,
        title: merged.title.trim(),
        language: merged.language,
        duration_seconds: Math.floor(merged.durationSeconds),
        audio_storage_path: merged.audioStoragePath,
        audio_sha256: merged.audioSha256,
        file_size_bytes: merged.fileSizeBytes,
        status: merged.status,
        upload_state: merged.uploadState,
        processing_state: merged.processingState,
        error_code: merged.errorCode,
        local_retained: merged.localRetained,
        deleted_at: merged.deletedAt,
      },
    };
  },
};
