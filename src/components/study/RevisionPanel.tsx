"use client";

import { useState } from "react";
import { Check, Repeat } from "lucide-react";
import { useToday } from "@/src/hooks/useToday";
import { formatDayShort } from "@/src/lib/briefing";
import {
  REVISION_INTERVALS,
  getReviewInfo,
  type ReviewInfo,
} from "@/src/lib/revision";
import type { Entry } from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";
import {
  getQuizReviewInfo,
  type QuizRating,
  type QuizReviewPatch,
} from "@/src/lib/quizReview";
import { QuestionReviewer } from "@/src/components/study/QuestionReviewer";

type TopicRow = { topic: Entry; info: ReviewInfo };

function DueBadge({
  info,
}: {
  info: Pick<ReviewInfo, "status" | "daysLeft" | "dueISO">;
}) {
  if (info.status === "overdue") {
    const text =
      info.daysLeft === -1
        ? "Seit gestern überfällig"
        : `Seit ${-info.daysLeft} Tagen überfällig`;

    return (
      <span className="shrink-0 rounded-full bg-rose-400/10 px-2 py-1 text-[10px] text-rose-300">
        {text}
      </span>
    );
  }

  if (info.status === "today") {
    return (
      <span className="shrink-0 rounded-full bg-amber-400/10 px-2 py-1 text-[10px] text-amber-300">
        Heute fällig
      </span>
    );
  }

  return (
    <span className="shrink-0 rounded-full bg-slate-400/10 px-2 py-1 text-[10px] text-slate-400">
      Fällig am {formatDayShort(info.dueISO)}
    </span>
  );
}

