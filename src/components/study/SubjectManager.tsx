"use client";

import { useEffect, useState } from "react";
import { GraduationCap, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import {
  listDocuments,
  updateDocumentMeta,
  type DocumentMeta,
} from "@/src/lib/documents";
import { createId } from "@/src/lib/ids";
import type { Entry, StudyData } from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { ListResource } from "@/src/lib/db/useRemoteResource";
import type { StudyResource } from "@/src/lib/db/useModules";
import {
  planSubjectDelete,
  planSubjectRename,
} from "@/src/lib/study/exams";

type SectionKey = keyof StudyData;

/**
 * Subject management card: create/rename/delete with lossless
 * cascade. Rename updates every title-linked record; delete
 * reassigns to a target subject or detaches links — documents,
 * questions, and history are never deleted with the subject.
 */
export function SubjectManager({
  data,
  studyStore,
  quizStore,
}: {
  data: StudyData;
  studyStore: StudyResource;
  quizStore: ListResource<QuizQuestion>;
}) {
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [detail, setDetail] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    listDocuments()
      .then((items) => {
        if (!cancelled) setDocs(items);
      })
      .catch(() => {
        if (!cancelled) setDocs([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!name.trim() || busy) return;

    if (
      data.subjects.some(
        (subject) => subject.title === name.trim(),
      )
    ) {
      setError("Ein Fach mit diesem Namen existiert bereits.");

      return;
    }

    setBusy(true);
    setError(null);

    try {
      await studyStore.addEntry("subjects" as SectionKey, {
        id: createId(),
        title: name.trim(),
        detail: detail.trim(),
      });
      setName("");
      setDetail("");
      setExpanded(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Speichern fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function applyRename(subject: Entry) {
    const planned = planSubjectRename(
      data,
      docs,
      quizStore.items,
      subject.title,
      renameValue,
    );

    if (!planned.ok) {
      setError(planned.error);

      return;
    }

    setBusy(true);
    setError(null);

    try {
      await studyStore.updateEntry(planned.plan.subjectId, {
        title: planned.plan.toTitle,
      });

      for (const patch of planned.plan.entryPatches) {
        await studyStore.updateEntry(patch.id, { subject: patch.subject });
      }

      for (const patch of planned.plan.docPatches) {
        await updateDocumentMeta(patch.id, { subject: patch.subject });
      }

      for (const patch of planned.plan.questionPatches) {
        await quizStore.update(patch.id, { subject: patch.subject });
      }

      setDocs(await listDocuments());
      setRenaming(null);
    } catch (renameError) {
      setError(
        renameError instanceof Error
          ? renameError.message
          : "Umbenennen fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function applyDelete(subject: Entry) {
    const planned = planSubjectDelete(
      data,
      docs,
      quizStore.items,
      subject.title,
      deleteTarget === "" ? null : deleteTarget,
    );

    if (!planned.ok) {
      setError(planned.error);

      return;
    }

    setBusy(true);
    setError(null);

    try {
      for (const patch of planned.plan.entryPatches) {
        // Explicit null detaches: the server clears the column
        // (undefined would be dropped by pickPatch), local mode
        // stores the falsy value and treats it as unassigned.
        await studyStore.updateEntry(patch.id, {
          subject: patch.subject,
        } as Partial<Entry>);
      }

      for (const patch of planned.plan.docPatches) {
        await updateDocumentMeta(patch.id, { subject: patch.subject });
      }

      for (const patch of planned.plan.questionPatches) {
        await quizStore.update(patch.id, { subject: patch.subject });
      }

      await studyStore.deleteEntry("subjects" as SectionKey, planned.plan.subjectId);
      setDocs(await listDocuments());
      setDeleting(null);
      setDeleteTarget("");
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "Löschen fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
            <GraduationCap size={21} />
          </div>

          <div>
            <h2 className="font-semibold">Meine Fächer</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Organisiere deine Studienmodule.
            </p>
            <p className="mt-2 text-xs text-cyan-300">
              {data.subjects.length} Einträge
            </p>
          </div>
        </div>

        <button
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex shrink-0 items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30"
        >
          <Plus size={15} />
          Hinzufügen
        </button>
      </div>

      {expanded && (
        <form
          onSubmit={submit}
          className="jarvis-fade mt-5 space-y-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4"
        >
          <label className="block text-xs text-slate-400">
            Name
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="z. B. Software Engineering"
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
          </label>

          <label className="block text-xs text-slate-400">
            Beschreibung
            <input
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              placeholder="Optionale Beschreibung"
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="flex-1 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:opacity-50"
            >
              Speichern
            </button>

            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}

      {error !== null && (
        <p role="alert" className="mt-4 text-xs text-rose-300">
          {error}
        </p>
      )}

      <div className="mt-5 space-y-2">
        {data.subjects.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
            Noch keine Einträge vorhanden.
          </div>
        )}

        {data.subjects.map((subject) => {
          const docCount = docs.filter(
            (doc) => doc.subject === subject.title,
          ).length;
          const topicCount = data.topics.filter(
            (topic) => topic.subject === subject.title,
          ).length;
          const questionCount = quizStore.items.filter(
            (question) => question.subject === subject.title,
          ).length;
          const others = data.subjects.filter(
            (entry) => entry.id !== subject.id,
          );

          return (
            <div
              key={subject.id}
              className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
            >
              <div className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-cyan-300" />

                <div className="min-w-0 flex-1">
                  {renaming === subject.id ? (
                    <div className="flex gap-2">
                      <input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        aria-label="Fachname"
                        maxLength={120}
                        className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/50"
                      />
                      <button
                        onClick={() => void applyRename(subject)}
                        disabled={busy}
                        className="shrink-0 rounded-xl bg-cyan-300 px-3 py-2 text-xs font-medium text-slate-950 disabled:opacity-50"
                      >
                        OK
                      </button>
                      <button
                        onClick={() => setRenaming(null)}
                        className="shrink-0 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300"
                      >
                        Abbr.
                      </button>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-200">{subject.title}</p>
                  )}

                  {subject.detail && (
                    <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                      {subject.detail}
                    </p>
                  )}

                  <p className="mt-2 text-[11px] text-slate-500">
                    {docCount} {docCount === 1 ? "Dokument" : "Dokumente"} ·{" "}
                    {topicCount} {topicCount === 1 ? "Thema" : "Themen"} ·{" "}
                    {questionCount} {questionCount === 1 ? "Frage" : "Fragen"}
                  </p>
                  <Link
                    href={`/study#dokumente-${encodeURIComponent(subject.title)}`}
                    className="mt-2 inline-block text-xs text-cyan-300/80 transition hover:text-cyan-200"
                  >
                    Zugehörige Dokumente
                  </Link>
                </div>

                <button
                  onClick={() => {
                    setRenaming(subject.id);
                    setRenameValue(subject.title);
                    setDeleting(null);
                  }}
                  aria-label={`Fach umbenennen: ${subject.title}`}
                  title="Umbenennen"
                  className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-cyan-300/10 hover:text-cyan-200"
                >
                  <Pencil size={15} />
                </button>

                <button
                  onClick={() => {
                    setDeleting(
                      deleting === subject.id ? null : subject.id,
                    );
                    setDeleteTarget("");
                    setRenaming(null);
                  }}
                  aria-label={`Fach löschen: ${subject.title}`}
                  title="Löschen"
                  className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                >
                  <Trash2 size={15} />
                </button>
              </div>

              {deleting === subject.id && (
                <div className="jarvis-fade mt-3 rounded-2xl border border-rose-400/20 bg-rose-400/[0.04] p-4">
                  <p className="text-xs leading-5 text-slate-300">
                    „{subject.title}“ löschen? Dokumente, Fragen und Verlauf
                    bleiben erhalten — Verknüpfungen werden{" "}
                    {deleteTarget === ""
                      ? "gelöst"
                      : `nach „${deleteTarget}“ verschoben`}
                    .
                  </p>

                  {others.length > 0 && (
                    <label className="mt-3 block text-xs text-slate-400">
                      Verknüpfungen verschieben nach
                      <select
                        value={deleteTarget}
                        onChange={(event) => setDeleteTarget(event.target.value)}
                        className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/50"
                      >
                        <option value="">Nur lösen (nichts verschieben)</option>
                        {others.map((entry) => (
                          <option key={entry.id} value={entry.title}>
                            {entry.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => void applyDelete(subject)}
                      disabled={busy}
                      className="flex-1 rounded-xl border border-rose-300/30 px-4 py-2 text-xs text-rose-200 transition hover:bg-rose-400/10 disabled:opacity-50"
                    >
                      Endgültig löschen
                    </button>
                    <button
                      onClick={() => setDeleting(null)}
                      className="rounded-xl border border-white/10 px-4 py-2 text-xs text-slate-300 hover:bg-white/5"
                    >
                      Abbrechen
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
