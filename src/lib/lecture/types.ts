/**
 * Lecture Intelligence: local-first types (Phase D).
 * Recordings live in IndexedDB until upload/sync (Phase H) confirms them.
 * No audio ever leaves the browser in this phase.
 */

export type RecordingStatus = "recording" | "saved_locally" | "failed";

export type LectureLanguage = "de" | "en" | "uk";

export const LECTURE_LANGUAGES: { code: LectureLanguage; label: string }[] = [
  { code: "de", label: "Deutsch" },
  { code: "en", label: "Englisch" },
  { code: "uk", label: "Ukrainisch" },
];

export const RECORDING_STATUS_LABELS: Record<RecordingStatus, string> = {
  recording: "Nimmt auf",
  saved_locally: "Lokal gespeichert",
  failed: "Fehlgeschlagen",
};

export type LectureSession = {
  id: string;
  courseId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type LocalRecording = {
  id: string;
  sessionId: string | null;
  courseId: string | null;
  title: string;
  language: LectureLanguage;
  mimeType: string;
  durationSeconds: number;
  sizeBytes: number;
  sha256: string;
  status: RecordingStatus;
  errorCode: string;
  /** ISO timestamp of the consent confirmation, null when missing. */
  consentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isIsoString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function isLectureLanguage(value: unknown): value is LectureLanguage {
  return value === "de" || value === "en" || value === "uk";
}

export function isRecordingStatus(value: unknown): value is RecordingStatus {
  return (
    value === "recording" || value === "saved_locally" || value === "failed"
  );
}

export function isLectureSession(value: unknown): value is LectureSession {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    (value.courseId === null || typeof value.courseId === "string") &&
    typeof value.title === "string" &&
    isIsoString(value.createdAt) &&
    isIsoString(value.updatedAt)
  );
}

export function isLectureSessionList(value: unknown): value is LectureSession[] {
  return Array.isArray(value) && value.every(isLectureSession);
}

export function isLocalRecording(value: unknown): value is LocalRecording {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    (value.sessionId === null || typeof value.sessionId === "string") &&
    (value.courseId === null || typeof value.courseId === "string") &&
    typeof value.title === "string" &&
    isLectureLanguage(value.language) &&
    typeof value.mimeType === "string" &&
    typeof value.durationSeconds === "number" &&
    Number.isFinite(value.durationSeconds) &&
    value.durationSeconds >= 0 &&
    typeof value.sizeBytes === "number" &&
    Number.isInteger(value.sizeBytes) &&
    value.sizeBytes >= 0 &&
    typeof value.sha256 === "string" &&
    isRecordingStatus(value.status) &&
    typeof value.errorCode === "string" &&
    (value.consentAt === null || isIsoString(value.consentAt)) &&
    isIsoString(value.createdAt) &&
    isIsoString(value.updatedAt)
  );
}

export function isLocalRecordingList(
  value: unknown,
): value is LocalRecording[] {
  return Array.isArray(value) && value.every(isLocalRecording);
}

/** Format seconds as H:MM:SS or M:SS for the recording timer. */
export function formatDuration(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
  const ss = String(seconds).padStart(2, "0");

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
