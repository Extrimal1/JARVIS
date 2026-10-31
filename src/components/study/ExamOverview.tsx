"use client";

import { useMemo } from "react";
import { ArrowRight, CalendarDays } from "lucide-react";
import { formatDaysLeft } from "@/src/lib/briefing";
import { addDaysISO } from "@/src/lib/revision";
import type { StudyData, TopicMastery } from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { ReviewEvent } from "@/src/lib/study/reviewEvents";
import { examReadiness } from "@/src/lib/study/mastery";
import { minutesForDate, upcomingExams } from "@/src/lib/study/exams";

export type PrepView = "overview" | "exams" | "topics" | "plan" | "progress";

const MASTERY_DOT: Record<TopicMastery, string> = {
  "not-started": "bg-slate-500",
  learning: "bg-cyan-300",
  "needs-revision": "bg-amber-300",
  understood: "bg-emerald-300",
  mastered: "bg-violet-300",
};

/**
 * Exam preparation overview: upcoming exams with countdown,
 * plan progress, mastery mix, workload balance, and readiness.
 * Read-only — editing lives in the sibling views.
 */
export function ExamOverview({
  data,
  questions,
  events,
  today,
  onOpen,
}: {
  data: StudyData;
  questions: QuizQuestion[];
  events: ReviewEvent[];
  today: string | null;
  onOpen: (view: PrepView, examId?: string) => void;
}) {
  const ordered = useMemo(
    () =>
      today === null
        ? []
        : upcomingExams(data.exams, today).filter(
            (item) => item.daysLeft === null || item.daysLeft >= 0,
          ),
    [data.exams, today],
  );

  if (ordered.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
        Keine anstehenden Prüfungen — lege eine Prüfung an, um zu starten.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {ordered.map(({ exam, daysLeft }) => {
        const linkedIds =
          exam.examData?.topicIds !== undefined &&
          exam.examData.topicIds.length > 0
            ? new Set(exam.examData.topicIds)
            : null;
        const scoped =
          linkedIds !== null
            ? data.topics.filter((topic) => linkedIds.has(topic.id))
            : exam.subject !== undefined && exam.subject !== ""
              ? data.topics.filter((topic) => topic.subject === exam.subject)
              : [];
        const masteryCount = new Map<TopicMastery, number>();

        for (const topic of scoped) {
          const level: TopicMastery = topic.mastery ?? "not-started";

          masteryCount.set(level, (masteryCount.get(level) ?? 0) + 1);
        }

        const tasks = exam.examData?.plan?.tasks ?? [];
        const done = tasks.filter((task) => task.status === "done").length;
        const open = tasks.filter((task) => task.status === "open").length;
        const readiness = examReadiness(exam, data.topics, questions, events);

        let pool = 0;
        let planned = 0;

        if (
          today !== null &&
          daysLeft !== null &&
          exam.examData?.availability !== undefined
        ) {
          for (let offset = 0; offset < daysLeft; offset += 1) {
            const day = addDaysISO(today, offset);

            if (day !== null) pool += minutesForDate(exam, day);
          }

          planned = tasks
            .filter((task) => task.status === "open")
            .reduce((sum, task) => sum + task.minutes, 0);
        }

        const deficit = exam.examData?.plan?.deficitMinutes ?? 0;

        return (
          <div
            key={exam.id}
            className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
          >
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
                <CalendarDays size={19} />
              </div>

              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate text-sm font-medium text-slate-100">
                  {exam.title}
                </p>
                <p className="mt-0.5 text-xs text-slate-500">
                  {exam.subject ?? "Kein Fach"}
                  {exam.date !== undefined &&
                    ` · ${exam.date}`}
                  {daysLeft !== null && ` · ${formatDaysLeft(daysLeft)}`}
                </p>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {(Object.keys(MASTERY_DOT) as TopicMastery[]).map(
                    (level) => {
                      const count = masteryCount.get(level) ?? 0;

                      if (count === 0) return null;

                      return (
                        <span
                          key={level}
                          className="flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] text-slate-400"
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${MASTERY_DOT[level]}`}
                          />
                          {count}
                        </span>
                      );
                    },
                  )}

                  <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] tabular-nums text-slate-400">
                    Plan: {done}/{done + open} · {planned}/{pool} Min
                  </span>

                  {readiness.score !== null && (
                    <span className="rounded-full bg-cyan-300/[0.08] px-2 py-0.5 text-[10px] text-cyan-200">
                      {readiness.label} · {readiness.score}
                    </span>
                  )}
                </div>

                {deficit > 0 && (
                  <p className="mt-1.5 text-[11px] text-rose-300">
                    Zeit reicht nicht: {deficit} Min ungeplant.
                  </p>
                )}
              </div>

              <div className="flex shrink-0 gap-1.5">
                <button
                  onClick={() => onOpen("topics")}
                  className="flex items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30"
                >
                  Themen
                  <ArrowRight size={13} />
                </button>
                <button
                  onClick={() => onOpen("plan", exam.id)}
                  className="flex items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30"
                >
                  Lernplan
                  <ArrowRight size={13} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
