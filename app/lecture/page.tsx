"use client";

import { useState } from "react";
import { ArrowLeft, AudioLines, Play, Trash2, X } from "lucide-react";
import Link from "next/link";
import Sidebar from "@/src/components/Sidebar";
import { RecorderPanel } from "@/src/components/lecture/RecorderPanel";
import { useStudy } from "@/src/lib/db/useModules";
import { EMPTY_STUDY } from "@/src/lib/study";
import {
  clearChunks,
  deleteRecordingAll,
  getAudio,
  listChunks,
  saveAudio,
} from "@/src/lib/lecture/audioStore";
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

export default function LecturePage() {
  const studyStore = useStudy(EMPTY_STUDY);
  const library = useRecordings();
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);

  const subjects = studyStore.data.subjects;
  const interrupted = library.recordings.filter(
    (item) => item.status === "recording",
  );
  const finished = library.recordings.filter(
    (item) => item.status !== "recording",
  );

  function stopPlayback() {
    if (playing !== null) {
      URL.revokeObjectURL(playing.url);
      setPlaying(null);
    }
  }

  async function play(recording: LocalRecording) {
    stopPlayback();
    setPlayError(null);

    try {
      const blob = await getAudio(recording.id);

      if (blob === null) {
        setPlayError(
          `„${recording.title}“: kein Audio gespeichert (nur Metadaten vorhanden).`,
        );
        return;
      }

      setPlaying({ id: recording.id, url: URL.createObjectURL(blob) });
    } catch {
      setPlayError(`„${recording.title}“ konnte nicht geladen werden.`);
    }
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

      const blob = new Blob(chunks, { type: recording.mimeType });
      await saveAudio(recording.id, blob);
      await clearChunks(recording.id).catch(() => undefined);
      await library.saveRecording({
        ...recording,
        sizeBytes: blob.size,
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
    await library.removeRecording(id);
    setConfirmDeleteId(null);

    if (playing?.id === id) {
      stopPlayback();
    }
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
              Vorlesungen aufnehmen, lokal sichern und später
              transkribieren lassen. Transkription und Analyse folgen in
              den nächsten Ausbaustufen.
            </p>
          </header>

          <div className="mt-8 space-y-5">
            <RecorderPanel
              subjects={subjects}
              sessions={library.sessions}
              onCreateSession={library.createSession}
              onSaveRecording={library.saveRecording}
            />

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
                    Browser.
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
                          </div>

                          <div className="flex shrink-0 gap-1">
                            <button
                              onClick={() => void play(recording)}
                              aria-label={`Abspielen: ${recording.title}`}
                              title="Abspielen"
                              className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                            >
                              <Play size={15} />
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

                        {playing?.id === recording.id && (
                          <audio
                            controls
                            autoPlay
                            src={playing.url}
                            onEnded={stopPlayback}
                            className="mt-3 w-full"
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
