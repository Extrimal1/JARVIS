"use client";

import { useMemo, useState } from "react";
import { RefreshCw, TrendingUp } from "lucide-react";
import type { StudyData, TopicMastery } from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { ReviewEvent } from "@/src/lib/study/reviewEvents";
import type { StudyResource } from "@/src/lib/db/useModules";
import {
  examReadiness,
  recomputeMastery,
} from "@/src/lib/study/mastery";

const MASTERY_LABELS: Record<TopicMastery, string> = {
  "not-started": "Nicht begonnen",
  learning: "In Bearbeitung",
  "needs-revision": "Wiederholen",
  understood: "Verstanden",
  mastered: "Gemeistert",
};

const MASTERY_BAR: Record<TopicMastery, string> = {
  "not-started": "bg-slate-500",
  learning: "bg-cyan-300",
  "needs-revision": "bg-amber-300",
  understood: "bg-emerald-300",
  mastered: "bg-violet-300",
};

/**
 * Progress and analytics: mastery distribution, per-topic
 * accuracy, weak topics, review history, and per-exam
 * readiness with its calculation. Everything derives from
 * stored evidence — nothing is invented or promised.
 */
export function ProgressView({
  data,
  questions,
  events,
  studyStore,
}: {
  data: StudyData;
  questions: QuizQuestion[];
  events: ReviewEvent[];
  studyStore: StudyResource;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const distribution = useMemo(() => {
    const counts = new Map<TopicMastery, number>();

    for (const topic of data.topics) {
      const level: TopicMastery = topic.mastery ?? "not-started";

      counts.set(level, (counts.get(level) ?? 0) + 1);
    }

    return counts;
  }, [data.topics]);

  const weakTopics = useMemo(
    () =>
      data.topics.filter((topic) => {
        const accuracy = topic.masteryEvidence?.quizAccuracy ?? null;

        return (
          topic.mastery === "needs-revision" ||
          (accuracy !== null && accuracy < 0.6)
        );
      }),
    [data.topics],
  );

  const attempts = events.length;
  const accuracy =
    attempts === 0
      ? null
      : events.filter((event) => event.correct).length / attempts;

  async function refreshAll() {
    if (busy) return;

    setBusy(true);
    setNotice(null);

    try {
      const results = recomputeMastery(
        data.topics,
        questions,
        events,
        new Date().toISOString(),
      );
      let updated = 0;

      for (const topic of data.topics) {
        const result = results.get(topic.id);

        if (result === undefined) continue;

        const before = JSON.stringify({
          mastery: topic.mastery ?? "not-started",
          quizAccuracy: topic.masteryEvidence?.quizAccuracy ?? null,
          reviews: topic.masteryEvidence?.reviews ?? 0,
          score: topic.masteryEvidence?.score ?? null,
        });
        const after = JSON.stringify({
          mastery: result.mastery,
          quizAccuracy: result.evidence.quizAccuracy,
          reviews: result.evidence.reviews,
          score: result.evidence.score ?? null,
        });

        if (before !== after) {
          await studyStore.updateEntry(topic.id, {
            mastery: result.mastery,
            masteryEvidence: result.evidence,
          });
          updated += 1;
        }
      }

      setNotice(
        updated === 0
          ? "Lernstand ist aktuell."
          : `Lernstand für ${updated} ${updated === 1 ? "Thema" : "Themen"} aktualisiert.`,
      );
    } catch {
      setNotice("Aktualisierung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
            <TrendingUp size={15} className="text-cyan-300" />
            Lernstand
          </h3>

          <button
            onClick={() => void refreshAll()}
            disabled={busy}
            className="flex items-center gap-1 rounded-xl border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:border-cyan-300/30 disabled:opacity-50"
          >
            <RefreshCw size={13} />
            Lernstand aktualisieren
          </button>
        </div>

        {notice !== null && (
          <p className="mt-2 text-xs text-slate-400">{notice}</p>
        )}

        <div className="mt-3 space-y-1.5">
          {(Object.keys(MASTERY_LABELS) as TopicMastery[]).map((level) => {
            const count = distribution.get(level) ?? 0;
            const total = data.topics.length;
            const percent =
              total === 0 ? 0 : Math.round((count / total) * 100);

            return (
              <div key={level} className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-[11px] text-slate-400">
                  {MASTERY_LABELS[level]}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <div
                    style={{ width: `${percent}%` }}
                    className={`h-full rounded-full ${MASTERY_BAR[level]}`}
                  />
                </div>
                <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-slate-500">
                  {count}
                </span>
              </div>
            );
          })}
        </div>

        <p className="mt-3 text-[11px] text-slate-500">
          {attempts} Antworten im Verlauf
          {accuracy === null
            ? ""
            : ` · Trefferquote ${Math.round(accuracy * 100)} %`}
        </p>
      </div>

      {weakTopics.length > 0 && (
        <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.03] p-4">
          <h3 className="text-sm font-medium text-slate-200">
            Schwache Themen
          </h3>

          <ul className="mt-2 space-y-1">
            {weakTopics.map((topic) => (
              <li
                key={topic.id}
                className="flex flex-wrap items-center gap-2 text-xs text-slate-300"
              >
                <span className="min-w-0 flex-1">{topic.title}</span>
                <span className="text-[11px] tabular-nums text-slate-500">
                  {topic.masteryEvidence?.quizAccuracy === undefined ||
                  topic.masteryEvidence?.quizAccuracy === null
                    ? "–"
                    : `${Math.round(topic.masteryEvidence.quizAccuracy * 100)} %`}
                  {" · "}
                  {topic.masteryEvidence?.reviews ?? 0} Antworten
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4">
        <h3 className="text-sm font-medium text-slate-200">
          Prüfungsreife
        </h3>

        {data.exams.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">
            Keine Prüfungen angelegt.
          </p>
        ) : (
          <div className="mt-2 space-y-3">
            {data.exams.map((exam) => {
              const readiness = examReadiness(
                exam,
                data.topics,
                questions,
                events,
              );

              return (
                <div key={exam.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 flex-1 truncate text-xs text-slate-200">
                      {exam.title}
                    </p>
                    <span className="rounded-full bg-cyan-300/[0.08] px-2 py-0.5 text-[10px] text-cyan-200">
                      {readiness.score === null
                        ? readiness.label
                        : `${readiness.label} · ${readiness.score}`}
                    </span>
                  </div>

                  <ul className="mt-1 space-y-0.5">
                    {readiness.explanation.map((line) => (
                      <li
                        key={line}
                        className="text-[11px] leading-4 text-slate-500"
                      >
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {events.length > 0 && (
        <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4">
          <h3 className="text-sm font-medium text-slate-200">
            Letzte Antworten
          </h3>

          <ul className="mt-2 space-y-1">
            {events.slice(0, 10).map((event) => {
              const topic = data.topics.find(
                (entry) => entry.id === event.topicId,
              );

              return (
                <li
                  key={event.id}
                  className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${event.correct ? "bg-emerald-300" : "bg-rose-300"}`}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {topic?.title ?? "Ohne Thema"}
                  </span>
                  <span className="tabular-nums text-slate-500">
                    {event.createdAt.slice(0, 10)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
