/**
 * Lecture transcription integration point.
 *
 * Jarvis ships WITHOUT a bundled transcription engine: audio stays local
 * in the browser (IndexedDB) and no transcript is ever fabricated. When
 * `LECTURE_WORKER_URL` points at a transcription worker, the lecture UI
 * offers upload + transcription through this interface; otherwise it
 * explains exactly what is missing. The worker contract is intentionally
 * narrow so any Whisper-compatible backend can implement it.
 */

export type TranscriptionStatus =
  | { configured: true; workerUrl: string }
  | { configured: false; reason: string };

export type TranscriptSegment = {
  /** Seconds from the recording start. */
  start: number;
  end: number;
  text: string;
};

export type Transcript = {
  recordingId: string;
  language: string;
  segments: TranscriptSegment[];
  /** Full plain-text transcript (segments joined). */
  fullText: string;
  transcribedAt: string;
};

export const TRANSCRIPTION_UNAVAILABLE_REASON =
  "Kein Transkriptionsdienst konfiguriert. Lege LECTURE_WORKER_URL in der Server-Umgebung an, um Audio zur Transkription an einen eigenen Worker zu senden — ohne Worker bleibt alles lokal und es wird kein (gefälschtes) Transkript angezeigt.";

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * Resolve the transcription status from the runtime environment.
 * Pure: the caller passes the env value so server and client can share
 * the logic (client reads it from GET /api/health or /api/lecture/*).
 */
export function transcriptionStatusFromEnv(
  workerUrl: string | undefined | null,
): TranscriptionStatus {
  if (workerUrl === undefined || workerUrl === null) {
    return { configured: false, reason: TRANSCRIPTION_UNAVAILABLE_REASON };
  }

  const normalized = normalizeUrl(workerUrl);

  if (normalized === "") {
    return { configured: false, reason: TRANSCRIPTION_UNAVAILABLE_REASON };
  }

  if (!/^https?:\/\//.test(normalized)) {
    return {
      configured: false,
      reason: `LECTURE_WORKER_URL ist ungültig („${workerUrl}“): erwartet wird eine http(s)-URL.`,
    };
  }

  return { configured: true, workerUrl: normalized };
}

/**
 * Auth headers for worker calls. Pure: the caller passes the env value.
 * Returns undefined when no token is configured (open/local worker).
 */
export function workerAuthHeaders(
  token: string | undefined | null,
): Record<string, string> | undefined {
  const trimmed = (token ?? "").trim();

  return trimmed === ""
    ? undefined
    : { Authorization: `Bearer ${trimmed}` };
}

/**
 * Minimal worker contract. Implementations POST multipart audio to
 * `{workerUrl}/transcribe` with fields `audio` (blob), `language`
 * (BCP-47-ish, e.g. "de"), and `recordingId`; they answer JSON shaped
 * like `Transcript` (without `transcribedAt`, which the client stamps).
 */
export type TranscriptionEngine = {
  status: TranscriptionStatus;
  transcribe: (input: {
    audio: Blob;
    recordingId: string;
    language: string;
    signal?: AbortSignal;
  }) => Promise<Transcript>;
};

export function isTranscript(value: unknown): value is Transcript {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.recordingId === "string" &&
    typeof item.language === "string" &&
    typeof item.fullText === "string" &&
    typeof item.transcribedAt === "string" &&
    Array.isArray(item.segments) &&
    item.segments.every((segment) => {
      if (typeof segment !== "object" || segment === null) return false;

      const entry = segment as Record<string, unknown>;

      return (
        typeof entry.start === "number" &&
        typeof entry.end === "number" &&
        typeof entry.text === "string"
      );
    })
  );
}
