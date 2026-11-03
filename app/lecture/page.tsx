"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  AudioLines,
  FileText,
  Play,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import Sidebar from "@/src/components/Sidebar";
import { RecorderPanel } from "@/src/components/lecture/RecorderPanel";
import { RecordingPlayer } from "@/src/components/lecture/RecordingPlayer";
import { UploadPanel } from "@/src/components/lecture/UploadPanel";
import { CLOUD_ENABLED } from "@/src/lib/db/mode";
import { useStudy } from "@/src/lib/db/useModules";
import { EMPTY_STUDY } from "@/src/lib/study";
import {
  clearChunks,
  deleteRecordingAll,
  getAudio,
  listChunks,
  saveAudio,
} from "@/src/lib/lecture/audioStore";
import {
  buildFinalAudio,
  resolveFinalMimeType,
} from "@/src/lib/lecture/audioMime";
import { useRecordings } from "@/src/lib/lecture/useRecordings";
import {
  RECORDING_STATUS_LABELS,
  formatDuration,
  type LocalRecording,
} from "@/src/lib/lecture/types";

const DAY_FORMAT = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
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

export default function LecturePage() {
  const studyStore = useStudy(EMPTY_STUDY);
  const library = useRecordings();
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [workerReady, setWorkerReady] = useState(false);

  const subjects = studyStore.data.subjects;
  const exams = studyStore.data.exams;
  const interrupted = library.recordings.filter(
    (item) => item.status === "recording",
  );
  const finished = library.recordings.filter(
    (item) => item.status !== "recording",
  );

  // One visible player at a time; the player owns its object URL and
  // revokes it on unmount, so closing a player frees its resources.
  function togglePlayer(recording: LocalRecording) {
    setPlayerId((current) => (current === recording.id ? null : recording.id));
  }

  async function recover(recording: LocalRecording) {
    if (recovering) return;

    setRecovering(true);
    setPlayError(null);

    try {
      const chunks = await listChunks(recording.id);

      if (chunks.length === 0) {
        await library.removeRecording(recording.id);
        setPlayError(
          `„${recording.title}“ enthielt keine Audiodaten und wurde entfernt.`,
        );
        return;
      }

      // Honest container: chunk declarations win over stale metadata.
      const effectiveMime = resolveFinalMimeType({
        metaMime: recording.mimeType,
        recorderMime: "",
        chunkTypes: chunks.map((chunk) => chunk.type),
      });
      const blob = buildFinalAudio(chunks, effectiveMime);

      if (blob.size === 0) {
        await deleteRecordingAll(recording.id);
        await library.refresh();
        setPlayError(
          `„${recording.title}“ enthielt keine Audiodaten und wurde entfernt.`,
        );
        return;
      }

      await saveAudio(recording.id, blob);
      await clearChunks(recording.id).catch(() => undefined);
      const duration =
        recording.durationSeconds > 0
          ? recording.durationSeconds
          : await probeDuration(blob);
      const hash = await sha256Hex(blob);
      await library.saveRecording({
        ...recording,
        mimeType: effectiveMime,
        durationSeconds: duration,
        sizeBytes: blob.size,
        sha256: hash === "" ? recording.sha256 : hash,
        status: "saved_locally",
        errorCode: "",
        updatedAt: new Date().toISOString(),
      });
    } catch {
      setPlayError(
        `„${recording.title}“ konnte nicht wiederhergestellt werden.`,
      );
    } finally {
      setRecovering(false);
    }
  }

  async function discard(recording: LocalRecording) {
    if (recovering) return;

    setRecovering(true);

    try {
      await deleteRecordingAll(recording.id);
      await library.refresh();
    } finally {
      setRecovering(false);
    }
  }

  async function removeFinished(id: string) {
    // Unmount the player first so its object URL is revoked.
    if (playerId === id) setPlayerId(null);

    await library.removeRecording(id);
    setConfirmDeleteId(null);
  }

  async function repairMime(recording: LocalRecording, actualMime: string) {
    if (recording.mimeType === actualMime) return;

    await library.saveRecording({
      ...recording,
      mimeType: actualMime,
      updatedAt: new Date().toISOString(),
    });
  }

  function toggleDetails(recording: LocalRecording) {
    if (detailsId === recording.id) {
      setDetailsId(null);
    } else {
      setNotesDraft(recording.notes ?? "");
      setDetailsId(recording.id);
    }
  }

  async function saveNotes(recording: LocalRecording) {
    await library.saveRecording({
      ...recording,
      notes: notesDraft,
      updatedAt: new Date().toISOString(),
    });
  }

  async function linkSubject(recording: LocalRecording, subjectId: string) {
    await library.saveRecording({
      ...recording,
      subjectId,
      updatedAt: new Date().toISOString(),
    });
  }

  async function transcribe(recording: LocalRecording) {
    if (transcribingId !== null) return;

    setTranscribingId(recording.id);
    setPlayError(null);

    try {
      const blob = await getAudio(recording.id);

      if (blob === null) {
        setPlayError(
          `„${recording.title}“: kein Audio gespeichert — Transkription unmöglich.`,
        );
        return;
      }

      const form = new FormData();
      form.set("audio", blob);
      form.set("language", recording.language);
      form.set("recordingId", recording.id);

      const res = await fetch("/api/lecture/transcribe", {
        method: "POST",
        body: form,
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { fullText?: unknown; transcribedAt?: unknown };
        error?: { message?: unknown };
      } | null;

      if (
        !res.ok ||
        body === null ||
        body.ok !== true ||
        typeof body.data?.fullText !== "string" ||
        typeof body.data?.transcribedAt !== "string"
      ) {
        const message =
          body !== null && typeof body.error?.message === "string"
            ? body.error.message
            : `Transkription fehlgeschlagen (HTTP ${res.status}).`;
        setPlayError(`„${recording.title}“: ${message}`);
        return;
      }

      await library.saveRecording({
        ...recording,
        transcript: body.data.fullText,
        transcribedAt: body.data.transcribedAt,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      setPlayError(
        `„${recording.title}“: Transkription fehlgeschlagen (Netzwerkfehler).`,
      );
    } finally {
      setTranscribingId(null);
    }
  }

  function subjectTitle(subjectId: string | undefined): string | null {
    if (subjectId === undefined || subjectId === "") return null;

    return subjects.find((subject) => subject.id === subjectId)?.title ?? null;
  }

  return (
    <main className="min-h-screen bg-[#080b12] text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col md:flex-row">
        <Sidebar />

        <section className="min-w-0 flex-1 px-5 py-7 sm:px-8 lg:px-12">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-slate-500 transition hover:text-cyan-200"
          >
            <ArrowLeft size={16} />
            Zur Übersicht
          </Link>

          <header className="mt-7">
            <p className="text-sm tracking-wide text-cyan-300">
              LECTURE INTELLIGENCE
            </p>

            <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">
              Vorlesungen
            </h1>

            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              Vorlesungen aufnehmen oder als Audio importieren, lokal
              sichern, mit Fächern verknüpfen und mit Notizen versehen.
              Transkription läuft über deinen eigenen Worker — ohne
              Worker bleibt alles lokal, ohne erfundene Transkripte.
            </p>
          </header>

          <div className="mt-8 space-y-5">
            <RecorderPanel
              subjects={subjects}
              sessions={library.sessions}
              onCreateSession={library.createSession}
              onSaveRecording={library.saveRecording}
            />

            <UploadPanel
              subjects={subjects}
              onSaveRecording={library.saveRecording}
            />

            <TranscriptionStatus onReadyChange={setWorkerReady} />

            {library.loading ? (
              <p
                aria-live="polite"
                className="rounded-2xl border border-white/[0.08] bg-[#0d111b] px-4 py-3 text-sm text-slate-400"
              >
                Aufnahmen werden geladen …
              </p>
            ) : null}

            {library.error !== null && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/25 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"
              >
                <span className="min-w-0 flex-1">{library.error}</span>
                <button
                  onClick={() => void library.refresh()}
                  className="rounded-xl border border-rose-300/30 px-3 py-1.5 text-xs transition hover:bg-rose-400/10"
                >
                  Erneut versuchen
                </button>
              </div>
            )}

            {playError !== null && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300/25 bg-amber-300/5 px-4 py-3 text-sm text-amber-100"
              >
                <span className="min-w-0 flex-1">{playError}</span>
                <button
                  onClick={() => setPlayError(null)}
                  aria-label="Hinweis schließen"
                  className="rounded-lg border border-white/10 p-1.5 text-slate-300 hover:bg-white/5"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {interrupted.length > 0 && (
              <section
                aria-label="Unterbrochene Aufnahmen"
                className="rounded-3xl border border-amber-300/30 bg-amber-300/5 p-5 sm:p-6"
              >
                <h2 className="font-semibold text-amber-100">
                  Unterbrochene Aufnahmen ({interrupted.length})
                </h2>
                <p className="mt-1 text-xs leading-5 text-amber-100/70">
                  Diese Aufnahmen wurden nicht ordnungsgemäß beendet
                  (Tab geschlossen, App abgestürzt). Stelle sie aus den
                  zwischengespeicherten Abschnitten wieder her oder
                  verwerfe sie.
                </p>

                <ul className="mt-4 space-y-2">
                  {interrupted.map((recording) => (
                    <li
                      key={recording.id}
                      className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300/20 bg-black/20 p-4"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-slate-200">
                          {recording.title}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {DAY_FORMAT.format(new Date(recording.createdAt))}
                        </p>
                      </div>
                      <button
                        onClick={() => void recover(recording)}
                        disabled={recovering}
                        className="rounded-xl bg-cyan-300 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:opacity-40"
                      >
                        Wiederherstellen
                      </button>
                      <button
                        onClick={() => void discard(recording)}
                        disabled={recovering}
                        className="rounded-xl border border-rose-400/30 px-4 py-2 text-sm text-rose-200 transition hover:bg-rose-400/10 disabled:opacity-40"
                      >
                        Verwerfen
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section
              aria-label="Aufnahmen"
              className="jarvis-enter rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
              style={{ "--enter-delay": "80ms" } as React.CSSProperties}
            >
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
                  <AudioLines size={21} />
                </div>

                <div>
                  <h2 className="font-semibold">Aufnahmen</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Alle Audios liegen ausschließlich lokal in diesem
                    Browser auf diesem Gerät — sie werden nicht
                    automatisch auf andere Geräte synchronisiert.
                  </p>
                  <p className="mt-2 text-xs text-cyan-300">
                    {finished.length}{" "}
                    {finished.length === 1 ? "Aufnahme" : "Aufnahmen"}
                  </p>
                </div>
              </div>

              <div className="mt-5">
                {finished.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                    Noch keine Aufnahmen. Starte oben deine erste Aufnahme –
                    sie funktioniert auch ohne Internet.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {finished.map((recording) => (
                      <li
                        key={recording.id}
                        className="jarvis-lift rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
                      >
                        <div className="flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-slate-200">
                              {recording.title}
                            </p>
                            <p className="mt-1 text-xs tabular-nums text-slate-500">
                              {DAY_FORMAT.format(new Date(recording.createdAt))}{" "}
                              · {formatDuration(recording.durationSeconds)} ·{" "}
                              {formatBytes(recording.sizeBytes)} ·{" "}
                              {RECORDING_STATUS_LABELS[recording.status]}
                            </p>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {subjectTitle(recording.subjectId) !== null && (
                                <Link
                                  href="/study"
                                  className="rounded-full bg-cyan-300/10 px-2 py-0.5 text-[10px] text-cyan-200 transition hover:bg-cyan-300/20"
                                >
                                  {subjectTitle(recording.subjectId)}
                                </Link>
                              )}
                              {(recording.notes ?? "") !== "" && (
                                <span className="flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] text-slate-400">
                                  <StickyNote size={10} />
                                  Notizen
                                </span>
                              )}
                              {(recording.transcript ?? "") !== "" && (
                                <span className="flex items-center gap-1 rounded-full bg-emerald-300/10 px-2 py-0.5 text-[10px] text-emerald-200">
                                  <FileText size={10} />
                                  Transkribiert
                                </span>
                              )}
                            </div>
                          </div>

                          <div className="flex shrink-0 gap-1">
                            <button
                              onClick={() => togglePlayer(recording)}
                              aria-expanded={playerId === recording.id}
                              aria-label={`${playerId === recording.id ? "Player schließen" : "Abspielen"}: ${recording.title}`}
                              title={playerId === recording.id ? "Player schließen" : "Abspielen"}
                              className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                            >
                              <Play size={15} />
                            </button>
                            <button
                              onClick={() => toggleDetails(recording)}
                              aria-expanded={detailsId === recording.id}
                              aria-label={`Details: ${recording.title}`}
                              title="Notizen, Fach & Transkript"
                              className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                            >
                              <StickyNote size={15} />
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(recording.id)}
                              aria-label={`Löschen: ${recording.title}`}
                              title="Löschen"
                              className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>

                        {detailsId === recording.id && (
                          <div className="mt-3 space-y-3 rounded-xl border border-white/[0.07] bg-black/20 p-4">
                            <label className="block text-xs text-slate-400">
                              Fach verknüpfen
                              <select
                                value={recording.subjectId ?? ""}
                                onChange={(event) =>
                                  void linkSubject(
                                    recording,
                                    event.target.value,
                                  )
                                }
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

                            {subjectTitle(recording.subjectId) !== null &&
                              exams.some(
                                (exam) =>
                                  exam.subject ===
                                  subjectTitle(recording.subjectId),
                              ) && (
                                <div className="rounded-xl border border-white/[0.07] bg-black/20 p-3">
                                  <p className="text-xs text-slate-400">
                                    Zugehörige Prüfungen
                                  </p>
                                  <ul className="mt-2 space-y-1.5">
                                    {exams
                                      .filter(
                                        (exam) =>
                                          exam.subject ===
                                          subjectTitle(recording.subjectId),
                                      )
                                      .map((exam) => (
                                        <li key={exam.id}>
                                          <Link
                                            href="/study?tab=prep&prep=exams"
                                            className="text-sm text-slate-200 transition hover:text-cyan-200"
                                          >
                                            {exam.title}
                                            {exam.date !== undefined
                                              ? ` · ${exam.date.slice(8, 10)}.${exam.date.slice(5, 7)}.`
                                              : ""}
                                          </Link>
                                        </li>
                                      ))}
                                  </ul>
                                </div>
                              )}

                            <label className="block text-xs text-slate-400">
                              Notizen (deine eigenen — werden nie automatisch
                              erzeugt)
                              <textarea
                                value={notesDraft}
                                onChange={(event) =>
                                  setNotesDraft(event.target.value)
                                }
                                placeholder="Wichtigste Punkte, offene Fragen, Zusammenfassung …"
                                rows={4}
                                maxLength={10000}
                                className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm leading-6 text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
                              />
                            </label>
                            <div>
                              <button
                                onClick={() => void saveNotes(recording)}
                                className="rounded-xl border border-cyan-300/30 px-4 py-2 text-sm text-cyan-200 transition hover:bg-cyan-300/10"
                              >
                                Notizen speichern
                              </button>
                            </div>

                            <div className="border-t border-white/[0.07] pt-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  onClick={() => void transcribe(recording)}
                                  disabled={
                                    !workerReady || transcribingId !== null
                                  }
                                  title={
                                    workerReady
                                      ? "Audio an den Transkriptions-Worker senden"
                                      : "Transkription nicht verfügbar — siehe Status oben"
                                  }
                                  className="rounded-xl bg-cyan-300 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {transcribingId === recording.id
                                    ? "Wird transkribiert …"
                                    : "Transkribieren"}
                                </button>
                                {!workerReady && (
                                  <span className="text-xs text-slate-500">
                                    Worker nicht bereit — Details im Status
                                    oben.
                                  </span>
                                )}
                              </div>

                              {(recording.transcript ?? "") !== "" ? (
                                <div className="mt-3">
                                  <p className="text-xs text-slate-400">
                                    Transkript
                                    {recording.transcribedAt !== undefined &&
                                      ` · ${DAY_FORMAT.format(new Date(recording.transcribedAt))}`}
                                  </p>
                                  <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/[0.07] bg-black/30 p-3 text-sm leading-6 text-slate-200">
                                    {recording.transcript}
                                  </p>
                                </div>
                              ) : (
                                <p className="mt-3 text-xs leading-5 text-slate-500">
                                  Noch kein Transkript — es wird ausschließlich
                                  vom Worker erzeugt, niemals erfunden.
                                </p>
                              )}
                            </div>
                          </div>
                        )}

                        {playerId === recording.id && (
                          <RecordingPlayer
                            key={recording.id}
                            recordingId={recording.id}
                            title={recording.title}
                            metaMimeType={recording.mimeType}
                            fallbackDurationSeconds={recording.durationSeconds}
                            onMimeRepair={(actual) =>
                              void repairMime(recording, actual)
                            }
                          />
                        )}

                        {confirmDeleteId === recording.id && (
                          <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/5 p-4">
                            <p className="text-sm text-rose-200">
                              „{recording.title}“ samt Audio endgültig
                              löschen? Das kann nicht rückgängig gemacht
                              werden.
                            </p>
                            <div className="mt-3 flex gap-2">
                              <button
                                onClick={() => void removeFinished(recording.id)}
                                className="flex-1 rounded-xl bg-rose-400 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-rose-300"
                              >
                                Endgültig löschen
                              </button>
                              <button
                                onClick={() => setConfirmDeleteId(null)}
                                className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                              >
                                Abbrechen
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>

          <footer className="py-8 text-center text-xs text-slate-600">
            J.A.R.V.I.S. · Vorlesungen · Lokale Speicherung
          </footer>
        </section>
      </div>
    </main>
  );
}

type WorkerState = "loading" | "local-only" | "unconfigured" | "reachable" | "unreachable";

/**
 * Honest transcription status from GET /api/health. Reports readiness
 * upward so per-recording buttons enable only when transcription can
 * actually run. Never claims a transcript exists when it doesn't.
 */
function TranscriptionStatus({
  onReadyChange,
}: {
  onReadyChange: (ready: boolean) => void;
}) {
  const [state, setState] = useState<WorkerState>("loading");

  useEffect(() => {
    let cancelled = false;

    if (!CLOUD_ENABLED) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState("local-only");
      onReadyChange(false);

      return;
    }

    async function load() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: { worker?: unknown };
        } | null;
        const worker = body?.data?.worker;

        if (cancelled) return;

        const next: WorkerState =
          worker === "reachable"
            ? "reachable"
            : worker === "unreachable"
              ? "unreachable"
              : "unconfigured";

        setState(next);
        onReadyChange(next === "reachable");
      } catch {
        if (cancelled) return;

        setState("unreachable");
        onReadyChange(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
    // onReadyChange is a stable setState; including it would refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy: Record<WorkerState, { title: string; detail: string }> = {
    loading: {
      title: "Transkriptionsstatus wird geprüft …",
      detail: "Der Worker-Status wird geladen.",
    },
    "local-only": {
      title: "Transkription: lokaler Modus",
      detail:
        "Transkription läuft über einen Server-Proxy an deinen eigenen Worker und ist im lokalen Modus deaktiviert. Aufnahmen, Import und Notizen funktionieren vollständig offline — es wird kein Transkript erfunden.",
    },
    unconfigured: {
      title: "Transkription: nicht konfiguriert",
      detail:
        "LECTURE_WORKER_URL fehlt in der Server-Umgebung. Trage dort die URL deines (Whisper-kompatiblen) Workers ein — Format: POST /transcribe mit Multipart-Feldern audio, language, recordingId; Antwort als JSON-Transkript.",
    },
    unreachable: {
      title: "Transkription: Worker nicht erreichbar",
      detail:
        "Ein Worker ist konfiguriert, antwortet aber nicht. Prüfe, ob er läuft und /health mit HTTP 200 beantwortet.",
    },
    reachable: {
      title: "Transkription: Worker bereit",
      detail:
        "Der Worker antwortet. Öffne bei einer Aufnahme die Details und starte „Transkribieren“ — das Transkript wird an der Aufnahme gespeichert.",
    },
  };

  const current = copy[state];

  return (
    <section
      aria-label="Transkriptionsstatus"
      aria-live="polite"
      className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
          <FileText size={21} />
        </div>

        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            {current.title}
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${
                state === "reachable"
                  ? "bg-emerald-400"
                  : state === "loading"
                    ? "animate-pulse bg-cyan-300"
                    : state === "local-only"
                      ? "bg-slate-500"
                      : "bg-amber-300"
              }`}
            />
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            {current.detail}
          </p>
        </div>
      </div>
    </section>
  );
}
