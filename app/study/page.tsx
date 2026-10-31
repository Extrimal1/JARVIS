"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  Check,
  FileText,
  GraduationCap,
  Plus,
  Target,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import Sidebar from "@/src/components/Sidebar";
import { createId } from "@/src/lib/ids";
import { useToday } from "@/src/hooks/useToday";
import { DocumentLibrary } from "@/src/components/study/DocumentLibrary";
import { ExamManager } from "@/src/components/study/ExamManager";
import { ExamOverview, type PrepView } from "@/src/components/study/ExamOverview";
import { ProgressView } from "@/src/components/study/ProgressView";
import { QuizPanel } from "@/src/components/study/QuizPanel";
import { RevisionPanel } from "@/src/components/study/RevisionPanel";
import { StudyPlanner } from "@/src/components/study/StudyPlanner";
import { SubjectManager } from "@/src/components/study/SubjectManager";
import { TopicTree } from "@/src/components/study/TopicTree";
import { daysBetween, formatDaysLeft } from "@/src/lib/briefing";
import { markReviewed } from "@/src/lib/revision";
import { useQuiz, useStudy } from "@/src/lib/db/useModules";
import {
  listReviewEvents,
  logReviewEvent,
} from "@/src/lib/db/reviewEvents";
import { computeTopicMastery } from "@/src/lib/study/mastery";
import type { ReviewEvent } from "@/src/lib/study/reviewEvents";
import type { QuizRating } from "@/src/lib/quizReview";
import type { ListResource } from "@/src/lib/db/useRemoteResource";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { QuizReviewPatch } from "@/src/lib/quizReview";
import { type Entry, type StudyData } from "@/src/lib/study";

const initialData: StudyData = {
  subjects: [
    {
      id: "seed-java",
      title: "Programmierung mit Java",
      detail: "Objektorientierte Programmierung",
    },
    {
      id: "seed-mathe",
      title: "Mathematik",
      detail: "Mathematische Grundlagen",
    },
    {
      id: "seed-datenbanken",
      title: "Datenbanken",
      detail: "SQL und relationale Datenbanken",
    },
  ],
  exams: [],
  topics: [],
  materials: [],
};

const sections = [
  {
    key: "topics",
    title: "Lernthemen",
    description: "Verfolge deinen Lernfortschritt.",
    icon: BookOpen,
  },
  {
    key: "materials",
    title: "Lernmaterialien",
    description: "Verwalte Skripte, Dokumente, Links und Notizen.",
    icon: FileText,
  },
] as const;

type SectionKey = keyof StudyData;

