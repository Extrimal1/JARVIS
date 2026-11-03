import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { authed } from "@/src/lib/api/withAuth";
import {
  transcriptionStatusFromEnv,
  workerAuthHeaders,
} from "@/src/lib/lecture/transcription";

/**
 * POST /api/lecture/transcribe — multipart proxy to the transcription
 * worker (LECTURE_WORKER_URL). Fields: `audio` (blob), `language`
 * ("de"|"en"|"uk"), `recordingId` (string). Requires login in cloud
 * mode (user audio is user data). Without a configured worker the
 * route answers 503 with setup instructions — never a fake transcript.
 */

const WORKER_TIMEOUT_MS = 120_000;
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;

type WorkerTranscript = {
  recordingId?: unknown;
  language?: unknown;
  fullText?: unknown;
  segments?: unknown;
};

function shapeTranscript(
  payload: WorkerTranscript,
  recordingId: string,
  language: string,
): {
  recordingId: string;
  language: string;
  fullText: string;
  segments: { start: number; end: number; text: string }[];
  transcribedAt: string;
} | null {
  if (typeof payload.fullText !== "string" || payload.fullText === "") {
    return null;
  }

  const segments = Array.isArray(payload.segments)
    ? payload.segments.flatMap((segment) => {
        if (typeof segment !== "object" || segment === null) return [];

        const entry = segment as Record<string, unknown>;

        return typeof entry.start === "number" &&
          typeof entry.end === "number" &&
          typeof entry.text === "string"
          ? [{ start: entry.start, end: entry.end, text: entry.text }]
          : [];
      })
    : [];

  return {
    recordingId:
      typeof payload.recordingId === "string" && payload.recordingId !== ""
        ? payload.recordingId
        : recordingId,
    language:
      typeof payload.language === "string" && payload.language !== ""
        ? payload.language
        : language,
    fullText: payload.fullText,
    segments,
    transcribedAt: new Date().toISOString(),
  };
}

export const POST = authed(async (request) => {
  try {
    const status = transcriptionStatusFromEnv(
      process.env.LECTURE_WORKER_URL ?? null,
    );

    if (!status.configured) {
      return fail("worker-unavailable", status.reason, 503);
    }

    const form = await request.formData().catch(() => null);
    const audio = form?.get("audio");
    const language = form?.get("language");
    const recordingId = form?.get("recordingId");

    if (!(audio instanceof Blob) || audio.size === 0) {
      return fail("bad-request", "Keine Audiodatei übertragen.", 400);
    }

    if (audio.size > MAX_AUDIO_BYTES) {
      return fail("bad-request", "Audiodatei ist zu groß (max. 512 MB).", 400);
    }

    if (language !== "de" && language !== "en" && language !== "uk") {
      return fail("bad-request", "Unbekannte Sprache (de/en/uk erwartet).", 400);
    }

    if (typeof recordingId !== "string" || recordingId === "") {
      return fail("bad-request", "recordingId fehlt.", 400);
    }

    const upstream = new FormData();
    upstream.set("audio", audio);
    upstream.set("language", language);
    upstream.set("recordingId", recordingId);

    let res: Response;

    try {
      res = await fetch(`${status.workerUrl}/transcribe`, {
        method: "POST",
        body: upstream,
        headers: workerAuthHeaders(process.env.LECTURE_WORKER_TOKEN),
        signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
      });
    } catch {
      return fail(
        "upstream-error",
        "Transkriptionsdienst nicht erreichbar. Läuft der Worker?",
        502,
      );
    }

    if (!res.ok) {
      return fail(
        "upstream-error",
        `Transkription fehlgeschlagen (HTTP ${res.status}).`,
        502,
      );
    }

    const payload = (await res.json().catch(
      () => null,
    )) as WorkerTranscript | null;

    if (payload === null) {
      return fail(
        "upstream-error",
        "Der Transkriptionsdienst lieferte keine lesbare Antwort.",
        502,
      );
    }

    const transcript = shapeTranscript(payload, recordingId, language);

    if (transcript === null) {
      return fail(
        "upstream-error",
        "Der Transkriptionsdienst lieferte kein gültiges Transkript.",
        502,
      );
    }

    return ok(transcript);
  } catch (unknown) {
    return failFromUnknown("lecture/transcribe", unknown);
  }
});

export function __shapeTranscriptForTests(
  payload: WorkerTranscript,
  recordingId: string,
  language: string,
) {
  return shapeTranscript(payload, recordingId, language);
}
