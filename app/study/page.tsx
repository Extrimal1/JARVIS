
"use client";

import { useState } from "react";
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
import { useLocalStorage } from "@/src/hooks/useLocalStorage";
import { useToday } from "@/src/hooks/useToday";
import { DocumentLibrary } from "@/src/components/study/DocumentLibrary";
import { QuizPanel } from "@/src/components/study/QuizPanel";
import { RevisionPanel } from "@/src/components/study/RevisionPanel";
import { daysBetween, formatDaysLeft } from "@/src/lib/briefing";
import { markReviewed } from "@/src/lib/revision";
import {
  STUDY_STORAGE_KEY,
  isStudyData,
  type Entry,
  type StudyData,
} from "@/src/lib/study";

const initialData: StudyData = {
  subjects: [
    {
      id: 1,
      title: "Programmierung mit Java",
      detail: "Objektorientierte Programmierung",
    },
    {
      id: 2,
      title: "Mathematik",
      detail: "Mathematische Grundlagen",
    },
    {
      id: 3,
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
    key: "subjects",
    title: "Meine Fächer",
    description: "Organisiere deine Studienmodule.",
    icon: GraduationCap,
  },
  {
    key: "exams",
    title: "Prüfungen",
    description: "Behalte Prüfungstermine im Blick.",
    icon: CalendarDays,
  },
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
}: {
  sectionKey: SectionKey;
  title: string;
  description: string;
  icon: React.ElementType;
  items: Entry[];
  subjects: Entry[];
  onAdd: (key: SectionKey, entry: Entry) => void;
  onDelete: (key: SectionKey, id: number) => void;
  onToggle: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const [detail, setDetail] = useState("");
  const [date, setDate] = useState("");
  const [subject, setSubject] = useState("");

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!name.trim()) return;

    onAdd(sectionKey, {
      id: Date.now(),
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
          className="mt-5 space-y-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4"
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
          <DocumentLibrary subjects={subjects} />
        </div>
      )}
    </section>
  );
}

export default function StudyPage() {
  const [data, setData] = useLocalStorage<StudyData>(
    STUDY_STORAGE_KEY,
    initialData,
    isStudyData,
  );

  function addEntry(key: SectionKey, entry: Entry) {
    setData((current) => ({
      ...current,
      [key]: [...current[key], entry],
    }));
  }

  function deleteEntry(key: SectionKey, id: number) {
    setData((current) => ({
      ...current,
      [key]: current[key].filter((item) => item.id !== id),
    }));
  }

  function toggleTopic(id: number) {
    setData((current) => ({
      ...current,
      topics: current.topics.map((topic) =>
        topic.id === id ? { ...topic, done: !topic.done } : topic
      ),
    }));
  }

  function reviewTopic(id: number, todayISO: string) {
    setData((current) => ({
      ...current,
      topics: current.topics.map((topic) =>
        topic.id === id ? markReviewed(topic, todayISO) : topic,
      ),
    }));
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

          <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
                    className="h-full rounded-full bg-cyan-300"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="mt-8 grid gap-5 xl:grid-cols-2">
            {sections.map((section) => (
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
              />
            ))}
          </div>

          <div className="mt-8 space-y-5">
            <RevisionPanel topics={data.topics} onReview={reviewTopic} />
            <QuizPanel
              subjects={data.subjects}
              exams={data.exams}
              topics={data.topics}
            />
          </div>

          <footer className="py-8 text-center text-xs text-slate-600">
            J.A.R.V.I.S. · University Hub · Lokale Speicherung
          </footer>
        </section>
      </div>
    </main>
  );
}