function StudySection({
  sectionKey,
  title,
  description,
  icon: Icon,
  items,
  subjects,
  onAdd,
  onDelete,
  onToggle,
  quizStore,
}: {
  sectionKey: SectionKey;
  title: string;
  description: string;
  icon: React.ElementType;
  items: Entry[];
  subjects: Entry[];
  onAdd: (key: SectionKey, entry: Entry) => void;
  onDelete: (key: SectionKey, id: string) => void;
  onToggle: (id: string) => void;
  /** Shared quiz store, used only by the materials section. */
  quizStore?: ListResource<QuizQuestion>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [detail, setDetail] = useState("");
  const [date, setDate] = useState("");
  const [subject, setSubject] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!name.trim()) return;

    await onAdd(sectionKey, {
      id: createId(),
      title: name.trim(),
      detail: detail.trim(),
      ...(date ? { date } : {}),
      ...(subject ? { subject } : {}),
      ...(sectionKey === "topics" ? { done: false } : {}),
    });

    setName("");
    setDetail("");
    setDate("");
    setSubject("");
    setExpanded(false);
  }

  return (
    <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
            <Icon size={21} />
          </div>

          <div>
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {description}
            </p>
            <p className="mt-2 text-xs text-cyan-300">
              {items.length} Einträge
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
              placeholder={
                sectionKey === "subjects"
                  ? "z. B. Software Engineering"
                  : sectionKey === "exams"
                    ? "z. B. Java-Klausur"
                    : sectionKey === "topics"
                      ? "z. B. Vererbung"
                      : "z. B. Vorlesung 1 – PDF"
              }
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

          {(sectionKey === "exams" || sectionKey === "topics") && (
            <label className="block text-xs text-slate-400">
              {sectionKey === "exams" ? "Prüfungstermin" : "Lernfrist"}
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
              />
            </label>
          )}

          {(sectionKey === "exams" ||
            sectionKey === "topics" ||
            sectionKey === "materials") &&
            subjects.length > 0 && (
              <label className="block text-xs text-slate-400">
                Fach
                <select
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
                >
                  <option value="">Kein Fach zugeordnet</option>
                  {subjects.map((item) => (
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
              className="flex-1 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
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

      <div className="mt-5 space-y-2">
        {items.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
            Noch keine Einträge vorhanden.
          </div>
        )}

        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-start gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
          >
            {sectionKey === "topics" ? (
              <button
                onClick={() => onToggle(item.id)}
                aria-label="Lernstatus ändern"
                aria-pressed={Boolean(item.done)}
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                  item.done
                    ? "border-cyan-300 bg-cyan-300 text-slate-950"
                    : "border-slate-600 text-transparent"
                }`}
              >
                <Check size={12} />
              </button>
            ) : (
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-cyan-300" />
            )}

            <div className="min-w-0 flex-1">
              <p
                className={`text-sm ${
                  item.done
                    ? "text-slate-500 line-through"
                    : "text-slate-200"
                }`}
              >
                {item.title}
              </p>

              {item.detail && (
                <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                  {item.detail}
                </p>
              )}

              {(item.date || item.subject) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.date && (
                    <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-slate-400">
                      {new Intl.DateTimeFormat("de-DE", {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      }).format(new Date(`${item.date}T12:00:00Z`))}
                    </span>
                  )}

                  {item.subject && (
                    <span className="rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[10px] text-cyan-200">
                      {item.subject}
                    </span>
                  )}
                </div>
              )}
              {sectionKey === "subjects" && (
                <Link
                  href={`/study#dokumente-${encodeURIComponent(item.title)}`}
                  className="mt-2 inline-block text-xs text-cyan-300/80 transition hover:text-cyan-200"
                >
                  Zugehörige Dokumente
                </Link>
              )}
              {sectionKey === "topics" && item.subject && (
                <Link
                  href={`/study#dokumente-${encodeURIComponent(item.subject)}`}
                  className="mt-2 inline-block text-xs text-cyan-300/80 transition hover:text-cyan-200"
                >
                  Zugehörige Dokumente
                </Link>
              )}
            </div>

            <button
              onClick={() => onDelete(sectionKey, item.id)}
              aria-label={`Eintrag löschen: ${item.title}`}
              title="Löschen"
              className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>

      {sectionKey === "materials" && (
        <div className="mt-6 border-t border-white/[0.06] pt-6">
          <DocumentLibrary
            subjects={subjects}
            onSaveMaterial={async (entry) => {
              await onAdd("materials", entry);
            }}
            quizStore={quizStore}
          />
        </div>
      )}
    </section>
  );
}

type StudyTab = "overview" | "documents" | "prep";

const STUDY_TABS: { key: StudyTab; label: string }[] = [
  { key: "overview", label: "Übersicht" },
  { key: "documents", label: "Dokumente" },
  { key: "prep", label: "Prüfungsvorbereitung" },
];

const PREP_TABS: { key: PrepView; label: string }[] = [
  { key: "overview", label: "Übersicht" },
  { key: "exams", label: "Meine Prüfungen" },
  { key: "topics", label: "Themen" },
  { key: "plan", label: "Lernplan" },
  { key: "progress", label: "Fortschritt" },
];

export default function StudyPage() {
  const studyStore = useStudy(initialData);
  const quizStore = useQuiz();
  const data = studyStore.data;
  const [tab, setTab] = useState<StudyTab>("overview");
  const [prepTab, setPrepTab] = useState<PrepView>("overview");
  const [planFocus, setPlanFocus] = useState<string | null>(null);

  useEffect(() => {
    // Deep links from subject/topic rows open the documents tab.
    if (
      typeof window !== "undefined" &&
      window.location.hash.startsWith("#dokumente-")
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTab("documents");
    }
  }, []);

  function openPrep(view: PrepView, examId?: string) {
    if (examId !== undefined) setPlanFocus(examId);

    setPrepTab(view);
  }

  async function addEntry(key: SectionKey, entry: Entry) {
    await studyStore.addEntry(key, entry);
  }

  async function deleteEntry(key: SectionKey, id: string) {
    await studyStore.deleteEntry(key, id);
  }

  async function toggleTopic(id: string) {
    await studyStore.updateEntry(id, {
      done: data.topics.find((item) => item.id === id)?.done !== true,
    });
  }

  async function reviewTopic(id: string, todayISO: string) {
    const topic = data.topics.find((item) => item.id === id);

    if (topic === undefined) return;

    const reviewed = markReviewed(topic, todayISO);

    await studyStore.updateEntry(id, {
      lastReviewedAt: reviewed.lastReviewedAt,
      reviewStage: reviewed.reviewStage,
      done: reviewed.done,
    });
  }

  const [reviewEvents, setReviewEvents] = useState<ReviewEvent[]>([]);

  useEffect(() => {
    let cancelled = false;

    listReviewEvents()
      .then((events) => {
        if (!cancelled) setReviewEvents(events);
      })
      .catch(() => {
        if (!cancelled) setReviewEvents([]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function reviewQuestion(
    id: string,
    patch: QuizReviewPatch,
    info: { correct: boolean; rating: QuizRating },
  ) {
    const result = await quizStore.update(id, patch);

    if (!result.ok) return result;

    // History + mastery refresh are best-effort: the quiz update
    // already succeeded, so failures here must not fail the review.
    try {
      const current = quizStore.items.find((item) => item.id === id);
      const updated =
        result.data !== undefined && result.data !== null
          ? (result.data as QuizQuestion)
          : current;

      if (updated === undefined) return result;

      const event = await logReviewEvent({
        questionId: id,
        topicId: updated.topicId ?? null,
        examId: updated.examId ?? null,
        kind: updated.kind ?? "single",
        correct: info.correct,
        rating: info.rating,
      });
      const events = [event, ...reviewEvents];

      setReviewEvents(events);

      if (updated.topicId !== null) {
        const questions = quizStore.items.map((item) =>
          item.id === id ? { ...item, ...patch } : item,
        );
        const { mastery, evidence } = computeTopicMastery(
          updated.topicId,
          questions,
          events,
          new Date().toISOString(),
        );

        await studyStore.updateEntry(updated.topicId, {
          mastery,
          masteryEvidence: evidence,
        });
      }
    } catch (historyError) {
      console.warn("Review-Verlauf konnte nicht gespeichert werden.", historyError);
    }

    return result;
  }

  const today = useToday();
  const completedTopics = data.topics.filter((topic) => topic.done).length;
  const openTopics = data.topics.filter((topic) => topic.done !== true);
  const upcomingExams =
    today === null
      ? null
      : data.exams
          .map((exam) => ({
            exam,
            daysLeft:
              exam.date === undefined ? null : daysBetween(today, exam.date),
          }))
          .filter(
            (item): item is { exam: Entry; daysLeft: number } =>
              item.daysLeft !== null && item.daysLeft >= 0,
          )
          .sort((a, b) => a.daysLeft - b.daysLeft);
  const nextExam = upcomingExams === null ? null : (upcomingExams[0] ?? null);
  const progressPercent =
    data.topics.length === 0
      ? null
      : Math.round((completedTopics / data.topics.length) * 100);

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
              UNIVERSITY HUB
            </p>

            <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">
              Studium & Wissen
            </h1>

            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              Organisiere deine Fächer, plane Prüfungen und behalte
              deinen Lernfortschritt im Blick.
            </p>
          </header>

          {studyStore.loading && (
            <p
              aria-live="polite"
              className="mt-8 rounded-2xl border border-white/[0.08] bg-[#0d111b] px-4 py-3 text-sm text-slate-400"
            >
              Studiendaten werden geladen …
            </p>
          )}

          {studyStore.error !== null && (
            <div
              role="alert"
              className="mt-8 flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/25 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"
            >
              <span className="min-w-0 flex-1">
                Studiendaten konnten nicht geladen werden: {studyStore.error}
              </span>
              <button
                onClick={() => void studyStore.refresh()}
                className="rounded-xl border border-rose-300/30 px-3 py-1.5 text-xs transition hover:bg-rose-400/10"
              >
                Erneut versuchen
              </button>
            </div>
          )}

          <nav
            aria-label="Studium-Bereiche"
            className="mt-8 flex flex-wrap gap-2"
          >
            {STUDY_TABS.map((entry) => (
              <button
                key={entry.key}
                onClick={() => setTab(entry.key)}
                aria-pressed={tab === entry.key}
                className={`rounded-xl border px-4 py-2.5 text-sm transition ${
                  tab === entry.key
                    ? "border-cyan-300/50 bg-cyan-300/[0.08] font-medium text-cyan-100"
                    : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200"
                }`}
              >
                {entry.label}
              </button>
            ))}
          </nav>

          {tab === "overview" && (
            <>
              <div
                className="jarvis-enter mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
                style={{ "--enter-delay": "60ms" } as React.CSSProperties}
              >
            <div className="rounded-2xl border border-white/[0.08] bg-[#0d111b] p-5">
              <GraduationCap className="text-cyan-300" size={22} />
              <p className="mt-4 text-2xl font-semibold tabular-nums">
                {data.subjects.length}
              </p>
              <p className="mt-1 text-xs text-slate-500">Fächer gesamt</p>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-[#0d111b] p-5">
              <CalendarDays className="text-cyan-300" size={22} />
              <p className="mt-4 text-2xl font-semibold tabular-nums">
                {upcomingExams === null ? "…" : upcomingExams.length}
              </p>
              <p className="mt-1 truncate text-xs text-slate-500">
                {nextExam === null
                  ? "Anstehende Prüfungen"
                  : `Nächste: ${nextExam.exam.title} · ${formatDaysLeft(nextExam.daysLeft)}`}
              </p>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-[#0d111b] p-5">
              <BookOpen className="text-cyan-300" size={22} />
              <p className="mt-4 text-2xl font-semibold tabular-nums">
                {openTopics.length}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Offene Themen · {completedTopics} erledigt
              </p>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-[#0d111b] p-5">
              <Target className="text-cyan-300" size={22} />
              <p className="mt-4 text-2xl font-semibold tabular-nums">
                {progressPercent === null ? "–" : `${progressPercent} %`}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {completedTopics} von {data.topics.length} Themen geschafft
              </p>
              {progressPercent !== null && (
                <div
                  role="progressbar"
                  aria-label="Lernfortschritt"
                  aria-valuenow={progressPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.06]"
                >
                  <div
                    style={{ width: `${progressPercent}%` }}
                    className="jarvis-progress h-full rounded-full bg-cyan-300"
                  />
                </div>
              )}
            </div>
          </div>

              <div
                className="jarvis-enter mt-8 grid gap-5 xl:grid-cols-2"
                style={{ "--enter-delay": "120ms" } as React.CSSProperties}
              >
                <SubjectManager
                  data={data}
                  studyStore={studyStore}
                  quizStore={quizStore}
                />
                {sections
                  .filter((section) => section.key === "topics")
                  .map((section) => (
                    <StudySection
                      key={section.key}
                      sectionKey={section.key}
                      title={section.title}
                      description={section.description}
                      icon={section.icon}
                      items={data[section.key]}
                      subjects={data.subjects}
                      onAdd={addEntry}
                      onDelete={deleteEntry}
                      onToggle={toggleTopic}
                      quizStore={quizStore}
                    />
                  ))}
              </div>
            </>
          )}

          {tab === "documents" && (
            <div
              className="jarvis-enter mt-8 space-y-5"
              style={{ "--enter-delay": "60ms" } as React.CSSProperties}
            >
              {sections
                .filter((section) => section.key === "materials")
                .map((section) => (
                  <StudySection
                    key={section.key}
                    sectionKey={section.key}
                    title={section.title}
                    description={section.description}
                    icon={section.icon}
                    items={data[section.key]}
                    subjects={data.subjects}
                    onAdd={addEntry}
                    onDelete={deleteEntry}
                    onToggle={toggleTopic}
                    quizStore={quizStore}
                  />
                ))}
              <RevisionPanel
                topics={data.topics}
                onReview={reviewTopic}
                questions={quizStore.items}
                onReviewQuestion={reviewQuestion}
              />
              <QuizPanel
                subjects={data.subjects}
                exams={data.exams}
                topics={data.topics}
                store={quizStore}
              />
            </div>
          )}

          {tab === "prep" && (
            <div
              className="jarvis-enter mt-8 space-y-5"
              style={{ "--enter-delay": "60ms" } as React.CSSProperties}
            >
              <nav
                aria-label="Prüfungsvorbereitung"
                className="flex flex-wrap gap-2"
              >
                {PREP_TABS.map((entry) => (
                  <button
                    key={entry.key}
                    onClick={() => setPrepTab(entry.key)}
                    aria-pressed={prepTab === entry.key}
                    className={`rounded-xl border px-4 py-2 text-sm transition ${
                      prepTab === entry.key
                        ? "border-cyan-300/50 bg-cyan-300/[0.08] font-medium text-cyan-100"
                        : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200"
                    }`}
                  >
                    {entry.label}
                  </button>
                ))}
              </nav>

              {prepTab === "overview" && (
                <ExamOverview
                  data={data}
                  questions={quizStore.items}
                  events={reviewEvents}
                  today={today}
                  onOpen={openPrep}
                />
              )}

              {prepTab === "exams" && (
                <ExamManager
                  data={data}
                  studyStore={studyStore}
                  quizStore={quizStore}
                />
              )}

              {prepTab === "topics" && (
                <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6">
                  <h2 className="font-semibold">Themen</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Automatisch erkannte Themen mit Quellen, Lernstand und
                    Priorität.
                  </p>
                  <div className="mt-4">
                    <TopicTree
                      data={data}
                      studyStore={studyStore}
                      quizStore={quizStore}
                    />
                  </div>
                </section>
              )}

              {prepTab === "plan" && (
                <StudyPlanner
                  key={planFocus ?? "all"}
                  data={data}
                  studyStore={studyStore}
                  quizStore={quizStore}
                  focusExamId={planFocus}
                />
              )}

              {prepTab === "progress" && (
                <ProgressView
                  data={data}
                  questions={quizStore.items}
                  events={reviewEvents}
                  studyStore={studyStore}
                />
              )}
            </div>
          )}

          <footer className="py-8 text-center text-xs text-slate-600">
            J.A.R.V.I.S. · University Hub ·{" "}
            {studyStore.mode === "cloud"
              ? "Cloud-Synchronisierung"
              : "Lokale Speicherung"}
          </footer>
        </section>
      </div>
    </main>
  );
}