export function RevisionPanel({
  topics,
  onReview,
  questions = [],
  onReviewQuestion,
}: {
  topics: Entry[];
  onReview: (id: string, todayISO: string) => void;
  questions?: QuizQuestion[];
  onReviewQuestion?: (
    id: string,
    patch: QuizReviewPatch,
    info: { correct: boolean; rating: QuizRating },
  ) => Promise<{ ok: boolean; error?: string }>;
}) {
  const today = useToday();
  const [expandedQuestionId, setExpandedQuestionId] = useState<string | null>(
    null,
  );
  const openTopics = topics.filter((topic) => topic.done !== true);
  const dueQuestions =
    today === null
      ? []
      : questions
          .map((question) => ({
            question,
            info: getQuizReviewInfo(question, today),
          }))
          .filter((row) => row.info.status !== "later")
          .sort((a, b) => a.info.dueISO.localeCompare(b.info.dueISO));
  const laterQuestionCount = questions.length - dueQuestions.length;
  const expandedQuestion =
    expandedQuestionId === null
      ? null
      : (questions.find((item) => item.id === expandedQuestionId) ?? null);
  const expandedIsDue =
    expandedQuestion !== null &&
    dueQuestions.some((row) => row.question.id === expandedQuestion.id);
  const rows: TopicRow[] =
    today === null
      ? []
      : openTopics.map((topic) => ({
          topic,
          info: getReviewInfo(topic, today),
        }));
  const overdue = rows
    .filter((row) => row.info.status === "overdue")
    .sort((a, b) => a.info.dueISO.localeCompare(b.info.dueISO));
  const dueToday = rows.filter((row) => row.info.status === "today");
  const later = rows
    .filter((row) => row.info.status === "later")
    .sort((a, b) => a.info.dueISO.localeCompare(b.info.dueISO));

  function renderQuestionRow({
    question,
    info,
  }: {
    question: QuizQuestion;
    info: Pick<ReviewInfo, "status" | "daysLeft" | "dueISO">;
  }) {
    const expanded = expandedQuestionId === question.id;
    const persistReview = onReviewQuestion;
    const firstRef = question.sourceRefs?.[0];

    return (
      <li
        key={question.id}
        className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 basis-48">
            <p className="line-clamp-2 text-sm text-slate-200">
              {question.question}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[10px] text-cyan-200">
                {question.subject === "" ? "Ohne Fach" : question.subject}
              </span>
              {question.source === "ai" && (
                <span className="rounded-full bg-amber-400/10 px-2 py-1 text-[10px] text-amber-300">
                  KI-generiert
                </span>
              )}
              {firstRef !== undefined && firstRef !== "" && (
                <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] text-slate-400">
                  {firstRef}
                </span>
              )}
            </div>
          </div>

          <DueBadge info={info} />

          {persistReview !== undefined && (
            <button
              onClick={() =>
                setExpandedQuestionId(expanded ? null : question.id)
              }
              aria-expanded={expanded}
              className="flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200"
            >
              {expanded ? "Schließen" : "Beantworten"}
            </button>
          )}
        </div>

        {expanded && persistReview !== undefined && (
          <div className="mt-3">
            <QuestionReviewer
              question={question}
              onRate={(patch, info) => persistReview(question.id, patch, info)}
              onClose={() => setExpandedQuestionId(null)}
            />
          </div>
        )}
      </li>
    );
  }

  function renderRow({ topic, info }: TopicRow) {
    return (
      <li
        key={topic.id}
        className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
      >
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate text-sm text-slate-200">{topic.title}</p>
          <p className="mt-1 truncate text-xs text-slate-500">
            {topic.subject ? `${topic.subject} · ` : ""}Wiederholung{" "}
            {info.stage + 1} ·{" "}
            {info.intervalDays === 1
              ? "täglicher Rhythmus"
              : `alle ${info.intervalDays} Tage`}
            {" · "}
            {info.lastReviewedAt === null
              ? "Noch nie wiederholt"
              : `Zuletzt ${formatDayShort(info.lastReviewedAt)}`}
          </p>
        </div>

        <DueBadge info={info} />

        <button
          onClick={() => {
            if (today !== null) {
              onReview(topic.id, today);
            }
          }}
          disabled={today === null}
          className="flex shrink-0 items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check size={14} />
          Wiederholt
        </button>
      </li>
    );
  }

  return (
    <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
          <Repeat size={21} />
        </div>

        <div>
          <h2 className="font-semibold">Wiederholung</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Verteile deine Wiederholungen über die Zeit.
          </p>
          <p className="mt-2 text-xs text-cyan-300">
            {openTopics.length}{" "}
            {openTopics.length === 1 ? "offenes Thema" : "offene Themen"}
          </p>
        </div>
      </div>

      <p className="mt-5 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4 text-xs leading-5 text-slate-400">
        So funktioniert&apos;s: Nach jeder Wiederholung wächst der Abstand –{" "}
        {REVISION_INTERVALS.join(" · ")} Tage. Erledigte Themen erscheinen
        hier nicht. Ein einfacher fester Plan: kein Algorithmus, keine KI.
      </p>

      <div className="mt-5">
        {today === null ? (
          <p className="text-sm text-slate-500">Wird geladen …</p>
        ) : openTopics.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
            Keine offenen Lernthemen. Lege oben ein Thema an, um mit dem
            Wiederholen zu beginnen.
          </div>
        ) : (
          <div className="space-y-5">
            {overdue.length === 0 && dueToday.length === 0 && (
              <p className="rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-3 text-sm text-emerald-200">
                Alles im Plan – nichts überfällig.
              </p>
            )}

            {overdue.length > 0 && (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-rose-300">
                  Überfällig ({overdue.length})
                </h3>
                <ul className="mt-2 space-y-2">
                  {overdue.map((row) => renderRow(row))}
                </ul>
              </div>
            )}

            {dueToday.length > 0 && (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-amber-300">
                  Heute fällig ({dueToday.length})
                </h3>
                <ul className="mt-2 space-y-2">
                  {dueToday.map((row) => renderRow(row))}
                </ul>
              </div>
            )}

            {later.length > 0 && (
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wider text-slate-500">
                  Später ({later.length})
                </h3>
                <ul className="mt-2 space-y-2">
                  {later.map((row) => renderRow(row))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mt-6 border-t border-white/[0.06] pt-5">
        <h3 className="text-sm font-semibold text-slate-200">
          Übungsfragen zur Wiederholung
        </h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          Fällige Fragen beantworten, Schwierigkeit einschätzen — die
          nächste Wiederholung plant sich danach (1 · 3 · 7 · 14 · 30
          Tage).
        </p>

        <div className="mt-4">
          {today === null ? (
            <p className="text-sm text-slate-500">Wird geladen …</p>
          ) : questions.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
              Noch keine Übungsfragen. Generiere sie aus einem Dokument
              oder lege sie unten manuell an.
            </div>
          ) : dueQuestions.length === 0 &&
            (expandedQuestion === null || expandedIsDue) ? (
            <p className="rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-3 text-sm text-emerald-200">
              Alle Fragen im Plan
              {laterQuestionCount > 0
                ? ` — ${laterQuestionCount} später fällig`
                : ""}
              .
            </p>
          ) : (
            <div>
              <ul className="space-y-2">
                {dueQuestions.map((row) => renderQuestionRow(row))}
                {expandedQuestion !== null &&
                  !expandedIsDue &&
                  today !== null &&
                  renderQuestionRow({
                    question: expandedQuestion,
                    info: getQuizReviewInfo(expandedQuestion, today),
                  })}
              </ul>
              {laterQuestionCount > 0 && (
                <p className="mt-2 text-xs text-slate-500">
                  {laterQuestionCount} weitere später fällig.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
