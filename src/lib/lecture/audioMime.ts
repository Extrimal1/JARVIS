/**
 * Lecture audio MIME plumbing (shared by recorder, recovery, and player).
 *
 * The browser decides the real container/codec of a MediaRecorder
 * recording — this module only observes and records that decision.
 * It never invents a container: when the browser reports nothing,
 * the helpers return "" (unknown) and callers fall back to the
 * chunk-declared type or byte sniffing instead of hardcoding webm.
 *
 * Pure functions only (no DOM side effects) so the regression tests
 * can exercise them under Node.
 */

/** Ordered candidates for MediaRecorder construction ("" = default). */
export const RECORD_MIME_CANDIDATES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
  "",
];

/** Pick the best MediaRecorder MIME type, "" when unknown/unsupported. */
export function pickRecordingMimeType(): string {
  if (
    typeof window === "undefined" ||
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return "";
  }

  for (const candidate of RECORD_MIME_CANDIDATES) {
    if (candidate === "") return "";

    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return "";
}

/** Strip codec parameters: "audio/webm;codecs=opus" -> "audio/webm". */
export function baseMimeType(mime: string): string {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";

  return base;
}

/** Honest file extension for a MIME type (never invents a container). */
export function extensionForMimeType(mime: string): string {
  switch (baseMimeType(mime)) {
    case "audio/webm":
      return ".webm";
    case "audio/mp4":
    case "audio/x-m4a":
      return ".m4a";
    case "audio/ogg":
      return ".ogg";
    case "audio/opus":
      return ".opus";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return ".wav";
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    case "audio/aac":
    case "audio/aacp":
      return ".aac";
    case "audio/3gpp":
      return ".3gp";
    case "audio/flac":
      return ".flac";
    case "":
      return ".bin";
    default:
      return ".bin";
  }
}

export type ChunkVerdict = { keep: boolean; reason: "ok" | "missing" | "empty" };

/**
 * Chunk admission verdict. Only zero-byte/missing payloads are dropped,
 * and the caller counts them visibly instead of discarding silently.
 */
export function classifyChunk(data: Blob | null | undefined): ChunkVerdict {
  if (data === null || data === undefined) return { keep: false, reason: "missing" };
  if (data.size === 0) return { keep: false, reason: "empty" };

  return { keep: true, reason: "ok" };
}

/**
 * Resolve the honest container type for a finalized recording.
 * Priority: live recorder report > first chunk-declared type >
 * start-of-recording metadata > "" (unknown browser default).
 */
export function resolveFinalMimeType(input: {
  metaMime: string;
  recorderMime: string;
  chunkTypes: Array<string | undefined>;
}): string {
  if (input.recorderMime !== "") return input.recorderMime;

  for (const type of input.chunkTypes) {
    if (type !== undefined && type !== "") return type;
  }

  return input.metaMime;
}

/** Assemble the final audio Blob from collected chunks (keeps all). */
export function buildFinalAudio(chunks: Blob[], type: string): Blob {
  return new Blob(chunks, { type });
}

/** True when the stored blob declares a different container than metadata. */
export function blobTypeMismatch(blob: Blob, metaMime: string): boolean {
  if (blob.type === "" || metaMime === "") return false;

  return baseMimeType(blob.type) !== baseMimeType(metaMime);
}

/**
 * Detect an audio container from its first bytes. Returns "" when
 * the header is unknown (caller keeps the declared type then).
 */
export function sniffAudioMimeType(header: Uint8Array): string {
  if (header.length >= 12) {
    // WAV: "RIFF" .... "WAVE".
    if (
      header[0] === 0x52 &&
      header[1] === 0x49 &&
      header[2] === 0x46 &&
      header[3] === 0x46 &&
      header[8] === 0x57 &&
      header[9] === 0x41 &&
      header[10] === 0x56 &&
      header[11] === 0x45
    ) {
      return "audio/wav";
    }
    // MP4/M4A: "....ftyp".
    if (
      header[4] === 0x66 &&
      header[5] === 0x74 &&
      header[6] === 0x79 &&
      header[7] === 0x70
    ) {
      return "audio/mp4";
    }
  }

  if (header.length >= 4) {
    // Ogg (Vorbis/Opus).
    if (
      header[0] === 0x4f &&
      header[1] === 0x67 &&
      header[2] === 0x67 &&
      header[3] === 0x53
    ) {
      return "audio/ogg";
    }
    // EBML (WebM/Matroska): 0x1A 0x45 0xDF 0xA3.
    if (
      header[0] === 0x1a &&
      header[1] === 0x45 &&
      header[2] === 0xdf &&
      header[3] === 0xa3
    ) {
      return "audio/webm";
    }
    // FLAC: "fLaC".
    if (
      header[0] === 0x66 &&
      header[1] === 0x4c &&
      header[2] === 0x61 &&
      header[3] === 0x43
    ) {
      return "audio/flac";
    }
  }

  if (header.length >= 3) {
    // MP3 with ID3 tag.
    if (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33) {
      return "audio/mpeg";
    }
  }

  if (header.length >= 2) {
    // MP3 frame sync (0xFF Ex) or ADTS (AAC, 0xFF F1/F9).
    if (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) {
      const layer = header[1] & 0x06;

      if (layer === 0x00) return "audio/aac";

      return "audio/mpeg";
    }
  }

  return "";
}

/** Sniff a Blob's container from its first 16 bytes. */
export async function sniffBlobMimeType(blob: Blob): Promise<string> {
  try {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());

    return sniffAudioMimeType(head);
  } catch {
    return "";
  }
}

/** Filesystem-safe stem for rescue downloads. */
export function sanitizeFileStem(title: string): string {
  const stem = title.replace(/[\\/:*?"<>|#%&{}$!'@+=`~]/g, "_").trim();

  return stem === "" ? "aufnahme" : stem.slice(0, 100);
}

/** Rescue filename with an honest extension for the MIME type. */
export function rescueFileName(title: string, mime: string): string {
  return `${sanitizeFileStem(title)}${extensionForMimeType(mime)}`;
}
