"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Pencil, Plus, Trash2 } from "lucide-react";
import {
  listDocuments,
  type DocumentMeta,
} from "@/src/lib/documents";
import { createId } from "@/src/lib/ids";
import { formatDaysLeft } from "@/src/lib/briefing";
import type { Entry, ExamAvailability, StudyData } from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { ListResource } from "@/src/lib/db/useRemoteResource";
import type { StudyResource } from "@/src/lib/db/useModules";
import {
  checkExamLinks,
  defaultExamData,
  examCandidates,
  normalizeAvailability,
  planExamDelete,
  upcomingExams,
  validateAvailability,
} from "@/src/lib/study/exams";

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

type ExamDraft = {
  date: string;
  subject: string;
  detail: string;
  documentIds: string[];
  topicIds: string[];
  availability: ExamAvailability;
};

function draftOf(exam: Entry): ExamDraft {
  return {
    date: exam.date ?? "",
    subject: exam.subject ?? "",
    detail: exam.detail,
    documentIds: [...(exam.examData?.documentIds ?? [])],
    topicIds: [...(exam.examData?.topicIds ?? [])],
    availability: normalizeAvailability(exam.examData?.availability),
  };
}

function availabilitySummary(exam: Entry): string {
  const availability = normalizeAvailability(exam.examData?.availability);
  const total = availability.weekly.reduce((sum, minutes) => sum + minutes, 0);
  const exceptions = Object.keys(availability.exceptions).length;

  return `${total} Min/Woche${exceptions === 0 ? "" : ` · ${exceptions} ${exceptions === 1 ? "Ausnahme" : "Ausnahmen"}`}`;
}

/**
 * Exam management card: multiple exams per subject, linked
 * documents/topics, and flexible per-exam availability. Each
 * exam owns its preparation state; deleting an exam only
 * clears question links — questions and history are kept.
 */
