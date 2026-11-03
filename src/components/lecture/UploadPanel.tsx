"use client";

import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { createId } from "@/src/lib/ids";
import type { Entry } from "@/src/lib/study";
import { saveAudio } from "@/src/lib/lecture/audioStore";
import { sniffBlobMimeType } from "@/src/lib/lecture/audioMime";
import {
  LECTURE_LANGUAGES,
  type LectureLanguage,
  type LocalRecording,
} from "@/src/lib/lecture/types";

const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function probeDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();

    const done = (seconds: number) => {
      URL.revokeObjectURL(url);
      resolve(seconds);
    };

    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      done(
        Number.isFinite(audio.duration) && audio.duration > 0
          ? Math.round(audio.duration)
          : 0,
      );
    };
    audio.onerror = () => done(0);
    audio.src = url;
  });
}

/**
 * Audio upload into the local lecture library (IndexedDB). Nothing
 * leaves the browser; the file becomes a regular LocalRecording with
 * optional subject link, ready for local playback and (cloud-mode)
 * worker transcription.
 */
export function UploadPanel({
  subjects,
  onSaveRecording,
}: {
  subjects: Entry[];
  onSaveRecording: (meta: LocalRecording) => Promise<boolean>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [language, setLanguage] = useState<LectureLanguage>("de");
  const [subjectId, setSubjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];

    if (file === undefined || file === null || busy) return;

    setBusy(true);
    setFailed(false);
    setMessage(`„${file.name}“ wird importiert …`);

    try {
      // Some browsers report no MIME type for local files; sniff the
      // container from the header instead of rejecting valid audio.
      let effectiveType = file.type;

      if (effectiveType === "") {
        effectiveType = await sniffBlobMimeType(file);
      }

      if (!effectiveType.startsWith("audio/")) {
        setFailed(true);
        setMessage(
          `„${file.name}“ ist kein Audio (erkannt: ${effectiveType === "" ? "unbekannt" : effectiveType}).`,
        );
        return;
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        setFailed(true);
        setMessage("Die Datei ist zu groß (max. 512 MB).");
        return;
      }

      // Re-wrap typeless files with the sniffed container so the stored
      // Blob carries the honest label (same bytes, no transcode).
      const audioBlob =
        file.type === "" ? new Blob([file], { type: effectiveType }) : file;

      const [hash, duration] = await Promise.all([
        sha256Hex(audioBlob),
        probeDuration(audioBlob),
      ]);
      const now = new Date().toISOString();
      const base =
        file.name.replace(/\.[a-z0-9]+$/i, "").trim() || "Importierte Aufnahme";

      const meta: LocalRecording = {
        id: createId(),
        sessionId: null,
        courseId: null,
        title: base.slice(0, 120),
        language,
        mimeType: effectiveType,
        durationSeconds: duration,
        sizeBytes: audioBlob.size,
        sha256: hash,
        status: "saved_locally",
        errorCode: "",
        consentAt: now,
        createdAt: now,
        updatedAt: now,
        notes: "",
        subjectId,
      };

      await saveAudio(meta.id, audioBlob);
      const persisted = await onSaveRecording(meta);

      if (!persisted) {
        setFailed(true);
        setMessage("Die Aufnahme konnte nicht gespeichert werden.");
        return;
      }

      setMessage(`„${meta.title}“ wurde lokal gespeichert.`);
    } catch {
      setFailed(true);
      setMessage("Der Import ist fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      setBusy(false);

      if (inputRef.current !== null) inputRef.current.value = "";
    }
  }

  return (
    <section
      aria-label="Audio importieren"
      className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
          <Upload size={21} />
        </div>

        <div>
          <h2 className="font-semibold">Audio importieren</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Vorlesungsmitschnitte als Datei hinzufügen — bleibt lokal in
            diesem Browser, kein Upload auf Server.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">
          Sprache
          <select
            value={language}
            onChange={(event) =>
              setLanguage(event.target.value as LectureLanguage)
            }
            className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
          >
            {LECTURE_LANGUAGES.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-slate-400">
          Fach verknüpfen (optional)
          <select
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
            className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
          >
            <option value="">Kein Fach</option>
            {subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept="audio/*"
          disabled={busy}
          onChange={(event) => void handleFiles(event.target.files)}
          aria-label="Audiodatei auswählen"
          className="block w-full text-sm text-slate-300 file:mr-4 file:rounded-xl file:border-0 file:bg-cyan-300 file:px-4 file:py-2.5 file:text-sm file:font-medium file:text-slate-950 hover:file:bg-cyan-200 disabled:opacity-50 sm:w-auto"
        />
      </div>

      {message !== null && (
        <p
          role={failed ? "alert" : "status"}
          aria-live="polite"
          className={`mt-3 text-sm ${failed ? "text-rose-300" : "text-slate-400"}`}
        >
          {message}
        </p>
      )}
    </section>
  );
}
