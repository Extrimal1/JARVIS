"use client";

import { useEffect, useState } from "react";
import {
  Check,
  HelpCircle,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useLockBodyScroll } from "@/src/hooks/useLockBodyScroll";
import { useQuiz } from "@/src/lib/db/useModules";
import { createQuizId, type QuizQuestion } from "@/src/lib/quiz";
import type { Entry } from "@/src/lib/study";

type RunState = {
  queue: QuizQuestion[];
  index: number;
  score: number;
  picked: number | null;
  checked: boolean;
};

export function QuizPanel({
  subjects,
  exams,
  topics,
}: {
  subjects: Entry[];
  exams: Entry[];
  topics: Entry[];
}) {
  const quizStore = useQuiz();
  const questions = quizStore.items;
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [question, setQuestion] = useState("");
  const [qSubject, setQSubject] = useState("");
  const [qExam, setQExam] = useState("");
  const [qTopic, setQTopic] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [correctIndex, setCorrectIndex] = useState(0);
  const [explanation, setExplanation] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [run, setRun] = useState<RunState | null>(null);

  useLockBodyScroll(run !== null);

  const runActive = run !== null;

  useEffect(() => {
    if (!runActive) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setRun(null);
      }
    }

    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [runActive]);

  const filtered =
    subjectFilter === "all"
      ? questions
      : questions.filter((item) => item.subject === subjectFilter);

  const finished =
    run !== null && run.checked && run.index === run.queue.length - 1;
  const current = run === null ? null : run.queue[run.index] ?? null;

  function examTitle(id: string | null): string | null {
    if (id === null) return null;
    return exams.find((exam) => exam.id === id)?.title ?? null;
  }

  function topicTitle(id: string | null): string | null {
    if (id === null) return null;
    return topics.find((topic) => topic.id === id)?.title ?? null;
  }

  function openNew() {
    setEditing("new");
    setQuestion("");
    setQSubject(subjectFilter === "all" ? "" : subjectFilter);
    setQExam("");
    setQTopic("");
    setOptions(["", ""]);
    setCorrectIndex(0);
    setExplanation("");
    setFormError(null);
    setConfirmDeleteId(null);
  }

  function openEdit(item: QuizQuestion) {
    setEditing(item.id);
    setQuestion(item.question);
    setQSubject(item.subject);
    setQExam(item.examId === null ? "" : String(item.examId));
    setQTopic(item.topicId === null ? "" : String(item.topicId));
    setOptions([...item.options]);
    setCorrectIndex(item.correctIndex);
    setExplanation(item.explanation);
    setFormError(null);
    setConfirmDeleteId(null);
  }

  function removeOption(index: number) {
    if (options.length <= 2) return;

    setOptions((current) => current.filter((_, i) => i !== index));
    setCorrectIndex((current) =>
      index === current ? 0 : index < current ? current - 1 : current,
    );
  }

  async function saveQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing === null) return;

    const trimmed = options.map((option) => option.trim());
    const kept = trimmed
      .map((text, index) => ({ text, wasCorrect: index === correctIndex }))
      .filter((option) => option.text !== "");
    const correct = kept.findIndex((option) => option.wasCorrect);

    if (question.trim() === "") {
      setFormError("Bitte gib eine Frage ein.");
      return;
    }

    if (qSubject === "") {
      setFormError("Bitte wähle ein Fach.");
      return;
    }

    if (kept.length < 2) {
      setFormError("Bitte gib mindestens zwei Antwortmöglichkeiten ein.");
      return;
    }

    if (correct === -1) {
      setFormError("Die richtige Antwort darf nicht leer sein.");
      return;
    }

    const entry: QuizQuestion = {
      id: editing === "new" ? createQuizId() : editing,
      subject: qSubject,
      examId: qExam === "" ? null : qExam,
      topicId: qTopic === "" ? null : qTopic,
      question: question.trim(),
      options: kept.map((option) => option.text),
      correctIndex: correct,
      explanation: explanation.trim(),
    };

    const result =
      editing === "new"
        ? await quizStore.create(entry)
        : await quizStore.update(entry.id, entry);

    if (!result.ok) {
      setFormError(`Speichern fehlgeschlagen: ${result.error}`);
      return;
    }

    setEditing(null);
    setFormError(null);
  }

  async function deleteQuestion(id: string) {
    await quizStore.remove(id);
    setConfirmDeleteId(null);
  }

  function startQuiz() {
    if (filtered.length === 0) return;

    const queue = [...filtered];

    for (let i = queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }

    setRun({ queue, index: 0, score: 0, picked: null, checked: false });
  }

  function checkAnswer() {
    setRun((current) => {
      if (current === null || current.picked === null || current.checked) {
        return current;
      }

      const correct =
        current.queue[current.index]?.correctIndex === current.picked;

      return {
        ...current,
        checked: true,
        score: current.score + (correct ? 1 : 0),
      };
    });
  }

  function nextQuestion() {
    setRun((current) => {
      if (current === null || !current.checked) return current;

      return {
        ...current,
        index: current.index + 1,
        picked: null,
        checked: false,
      };
    });
  }

  return (
    <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
            <HelpCircle size={21} />
          </div>

          <div>
            <h2 className="font-semibold">Übungsfragen</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Deine eigenen Fragen – manuell erstellt, keine KI.
            </p>
            <p className="mt-2 text-xs text-cyan-300">
              {questions.length}{" "}
              {questions.length === 1 ? "Frage" : "Fragen"}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <button
            onClick={startQuiz}
            disabled={filtered.length === 0}
            className="flex items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play size={15} />
            Quiz starten
          </button>
          <button
            onClick={openNew}
            className="flex items-center gap-1 rounded-xl border border-white/10 px-3 py-2.5 text-sm text-slate-300 transition hover:border-cyan-300/30"
          >
            <Plus size={15} />
            Frage
          </button>
        </div>
      </div>

      {quizStore.loading ? (
        <p className="mt-5 text-sm text-slate-500">Fragen werden geladen …</p>
      ) : quizStore.error !== null ? (
        <div
          role="alert"
          className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/25 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"
        >
          <span className="min-w-0 flex-1">
            Fragen konnten nicht geladen werden: {quizStore.error}
          </span>
          <button
            onClick={() => void quizStore.refresh()}
            className="rounded-xl border border-rose-300/30 px-3 py-1.5 text-xs transition hover:bg-rose-400/10"
          >
            Erneut versuchen
          </button>
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <select
              value={subjectFilter}
              onChange={(change) => setSubjectFilter(change.target.value)}
              aria-label="Fragen nach Fach filtern"
              className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-xs text-white outline-none focus:border-cyan-300/50"
            >
              <option value="all">Alle Fächer</option>
              {subjects.map((subject) => (
                <option key={subject.id} value={subject.title}>
                  {subject.title}
                </option>
              ))}
            </select>

            {subjectFilter !== "all" && (
              <p className="text-xs text-slate-500">
                {filtered.length}{" "}
                {filtered.length === 1 ? "Frage" : "Fragen"} in diesem
                Fach
              </p>
            )}
          </div>

          {editing !== null && (
            <form
              onSubmit={saveQuestion}
              noValidate
              className="mt-4 space-y-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4"
            >
              <label className="block text-xs text-slate-400">
                Frage
                <textarea
                  autoFocus
                  value={question}
                  onChange={(change) => {
                    setQuestion(change.target.value);
                    setFormError(null);
                  }}
                  placeholder="z. B. Was ist Vererbung in Java?"
                  maxLength={500}
                  rows={2}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-xs text-slate-400">
                  Fach
                  <select
                    value={qSubject}
                    onChange={(change) => {
                      setQSubject(change.target.value);
                      setFormError(null);
                    }}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  >
                    <option value="">Fach wählen …</option>
                    {subjects.map((subject) => (
                      <option key={subject.id} value={subject.title}>
                        {subject.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block text-xs text-slate-400">
                  Prüfung (optional)
                  <select
                    value={qExam}
                    onChange={(change) => setQExam(change.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  >
                    <option value="">Keine Prüfung</option>
                    {exams.map((exam) => (
                      <option key={exam.id} value={exam.id}>
                        {exam.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block text-xs text-slate-400">
                  Thema (optional)
                  <select
                    value={qTopic}
                    onChange={(change) => setQTopic(change.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  >
                    <option value="">Kein Thema</option>
                    {topics.map((topic) => (
                      <option key={topic.id} value={topic.id}>
                        {topic.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <fieldset>
                <legend className="text-xs text-slate-400">
                  Antworten (richtige markieren)
                </legend>
                <div className="mt-2 space-y-2">
                  {options.map((option, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={correctIndex === index}
                        aria-label={`Antwort ${index + 1} als richtig markieren`}
                        onClick={() => setCorrectIndex(index)}
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition ${
                          correctIndex === index
                            ? "border-emerald-400 bg-emerald-400 text-slate-950"
                            : "border-slate-600 text-transparent hover:border-slate-400"
                        }`}
                      >
                        <Check size={13} />
                      </button>
                      <input
                        value={option}
                        onChange={(change) => {
                          const next = [...options];
                          next[index] = change.target.value;
                          setOptions(next);
                          setFormError(null);
                        }}
                        placeholder={`Antwort ${index + 1}`}
                        maxLength={200}
                        aria-label={`Antwort ${index + 1}`}
                        className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                      />
                      {options.length > 2 && (
                        <button
                          type="button"
                          onClick={() => removeOption(index)}
                          aria-label={`Antwort ${index + 1} entfernen`}
                          className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {options.length < 6 && (
                  <button
                    type="button"
                    onClick={() =>
                      setOptions((current) => [...current, ""])
                    }
                    className="mt-2 text-xs text-cyan-300/80 transition hover:text-cyan-200"
                  >
                    + Antwort hinzufügen
                  </button>
                )}
              </fieldset>

              <label className="block text-xs text-slate-400">
                Erklärung (optional)
                <textarea
                  value={explanation}
                  onChange={(change) => setExplanation(change.target.value)}
                  placeholder="Warum ist diese Antwort richtig?"
                  maxLength={500}
                  rows={2}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                />
              </label>

              {formError !== null && (
                <p role="alert" className="text-xs text-rose-300">
                  {formError}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex-1 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                >
                  {editing === "new" ? "Frage speichern" : "Speichern"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setFormError(null);
                  }}
                  className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                >
                  Abbrechen
                </button>
              </div>
            </form>
          )}

          <div className="mt-4">
            {questions.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                Noch keine Übungsfragen vorhanden. Erstelle deine erste
                Frage, um dich selbst abzufragen.
              </div>
            ) : filtered.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                Keine Fragen in diesem Fach.
              </div>
            ) : (
              <ul className="space-y-2">
                {filtered.map((item) => {
                  const exam = examTitle(item.examId);
                  const topic = topicTitle(item.topicId);

                  return (
                    <li
                      key={item.id}
                      className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-sm text-slate-200">
                            {item.question}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <span className="rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[10px] text-cyan-200">
                              {item.subject}
                            </span>
                            {exam !== null && (
                              <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-slate-400">
                                {exam}
                              </span>
                            )}
                            {topic !== null && (
                              <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-slate-400">
                                {topic}
                              </span>
                            )}
                            <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-slate-400">
                              {item.options.length} Antworten
                            </span>
                          </div>
                        </div>

                        <div className="flex shrink-0 gap-1">
                          <button
                            onClick={() => openEdit(item)}
                            aria-label={`Frage bearbeiten: ${item.question}`}
                            title="Bearbeiten"
                            className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(item.id)}
                            aria-label={`Frage löschen: ${item.question}`}
                            title="Löschen"
                            className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>

                      {confirmDeleteId === item.id && (
                        <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/5 p-4">
                          <p className="text-sm text-rose-200">
                            Diese Frage wirklich löschen?
                          </p>
                          <div className="mt-3 flex gap-2">
                            <button
                              onClick={() => deleteQuestion(item.id)}
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
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {run !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="quiz-run-title"
          className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
        >
          <button
            aria-label="Quiz beenden"
            onClick={() => setRun(null)}
            className="absolute inset-0 h-full w-full cursor-default bg-black/70"
          />

          <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-white/10 bg-[#0d111b] p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="quiz-run-title" className="text-lg font-semibold">
                  {finished ? "Ergebnis" : `Frage ${run.index + 1} von ${run.queue.length}`}
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  Richtig: {run.score} · Manuell erstellte Fragen
                </p>
              </div>
              <button
                onClick={() => setRun(null)}
                aria-label="Quiz beenden"
                className="rounded-xl border border-white/10 p-2 text-slate-400 transition hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            {finished || current === null ? (
              <div className="mt-6 text-center">
                <p className="text-4xl font-semibold tabular-nums text-cyan-200">
                  {run.score} / {run.queue.length}
                </p>
                <p className="mt-2 text-sm text-slate-400">
                  {run.score === run.queue.length
                    ? "Perfekt – stark!"
                    : run.score / run.queue.length >= 0.8
                      ? "Stark – fast alles richtig!"
                      : run.score / run.queue.length >= 0.5
                        ? "Solide – weiter üben."
                        : "Nicht aufgeben – versuch es erneut."}
                </p>
                <div className="mt-6 flex gap-2">
                  <button
                    onClick={startQuiz}
                    className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                  >
                    <RotateCcw size={16} />
                    Nochmal
                  </button>
                  <button
                    onClick={() => setRun(null)}
                    className="rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
                  >
                    Schließen
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-5">
                <p className="text-sm font-medium leading-6 text-slate-100">
                  {current.question}
                </p>

                <div className="mt-4 space-y-2" role="radiogroup" aria-label="Antwortmöglichkeiten">
                  {current.options.map((option, index) => {
                    const picked = run.picked === index;
                    const correct =
                      run.checked && index === current.correctIndex;
                    const wrong =
                      run.checked && picked && index !== current.correctIndex;

                    return (
                      <button
                        key={index}
                        role="radio"
                        aria-checked={picked}
                        disabled={run.checked}
                        onClick={() =>
                          setRun((state) =>
                            state === null || state.checked
                              ? state
                              : { ...state, picked: index },
                          )
                        }
                        className={`flex w-full items-center gap-3 rounded-2xl border p-4 text-left text-sm transition ${
                          correct
                            ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-100"
                            : wrong
                              ? "border-rose-400/50 bg-rose-400/10 text-rose-100"
                              : picked
                                ? "border-cyan-300/50 bg-cyan-300/10 text-cyan-100"
                                : "border-white/10 text-slate-300 hover:border-white/25"
                        } ${run.checked ? "" : "cursor-pointer"}`}
                      >
                        <span
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                            correct
                              ? "border-emerald-400 bg-emerald-400 text-slate-950"
                              : wrong
                                ? "border-rose-400 bg-rose-400 text-slate-950"
                                : picked
                                  ? "border-cyan-300 bg-cyan-300 text-slate-950"
                                  : "border-slate-600 text-slate-500"
                          }`}
                        >
                          {correct || (picked && !run.checked) ? (
                            <Check size={13} />
                          ) : (
                            String.fromCharCode(65 + index)
                          )}
                        </span>
                        <span className="min-w-0 flex-1">{option}</span>
                      </button>
                    );
                  })}
                </div>

                {run.checked && (
                  <div
                    className={`mt-4 rounded-2xl border p-4 text-sm leading-6 ${
                      run.picked === current.correctIndex
                        ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-100"
                        : "border-rose-400/30 bg-rose-400/5 text-rose-100"
                    }`}
                  >
                    <p className="flex items-center gap-2 font-medium">
                      {run.picked === current.correctIndex ? (
                        <>
                          <Check size={16} /> Richtig!
                        </>
                      ) : (
                        <>Falsch – richtig wäre: {current.options[current.correctIndex]}</>
                      )}
                    </p>
                    {current.explanation !== "" && (
                      <p className="mt-2 text-slate-300">
                        {current.explanation}
                      </p>
                    )}
                  </div>
                )}

                <div className="mt-5 flex gap-2">
                  {!run.checked ? (
                    <button
                      onClick={checkAnswer}
                      disabled={run.picked === null}
                      className="flex-1 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Prüfen
                    </button>
                  ) : (
                    <button
                      onClick={nextQuestion}
                      className="flex-1 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                    >
                      {run.index === run.queue.length - 1
                        ? "Zum Ergebnis"
                        : "Weiter"}
                    </button>
                  )}
                  <button
                    onClick={() => setRun(null)}
                    className="rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
                  >
                    Abbrechen
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