export function ExamManager({
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
  const [date, setDate] = useState("");
  const [subject, setSubject] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExamDraft | null>(null);
  const [exceptionDate, setExceptionDate] = useState("");
  const [exceptionMinutes, setExceptionMinutes] = useState("60");
  const [exceptionOff, setExceptionOff] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
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

  const today = useMemo(() => {
    const now = new Date();

    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }, []);
  const ordered = useMemo(
    () => upcomingExams(data.exams, today),
    [data.exams, today],
  );

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!name.trim() || busy) return;

    setBusy(true);
    setError(null);

    try {
      await studyStore.addEntry("exams", {
        id: createId(),
        title: name.trim(),
        detail: detail.trim(),
        ...(date ? { date } : {}),
        ...(subject ? { subject } : {}),
        examData: defaultExamData(),
      });
      setName("");
      setDetail("");
      setDate("");
      setSubject("");
      setExpanded(false);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "Speichern fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  function startEditing(exam: Entry) {
    setEditing(exam.id);
    setDraft(draftOf(exam));
    setDeleting(null);
    setError(null);
  }

  async function saveEditing(exam: Entry) {
    if (draft === null || busy) return;

    const availabilityError = validateAvailability(draft.availability);

    if (availabilityError !== null) {
      setError(availabilityError);

      return;
    }

    const examData = {
      documentIds: draft.documentIds,
      topicIds: draft.topicIds,
      availability: draft.availability,
    };
    const links = checkExamLinks(examData, docs, data.topics);

    if (
      links.unknownDocuments.length > 0 ||
      links.unknownTopics.length > 0
    ) {
      setError("Unbekannte Verknüpfung — bitte Auswahl prüfen.");

      return;
    }

    setBusy(true);
    setError(null);

    try {
      // Explicit null clears optional fields server-side.
      await studyStore.updateEntry(exam.id, {
        detail: draft.detail,
        date: (draft.date === "" ? null : draft.date) as string,
        subject: (draft.subject === "" ? null : draft.subject) as string,
        examData,
      } as Partial<Entry>);
      setEditing(null);
      setDraft(null);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Speichern fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function applyDelete(exam: Entry) {
    setBusy(true);
    setError(null);

    try {
      for (const patch of planExamDelete(quizStore.items, exam.id)) {
        await quizStore.update(patch.id, { examId: patch.examId });
      }

      await studyStore.deleteEntry("exams", exam.id);
      setDeleting(null);
      setEditing(null);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "Löschen fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  function toggleId(list: string[], id: string): string[] {
    return list.includes(id)
      ? list.filter((entry) => entry !== id)
      : [...list, id];
  }

  return (
    <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
            <CalendarDays size={21} />
          </div>

          <div>
            <h2 className="font-semibold">Prüfungen</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Behalte Prüfungstermine im Blick.
            </p>
            <p className="mt-2 text-xs text-cyan-300">
              {data.exams.length} Einträge
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
              placeholder="z. B. Java-Klausur"
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

          <label className="block text-xs text-slate-400">
            Prüfungstermin
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
          </label>

          {data.subjects.length > 0 && (
            <label className="block text-xs text-slate-400">
              Fach
              <select
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
              >
                <option value="">Kein Fach zugeordnet</option>
                {data.subjects.map((item) => (
                  <option key={item.id} value={item.title}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
          )}

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
        {ordered.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
            Noch keine Einträge vorhanden.
          </div>
        )}

        {ordered.map(({ exam, daysLeft }) => {
          const linkedDocs = exam.examData?.documentIds.length ?? 0;
          const linkedTopics = exam.examData?.topicIds.length ?? 0;
          const linkedQuestions = quizStore.items.filter(
            (question) => question.examId === exam.id,
          ).length;
          const candidates = examCandidates(exam, docs, data.topics);
          const isEditing = editing === exam.id && draft !== null;

          return (
            <div
              key={exam.id}
              className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
            >
              <div className="flex items-start gap-3">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-cyan-300" />

                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200">{exam.title}</p>

                  {exam.detail && (
                    <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                      {exam.detail}
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap gap-2">
                    {exam.date && (
                      <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-slate-400">
                        {new Intl.DateTimeFormat("de-DE", {
                          dateStyle: "medium",
                          timeZone: "UTC",
                        }).format(new Date(`${exam.date}T12:00:00Z`))}
                        {daysLeft !== null && daysLeft >= 0
                          ? ` · ${formatDaysLeft(daysLeft)}`
                          : ""}
                      </span>
                    )}

                    {exam.subject && (
                      <span className="rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[10px] text-cyan-200">
                        {exam.subject}
                      </span>
                    )}

                    <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-slate-400">
                      {linkedDocs} {linkedDocs === 1 ? "Dokument" : "Dokumente"} ·{" "}
                      {linkedTopics} {linkedTopics === 1 ? "Thema" : "Themen"} ·{" "}
                      {linkedQuestions} {linkedQuestions === 1 ? "Frage" : "Fragen"}
                    </span>

                    <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-slate-400">
                      {availabilitySummary(exam)}
                    </span>
                  </div>
                </div>

                <button
                  onClick={() =>
                    isEditing ? setEditing(null) : startEditing(exam)
                  }
                  aria-label={`Prüfung bearbeiten: ${exam.title}`}
                  title="Bearbeiten"
                  className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-cyan-300/10 hover:text-cyan-200"
                >
                  <Pencil size={15} />
                </button>

                <button
                  onClick={() => {
                    setDeleting(deleting === exam.id ? null : exam.id);
                    setEditing(null);
                  }}
                  aria-label={`Prüfung löschen: ${exam.title}`}
                  title="Löschen"
                  className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                >
                  <Trash2 size={15} />
                </button>
              </div>

              {isEditing && draft !== null && (
                <div className="jarvis-fade mt-3 space-y-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4">
                  <label className="block text-xs text-slate-400">
                    Beschreibung
                    <input
                      value={draft.detail}
                      onChange={(event) =>
                        setDraft({ ...draft, detail: event.target.value })
                      }
                      className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/50"
                    />
                  </label>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-xs text-slate-400">
                      Prüfungstermin
                      <input
                        type="date"
                        value={draft.date}
                        onChange={(event) =>
                          setDraft({ ...draft, date: event.target.value })
                        }
                        className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/50"
                      />
                    </label>

                    {data.subjects.length > 0 && (
                      <label className="block text-xs text-slate-400">
                        Fach
                        <select
                          value={draft.subject}
                          onChange={(event) =>
                            setDraft({ ...draft, subject: event.target.value })
                          }
                          className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/50"
                        >
                          <option value="">Kein Fach zugeordnet</option>
                          {data.subjects.map((item) => (
                            <option key={item.id} value={item.title}>
                              {item.title}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <fieldset>
                      <legend className="text-xs text-slate-400">
                        Dokumente ({draft.documentIds.length})
                      </legend>
                      <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-2">
                        {candidates.docs.length === 0 && (
                          <p className="px-2 py-1 text-xs text-slate-600">
                            Keine Dokumente{exam.subject ? " für dieses Fach" : ""}.
                          </p>
                        )}
                        {candidates.docs.map((candidate) => (
                          <label
                            key={candidate.id}
                            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-white/5"
                          >
                            <input
                              type="checkbox"
                              checked={draft.documentIds.includes(candidate.id)}
                              onChange={() =>
                                setDraft({
                                  ...draft,
                                  documentIds: toggleId(
                                    draft.documentIds,
                                    candidate.id,
                                  ),
                                })
                              }
                              className="h-4 w-4 accent-cyan-300"
                            />
                            <span className="min-w-0 flex-1 truncate">
                              {candidate.name}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <fieldset>
                      <legend className="text-xs text-slate-400">
                        Themen ({draft.topicIds.length})
                      </legend>
                      <div className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-black/20 p-2">
                        {candidates.topics.length === 0 && (
                          <p className="px-2 py-1 text-xs text-slate-600">
                            Keine Themen{exam.subject ? " für dieses Fach" : ""}.
                          </p>
                        )}
                        {candidates.topics.map((candidate) => (
                          <label
                            key={candidate.id}
                            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-slate-300 hover:bg-white/5"
                          >
                            <input
                              type="checkbox"
                              checked={draft.topicIds.includes(candidate.id)}
                              onChange={() =>
                                setDraft({
                                  ...draft,
                                  topicIds: toggleId(
                                    draft.topicIds,
                                    candidate.id,
                                  ),
                                })
                              }
                              className="h-4 w-4 accent-cyan-300"
                            />
                            <span className="min-w-0 flex-1 truncate">
                              {candidate.title}
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  </div>

                  <fieldset>
                    <legend className="text-xs text-slate-400">
                      Verfügbarkeit (Minuten pro Wochentag)
                    </legend>
                    <div className="mt-2 grid grid-cols-7 gap-1">
                      {WEEKDAYS.map((day, index) => (
                        <label
                          key={day}
                          className="block text-center text-[10px] text-slate-500"
                        >
                          {day}
                          <input
                            type="number"
                            min={0}
                            max={720}
                            value={draft.availability.weekly[index] ?? 0}
                            onChange={(event) => {
                              const weekly = [
                                ...draft.availability.weekly,
                              ] as ExamAvailability["weekly"];
                              weekly[index] = Math.max(
                                0,
                                Number.parseInt(event.target.value, 10) || 0,
                              );
                              setDraft({
                                ...draft,
                                availability: {
                                  ...draft.availability,
                                  weekly,
                                },
                              });
                            }}
                            className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-1 py-1.5 text-center text-xs text-white outline-none focus:border-cyan-300/50"
                          />
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <fieldset>
                    <legend className="text-xs text-slate-400">
                      Ausnahmen (einzelne Tage)
                    </legend>
                    {Object.entries(draft.availability.exceptions).length >
                      0 && (
                      <div className="mt-2 space-y-1">
                        {Object.entries(draft.availability.exceptions).map(
                          ([day, minutes]) => (
                            <div
                              key={day}
                              className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2 py-1.5 text-xs text-slate-300"
                            >
                              <span className="flex-1 tabular-nums">{day}</span>
                              <span className="text-slate-500">
                                {minutes === null ? "frei" : `${minutes} Min`}
                              </span>
                              <button
                                onClick={() => {
                                  const exceptions = {
                                    ...draft.availability.exceptions,
                                  };
                                  delete exceptions[day];
                                  setDraft({
                                    ...draft,
                                    availability: {
                                      ...draft.availability,
                                      exceptions,
                                    },
                                  });
                                }}
                                aria-label={`Ausnahme entfernen: ${day}`}
                                className="rounded p-1 text-slate-500 hover:text-rose-300"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          ),
                        )}
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <input
                        type="date"
                        value={exceptionDate}
                        onChange={(event) => setExceptionDate(event.target.value)}
                        aria-label="Ausnahmedatum"
                        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#111827] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50"
                      />
                      <input
                        type="number"
                        min={0}
                        max={720}
                        value={exceptionMinutes}
                        disabled={exceptionOff}
                        onChange={(event) =>
                          setExceptionMinutes(event.target.value)
                        }
                        aria-label="Minuten"
                        className="w-20 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50 disabled:opacity-40"
                      />
                      <label className="flex items-center gap-1 text-xs text-slate-400">
                        <input
                          type="checkbox"
                          checked={exceptionOff}
                          onChange={(event) =>
                            setExceptionOff(event.target.checked)
                          }
                          className="h-4 w-4 accent-cyan-300"
                        />
                        frei
                      </label>
                      <button
                        onClick={() => {
                          if (exceptionDate === "") return;

                          setDraft({
                            ...draft,
                            availability: {
                              ...draft.availability,
                              exceptions: {
                                ...draft.availability.exceptions,
                                [exceptionDate]: exceptionOff
                                  ? null
                                  : Math.max(
                                      0,
                                      Number.parseInt(exceptionMinutes, 10) || 0,
                                    ),
                              },
                            },
                          });
                          setExceptionDate("");
                          setExceptionOff(false);
                        }}
                        className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:border-cyan-300/30"
                      >
                        Hinzufügen
                      </button>
                    </div>
                  </fieldset>

                  <div className="flex gap-2">
                    <button
                      onClick={() => void saveEditing(exam)}
                      disabled={busy}
                      className="flex-1 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:opacity-50"
                    >
                      Speichern
                    </button>
                    <button
                      onClick={() => {
                        setEditing(null);
                        setDraft(null);
                      }}
                      className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                    >
                      Abbrechen
                    </button>
                  </div>
                </div>
              )}

              {deleting === exam.id && (
                <div className="jarvis-fade mt-3 rounded-2xl border border-rose-400/20 bg-rose-400/[0.04] p-4">
                  <p className="text-xs leading-5 text-slate-300">
                    „{exam.title}“ löschen?{" "}
                    {linkedQuestions === 0
                      ? "Es bleiben keine Fragen übrig."
                      : `${linkedQuestions} ${linkedQuestions === 1 ? "Frage bleibt" : "Fragen bleiben"} erhalten — nur die Prüfungsverknüpfung wird gelöst.`}{" "}
                    Dokumente und Themen sind nicht betroffen.
                  </p>

                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => void applyDelete(exam)}
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
