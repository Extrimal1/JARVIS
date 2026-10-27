"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, Square } from "lucide-react";
import { createId } from "@/src/lib/ids";
import { appendChunk, clearChunks, saveAudio } from "@/src/lib/lecture/audioStore";
import {
  LECTURE_LANGUAGES,
  formatDuration,
  type LectureLanguage,
  type LectureSession,
  type LocalRecording,
} from "@/src/lib/lecture/types";
import type { Entry } from "@/src/lib/study";

const CHUNK_TIMESLICE_MS = 5000;

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "",
];

function pickMimeType(): string {
  if (
    typeof window === "undefined" ||
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return "";
  }

  for (const candidate of MIME_CANDIDATES) {
    if (candidate === "") return "";

    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return "";
}

function recorderSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

async function sha256Hex(blob: Blob): Promise<string> {
  try {
    const buffer = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);

    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

type Phase = "idle" | "requesting" | "recording" | "paused" | "finalizing";

export function RecorderPanel({
  subjects,
  sessions,
  onCreateSession,
  onSaveRecording,
}: {
  subjects: Entry[];
  sessions: LectureSession[];
  onCreateSession: (input: {
    courseId: string | null;
    title: string;
  }) => Promise<LectureSession | null>;
  onSaveRecording: (meta: LocalRecording) => Promise<boolean>;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [title, setTitle] = useState("");
  const [courseId, setCourseId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [language, setLanguage] = useState<LectureLanguage>("de");
  const [consent, setConsent] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [persistedChunks, setPersistedChunks] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rescue, setRescue] = useState<{ blob: Blob; name: string } | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const memoryChunksRef = useRef<Blob[]>([]);
  const chunkIndexRef = useRef(0);
  const startedAtRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const pauseStartRef = useRef(0);
  const metaRef = useRef<LocalRecording | null>(null);
  const tickerRef = useRef<number | null>(null);

  const supported = recorderSupported();
  const busy = phase === "requesting" || phase === "finalizing";
  const active = phase === "recording" || phase === "paused";

  function stopTicker() {
    if (tickerRef.current !== null) {
      window.clearInterval(tickerRef.current);
      tickerRef.current = null;
    }
  }

  function stopTracks() {
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }

    streamRef.current = null;
  }

  function resetRefs() {
    recorderRef.current = null;
    memoryChunksRef.current = [];
    chunkIndexRef.current = 0;
    startedAtRef.current = 0;
    pausedTotalRef.current = 0;
    pauseStartRef.current = 0;
    metaRef.current = null;
  }

  useEffect(
    () => () => {
      stopTicker();
      stopTracks();
    },
    [],
  );

  function currentElapsed(): number {
    if (startedAtRef.current === 0) return 0;

    const paused =
      pausedTotalRef.current +
      (pauseStartRef.current > 0 ? Date.now() - pauseStartRef.current : 0);

    return Math.max(0, (Date.now() - startedAtRef.current - paused) / 1000);
  }

  async function start() {
    if (busy || active || !supported) return;

    if (!consent) {
      setError("Bitte bestätige zuerst, dass du aufnehmen darfst.");
      return;
    }

    setError(null);
    setRescue(null);
    setPhase("requesting");

    let stream: MediaStream;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (unknown) {
      setPhase("idle");

      if (unknown instanceof DOMException && unknown.name === "NotAllowedError") {
        setError(
          "Mikrofonzugriff verweigert. Erlaube den Zugriff in den Browser-Einstellungen und versuche es erneut.",
        );
      } else if (
        unknown instanceof DOMException &&
        unknown.name === "NotFoundError"
      ) {
        setError("Kein Mikrofon gefunden. Schließe ein Mikrofon an.");
      } else {
        setError("Das Mikrofon konnte nicht geöffnet werden.");
      }

      return;
    }

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;

    try {
      recorder =
        mimeType === "" ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType });
    } catch {
      for (const track of stream.getTracks()) track.stop();
      setPhase("idle");
      setError("Aufnahme wird von diesem Browser nicht unterstützt.");
      return;
    }

    const now = new Date().toISOString();
    const meta: LocalRecording = {
      id: createId(),
      sessionId: sessionId === "" ? null : sessionId,
      courseId: courseId === "" ? null : courseId,
      title: title.trim() === "" ? "Vorlesung ohne Titel" : title.trim(),
      language,
      mimeType: recorder.mimeType !== "" ? recorder.mimeType : "audio/webm",
      durationSeconds: 0,
      sizeBytes: 0,
      sha256: "",
      status: "recording",
      errorCode: "",
      consentAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const persisted = await onSaveRecording(meta);

    if (!persisted) {
      for (const track of stream.getTracks()) track.stop();
      setPhase("idle");
      return;
    }

    streamRef.current = stream;
    recorderRef.current = recorder;
    memoryChunksRef.current = [];
    chunkIndexRef.current = 0;
    metaRef.current = meta;
    startedAtRef.current = Date.now();
    pausedTotalRef.current = 0;
    pauseStartRef.current = 0;
    setPersistedChunks(0);
    setElapsed(0);

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size === 0) return;

      memoryChunksRef.current.push(event.data);
      const index = chunkIndexRef.current;
      chunkIndexRef.current += 1;

      appendChunk(meta.id, index, event.data).then(
        () => setPersistedChunks((count) => count + 1),
        () => {
          // Chunk persistence failed (quota?); the in-memory copy
          // still allows finalizing or a rescue download.
          setError(
            "Zwischenspeichern schlägt fehl (Speicher voll?). Die Aufnahme läuft im Arbeitsspeicher weiter.",
          );
        },
      );
    };

    recorder.onerror = () => {
      setError("Aufnahmefehler – bitte beende und beginne erneut.");
    };

    recorder.onstop = () => {
      void finalize();
    };

    try {
      recorder.start(CHUNK_TIMESLICE_MS);
    } catch {
      stopTracks();
      setPhase("idle");
      setError("Die Aufnahme konnte nicht gestartet werden.");
      return;
    }

    setPhase("recording");
    tickerRef.current = window.setInterval(() => {
      setElapsed(currentElapsed());
    }, 500);
  }

  function pause() {
    const recorder = recorderRef.current;

    if (phase !== "recording" || recorder === null) return;

    pauseStartRef.current = Date.now();

    try {
      recorder.pause();
      setPhase("paused");
    } catch {
      pauseStartRef.current = 0;
    }
  }

  function resume() {
    const recorder = recorderRef.current;

    if (phase !== "paused" || recorder === null) return;

    if (pauseStartRef.current > 0) {
      pausedTotalRef.current += Date.now() - pauseStartRef.current;
      pauseStartRef.current = 0;
    }

    try {
      recorder.resume();
      setPhase("recording");
    } catch {
      // Stay paused when resume fails.
    }
  }

  async function finalize() {
    const meta = metaRef.current;

    stopTicker();
    stopTracks();
    setPhase("finalizing");

    if (meta === null) {
      resetRefs();
      setPhase("idle");
      return;
    }

    const blob = new Blob(memoryChunksRef.current, { type: meta.mimeType });
    const duration = currentElapsed();

    try {
      await saveAudio(meta.id, blob);
    } catch {
      setRescue({ blob, name: `${meta.title}.webm` });
      await onSaveRecording({
        ...meta,
        durationSeconds: Math.round(duration),
        sizeBytes: blob.size,
        status: "failed",
        errorCode: "storage-full",
        updatedAt: new Date().toISOString(),
      });
      resetRefs();
      setPhase("idle");
      setError(
        "Audio konnte nicht gespeichert werden (Speicher voll?). Lade die Aufnahme über „Audio sichern“ herunter, bevor du fortfährst.",
      );
      return;
    }

    await clearChunks(meta.id).catch(() => undefined);
    const hash = await sha256Hex(blob);

    await onSaveRecording({
      ...meta,
      durationSeconds: Math.round(duration),
      sizeBytes: blob.size,
      sha256: hash,
      status: "saved_locally",
      updatedAt: new Date().toISOString(),
    });

    resetRefs();
    setElapsed(0);
    setPersistedChunks(0);
    setPhase("idle");
  }

  function stop() {
    const recorder = recorderRef.current;

    if (!active || recorder === null) return;

    if (pauseStartRef.current > 0) {
      pausedTotalRef.current += Date.now() - pauseStartRef.current;
      pauseStartRef.current = 0;
    }

    try {
      recorder.stop();
    } catch {
      void finalize();
    }
  }

  function downloadRescue() {
    if (rescue === null) return;

    const url = URL.createObjectURL(rescue.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = rescue.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function createSession() {
    if (newSessionTitle.trim() === "") return;

    const session = await onCreateSession({
      courseId: courseId === "" ? null : courseId,
      title: newSessionTitle,
    });

    if (session !== null) {
      setSessionId(session.id);
      setNewSessionTitle("");
    }
  }

  return (
    <section
      aria-label="Aufnahme"
      className="jarvis-enter rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
          <Mic size={21} />
        </div>

        <div>
          <h2 className="font-semibold">Aufnehmen</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Lokal im Browser – nichts wird ohne deine Zustimmung
            hochgeladen oder übertragen.
          </p>
        </div>

        <span
          role="status"
          className={`ml-auto flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
            phase === "recording"
              ? "border-rose-400/40 bg-rose-400/10 text-rose-200"
              : phase === "paused"
                ? "border-amber-300/40 bg-amber-300/10 text-amber-200"
                : "border-white/10 text-slate-400"
          }`}
        >
          <span
            aria-hidden="true"
            className={`h-2 w-2 rounded-full ${
              phase === "recording"
                ? "animate-pulse bg-rose-400"
                : phase === "paused"
                  ? "bg-amber-300"
                  : "bg-slate-600"
            }`}
          />
          {phase === "recording"
            ? `Nimmt auf · ${formatDuration(elapsed)}`
            : phase === "paused"
              ? `Pausiert · ${formatDuration(elapsed)}`
              : phase === "finalizing" || phase === "requesting"
                ? "Bitte warten …"
                : "Bereit"}
        </span>
      </div>

      {!supported ? (
        <p
          role="alert"
          className="mt-5 rounded-2xl border border-amber-300/30 bg-amber-300/5 p-4 text-sm text-amber-100"
        >
          Dieser Browser unterstützt keine Audioaufnahme. Nutze einen
          aktuellen Chrome-, Edge- oder Firefox-Browser.
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-slate-400">
              Titel
              <input
                value={title}
                onChange={(change) => setTitle(change.target.value)}
                disabled={active || busy}
                placeholder="z. B. Java, Vorlesung 7"
                maxLength={120}
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50 disabled:opacity-50"
              />
            </label>

            <label className="block text-xs text-slate-400">
              Sprache
              <select
                value={language}
                onChange={(change) =>
                  setLanguage(change.target.value as LectureLanguage)
                }
                disabled={active || busy}
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50 disabled:opacity-50"
              >
                {LECTURE_LANGUAGES.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs text-slate-400">
              Fach (aus Studium)
              <select
                value={courseId}
                onChange={(change) => setCourseId(change.target.value)}
                disabled={active || busy}
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50 disabled:opacity-50"
              >
                <option value="">Kein Fach</option>
                {subjects.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs text-slate-400">
              Sitzung (optional)
              <select
                value={sessionId}
                onChange={(change) => setSessionId(change.target.value)}
                disabled={active || busy}
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50 disabled:opacity-50"
              >
                <option value="">Keine Sitzung</option>
                {sessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={newSessionTitle}
              onChange={(change) => setNewSessionTitle(change.target.value)}
              disabled={active || busy}
              placeholder="Neue Sitzung anlegen …"
              maxLength={120}
              aria-label="Neue Sitzung anlegen"
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50 disabled:opacity-50"
            />
            <button
              onClick={() => void createSession()}
              disabled={active || busy || newSessionTitle.trim() === ""}
              className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition hover:border-cyan-300/30 disabled:opacity-40"
            >
              Sitzung anlegen
            </button>
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-white/10 p-4 text-xs leading-5 text-slate-300">
            <input
              type="checkbox"
              checked={consent}
              onChange={(change) => setConsent(change.target.checked)}
              disabled={active || busy}
              className="mt-0.5 h-4 w-4 shrink-0 accent-cyan-300"
            />
            <span>
              Ich bestätige, dass ich diese Vorlesung aufnehmen darf. Das
              Audio bleibt lokal in diesem Browser gespeichert, bis ich
              einer Übertragung oder Synchronisierung ausdrücklich
              zustimme.
            </span>
          </label>

          {error !== null && (
            <p role="alert" className="text-xs leading-5 text-rose-300">
              {error}
            </p>
          )}

          {rescue !== null && (
            <button
              onClick={downloadRescue}
              className="w-full rounded-xl border border-amber-300/40 bg-amber-300/10 px-4 py-3 text-sm text-amber-100 transition hover:bg-amber-300/15"
            >
              Audio sichern (Download)
            </button>
          )}

          <div className="flex flex-wrap gap-2">
            {!active ? (
              <button
                onClick={() => void start()}
                disabled={busy || !consent}
                className="jarvis-press flex flex-1 items-center justify-center gap-2 rounded-xl bg-rose-400 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Mic size={16} />
                {phase === "requesting" ? "Mikrofon wird geöffnet …" : "Aufnahme starten"}
              </button>
            ) : (
              <>
                {phase === "recording" ? (
                  <button
                    onClick={pause}
                    className="jarvis-press flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-200 transition hover:bg-white/5"
                  >
                    <Pause size={16} />
                    Pause
                  </button>
                ) : (
                  <button
                    onClick={resume}
                    className="jarvis-press flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                  >
                    <Play size={16} />
                    Fortsetzen
                  </button>
                )}
                <button
                  onClick={stop}
                  className="jarvis-press flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                >
                  <Square size={16} />
                  Beenden & Speichern
                </button>
              </>
            )}
          </div>

          {active && (
            <p aria-live="polite" className="text-xs tabular-nums text-slate-500">
              {formatDuration(elapsed)} aufgenommen · {persistedChunks}{" "}
              {persistedChunks === 1 ? "Abschnitt" : "Abschnitte"} lokal
              zwischengespeichert
            </p>
          )}

          <p className="text-[11px] leading-4 text-slate-600">
            Hinweis: Die Aufnahme läuft nur, solange diese Seite geöffnet
            ist. Hintergrundaufnahme wird vom Browser nicht zuverlässig
            unterstützt – sperre dein Handy während der Vorlesung nicht.
          </p>
        </div>
      )}
    </section>
  );
}
