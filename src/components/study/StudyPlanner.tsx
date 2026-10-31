"use client";

import { useMemo, useState } from "react";
import {
  CalendarClock,
  Check,
  ChevronDown,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
} from "lucide-react";
import { createId } from "@/src/lib/ids";
import type {
  Entry,
  PlanTask,
  PlanTaskKind,
  StudyData,
  StudyPlan,
} from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { ListResource } from "@/src/lib/db/useRemoteResource";
import type { StudyResource } from "@/src/lib/db/useModules";
import {
  generateStudyPlans,
  planInputsSignature,
} from "@/src/lib/study/planner";
import {
  minutesForDate,
  normalizeAvailability,
} from "@/src/lib/study/exams";

const KIND_LABELS: Record<PlanTaskKind, string> = {
  theory: "Theorie",
  exercise: "Übung",
  quiz: "Abfrage",
  review: "Wiederholung",
  mock: "Probeprüfung",
};

const KIND_STYLES: Record<PlanTaskKind, string> = {
  theory: "bg-cyan-300/[0.08] text-cyan-200",
  exercise: "bg-emerald-300/[0.08] text-emerald-200",
  quiz: "bg-violet-300/[0.08] text-violet-200",
  review: "bg-amber-300/[0.08] text-amber-200",
  mock: "bg-rose-300/[0.08] text-rose-200",
};

function todayLocal(): string {
  const now = new Date();

  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function addDays(dateISO: string, days: number): string {
  const date = new Date(`${dateISO}T12:00:00Z`);

  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
}

function formatDate(dateISO: string): string {
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "short",
    day: "numeric",
    month: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dateISO}T12:00:00Z`));
}

function topicTitle(topics: Entry[], topicId: string | null): string {
  if (topicId === null) return "Prüfungsstoff";

  return topics.find((topic) => topic.id === topicId)?.title ?? "Thema";
}

/**
 * Study planner section: combined workload strip plus per-exam
 * schedules with manual control. Plans persist inside each
 * exam's examData (no extra tables); regeneration runs the
 * joint deterministic engine and writes every exam's own row,
 * so exams never overwrite each other.
 */
export function StudyPlanner({
  data,
  studyStore,
  quizStore,
  focusExamId = null,
}: {
  data: StudyData;
  studyStore: StudyResource;
  quizStore: ListResource<QuizQuestion>;
  /** Exam card to expand (quick links from the overview). */
  focusExamId?: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openExam, setOpenExam] = useState<string | null>(focusExamId);
  const [postponeFor, setPostponeFor] = useState<string | null>(null);
  const [postponeDate, setPostponeDate] = useState("");
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState({
    date: "",
    kind: "theory" as PlanTaskKind,
    topicId: "",
    minutes: "30",
  });

  const today = useMemo(() => todayLocal(), []);
  const week = useMemo(
    () => Array.from({ length: 7 }, (_, offset) => addDays(today, offset)),
    [today],
  );

  const poolByDate = useMemo(() => {
    const pools = new Map<string, number>();

    for (const day of week) {
      let pool = 0;

      for (const exam of data.exams) {
        if (exam.date === undefined || exam.date <= day) continue;

        pool = Math.max(pool, minutesForDate(exam, day));
      }

      pools.set(day, pool);
    }

    return pools;
  }, [data.exams, week]);

  const plannedByDate = useMemo(() => {
    const planned = new Map<string, number>();

    for (const exam of data.exams) {
      for (const task of exam.examData?.plan?.tasks ?? []) {
        if (task.status !== "open") continue;

        planned.set(
          task.date,
          (planned.get(task.date) ?? 0) + task.minutes,
        );
      }
    }

    return planned;
  }, [data.exams]);

  // Read-only engine run for contention display (stored plans
  // stay the source of truth; this never writes).
  const liveConflicts = useMemo(() => {
    if (data.exams.length === 0) return new Set<string>();

    try {
      const result = generateStudyPlans({
        exams: data.exams,
        topics: data.topics,
        questions: quizStore.items,
        todayISO: today,
      });

      return new Set(result.conflicts.map((conflict) => conflict.date));
    } catch {
      return new Set<string>();
    }
  }, [data.exams, data.topics, quizStore.items, today]);

  const staleExams = useMemo(() => {
    const stale = new Set<string>();

    for (const exam of data.exams) {
      const stored = exam.examData?.plan ?? null;

      if (stored === null) {
        stale.add(exam.id);
        continue;
      }

      if (
        planInputsSignature(exam, data.topics, quizStore.items) !==
        stored.inputsSignature
      ) {
        stale.add(exam.id);
      }
    }

    return stale;
  }, [data.exams, data.topics, quizStore.items]);

  async function regenerate() {
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const result = generateStudyPlans({
        exams: data.exams,
        topics: data.topics,
        questions: quizStore.items,
        todayISO: today,
      });

      for (const plan of result.plans) {
        const exam = data.exams.find((entry) => entry.id === plan.examId);

        if (exam === undefined) continue;

        await studyStore.updateEntry(plan.examId, {
          examData: {
            documentIds: exam.examData?.documentIds ?? [],
            topicIds: exam.examData?.topicIds ?? [],
            availability:
              exam.examData?.availability ??
              normalizeAvailability(undefined),
            plan,
          },
        });
      }
    } catch (regenError) {
      setError(
        regenError instanceof Error
          ? regenError.message
          : "Planung fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function writePlan(exam: Entry, plan: StudyPlan) {
    setBusy(true);
    setError(null);

    try {
      await studyStore.updateEntry(exam.id, {
        examData: {
          documentIds: exam.examData?.documentIds ?? [],
          topicIds: exam.examData?.topicIds ?? [],
          availability:
            exam.examData?.availability ?? normalizeAvailability(undefined),
          plan,
        },
      });
    } catch (writeError) {
      setError(
        writeError instanceof Error ? writeError.message : "Speichern fehlgeschlagen.",
      );
    } finally {
      setBusy(false);
    }
  }

  function patchTask(
    exam: Entry,
    plan: StudyPlan,
    taskId: string,
    patch: Partial<PlanTask>,
  ) {
    const tasks = plan.tasks.map((task) =>
      task.id === taskId ? { ...task, ...patch } : task,
    );

    void writePlan(exam, { ...plan, tasks });
  }

  async function addManual(exam: Entry, plan: StudyPlan | null) {
    if (addDraft.date === "" || busy) return;

    const minutes = Math.max(5, Number.parseInt(addDraft.minutes, 10) || 5);
    const task: PlanTask = {
      id: createId(),
      date: addDraft.date,
      kind: addDraft.kind,
      topicId: addDraft.topicId === "" ? null : addDraft.topicId,
      questionIds: [],
      minutes,
      priority: "normal",
      reason: "Manuell hinzugefügt.",
      origin: "manual",
      status: "open",
    };
    const base: StudyPlan = plan ?? {
      examId: exam.id,
      generatedAt: new Date().toISOString(),
      inputsSignature: planInputsSignature(exam, data.topics, quizStore.items),
      deficitMinutes: 0,
      warnings: [],
      tasks: [],
    };

    setAddingFor(null);
    setAddDraft({ date: "", kind: "theory", topicId: "", minutes: "30" });

    await writePlan(exam, {
      ...base,
      tasks: [...base.tasks, task].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
    });
  }

  return (
    <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
            <CalendarClock size={21} />
          </div>

          <div>
            <h2 className="font-semibold">Lernplan</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Automatische Tagesplanung aus Verfügbarkeit, Voraussetzungen und
              Lernstand.
            </p>
          </div>
        </div>

        <button
          onClick={() => void regenerate()}
          disabled={busy || data.exams.length === 0}
          className="flex shrink-0 items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30 disabled:opacity-50"
        >
          <RefreshCw size={15} />
          Pläne berechnen
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="mt-4 text-xs text-rose-300">
          {error}
        </p>
      )}

      {data.exams.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
          Lege zuerst eine Prüfung an, um einen Lernplan zu erstellen.
        </div>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-7 gap-1">
            {week.map((day) => {
              const pool = poolByDate.get(day) ?? 0;
              const planned = plannedByDate.get(day) ?? 0;
              const ratio = pool === 0 ? 0 : Math.min(1, planned / pool);
              const contested = liveConflicts.has(day);

              return (
                <div
                  key={day}
                  title={`${formatDate(day)}: ${planned} von ${pool} Min verplant${contested ? " — mehrere Prüfungen konkurrieren um diesen Tag" : ""}`}
                  className={`rounded-xl border bg-white/[0.02] p-2 text-center ${
                    contested
                      ? "border-amber-300/30"
                      : "border-white/[0.05]"
                  }`}
                >
                  <p className="text-[10px] text-slate-500">
                    {formatDate(day).split(" ")[0]}
                  </p>
                  <p className="mt-1 text-[11px] tabular-nums text-slate-300">
                    {planned}/{pool}
                  </p>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      style={{ width: `${Math.round(ratio * 100)}%` }}
                      className={`h-full rounded-full ${planned > pool ? "bg-rose-300" : contested ? "bg-amber-300" : "bg-cyan-300"}`}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-5 space-y-2">
            {data.exams.map((exam) => {
              const plan = exam.examData?.plan ?? null;
              const isOpen = openExam === exam.id;
              const isStale = staleExams.has(exam.id);
              const openTasks = (plan?.tasks ?? []).filter(
                (task) => task.status === "open",
              );
              const doneMinutes = (plan?.tasks ?? [])
                .filter((task) => task.status === "done")
                .reduce((sum, task) => sum + task.minutes, 0);
              const openMinutes = openTasks.reduce(
                (sum, task) => sum + task.minutes,
                0,
              );
              const total = doneMinutes + openMinutes;
              const percent =
                total === 0 ? 0 : Math.round((doneMinutes / total) * 100);
              const grouped = new Map<string, PlanTask[]>();

              for (const task of plan?.tasks ?? []) {
                if (task.status === "skipped") continue;

                const list = grouped.get(task.date) ?? [];

                list.push(task);
                grouped.set(task.date, list);
              }

              const dates = [...grouped.keys()].sort();

              return (
                <div
                  key={exam.id}
                  className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
                >
                  <button
                    onClick={() => setOpenExam(isOpen ? null : exam.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-3 text-left"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-slate-200">
                        {exam.title}
                        {exam.date !== undefined && (
                          <span className="ml-2 text-xs text-slate-500">
                            · {exam.date}
                          </span>
                        )}
                      </p>

                      <div className="mt-2 flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                          <div
                            style={{ width: `${percent}%` }}
                            className="h-full rounded-full bg-cyan-300"
                          />
                        </div>
                        <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
                          {doneMinutes}/{total} Min
                        </span>
                      </div>

                      {(plan === null || isStale) && (
                        <p className="mt-2 text-[11px] text-amber-200/90">
                          {plan === null
                            ? "Noch kein Plan — „Pläne berechnen“ starten."
                            : "Veraltet (Termin, Verfügbarkeit oder Lernstand geändert)."}
                        </p>
                      )}

                      {(plan?.deficitMinutes ?? 0) > 0 && (
                        <p className="mt-1 text-[11px] text-rose-300">
                          Zeit reicht nicht: {plan?.deficitMinutes} Min ungeplant.
                        </p>
                      )}
                    </div>

                    <ChevronDown
                      size={16}
                      className={`shrink-0 text-slate-500 transition ${isOpen ? "rotate-180" : ""}`}
                    />
                  </button>

                  {isOpen && (
                    <div className="mt-3 space-y-3 border-t border-white/[0.06] pt-3">
                      {(plan?.warnings ?? []).length > 0 && (
                        <ul className="space-y-1">
                          {plan?.warnings.map((warning) => (
                            <li
                              key={warning}
                              className="text-[11px] leading-4 text-amber-200/90"
                            >
                              {warning}
                            </li>
                          ))}
                        </ul>
                      )}

                      {dates.length === 0 && (
                        <p className="text-xs text-slate-500">
                          Keine Aufgaben geplant.
                        </p>
                      )}

                      {dates.map((date) => (
                        <div key={date}>
                          <p
                            className={`text-[11px] font-medium ${
                              date < today
                                ? "text-rose-300"
                                : "text-slate-400"
                            }`}
                          >
                            {formatDate(date)}
                            {date < today && " · überfällig"}
                          </p>

                          <div className="mt-1 space-y-1">
                            {(grouped.get(date) ?? []).map((task) => (
                              <div
                                key={task.id}
                                className={`rounded-xl border border-white/[0.05] bg-black/20 p-2.5 ${
                                  task.status === "done" ? "opacity-60" : ""
                                }`}
                              >
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] ${KIND_STYLES[task.kind]}`}
                                  >
                                    {KIND_LABELS[task.kind]}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
                                    {topicTitle(data.topics, task.topicId)}
                                  </span>
                                  <span className="text-[11px] tabular-nums text-slate-500">
                                    {task.minutes} Min
                                  </span>
                                  {task.origin !== "auto" && (
                                    <span className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] text-slate-400">
                                      {task.origin === "manual"
                                        ? "manuell"
                                        : "angepinnt"}
                                    </span>
                                  )}
                                </div>

                                <p className="mt-1 text-[11px] leading-4 text-slate-500">
                                  {task.reason}
                                </p>

                                {task.status === "open" && (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    <button
                                      onClick={() =>
                                        plan !== null &&
                                        patchTask(exam, plan, task.id, {
                                          status: "done",
                                        })
                                      }
                                      disabled={busy}
                                      className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:border-emerald-300/40 hover:text-emerald-200 disabled:opacity-50"
                                    >
                                      <Check size={12} />
                                      Erledigt
                                    </button>
                                    <button
                                      onClick={() =>
                                        plan !== null &&
                                        patchTask(exam, plan, task.id, {
                                          status: "skipped",
                                        })
                                      }
                                      disabled={busy}
                                      className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:border-white/25 disabled:opacity-50"
                                    >
                                      Auslassen
                                    </button>
                                    <button
                                      onClick={() => {
                                        setPostponeFor(
                                          postponeFor === task.id ? null : task.id,
                                        );
                                        setPostponeDate(addDays(today, 1));
                                      }}
                                      className="rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:border-white/25"
                                    >
                                      Verschieben
                                    </button>
                                    <button
                                      onClick={() =>
                                        plan !== null &&
                                        patchTask(exam, plan, task.id, {
                                          origin:
                                            task.origin === "pinned"
                                              ? "auto"
                                              : "pinned",
                                        })
                                      }
                                      disabled={busy}
                                      title={
                                        task.origin === "pinned"
                                          ? "Lösen"
                                          : "Anpinnen"
                                      }
                                      className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-slate-300 hover:border-cyan-300/40 hover:text-cyan-200 disabled:opacity-50"
                                    >
                                      {task.origin === "pinned" ? (
                                        <PinOff size={12} />
                                      ) : (
                                        <Pin size={12} />
                                      )}
                                    </button>
                                  </div>
                                )}

                                {postponeFor === task.id &&
                                  task.status === "open" && (
                                    <div className="mt-2 flex gap-1.5">
                                      <input
                                        type="date"
                                        value={postponeDate}
                                        min={today}
                                        onChange={(event) =>
                                          setPostponeDate(event.target.value)
                                        }
                                        className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#111827] px-2 py-1 text-[11px] text-white outline-none focus:border-cyan-300/50"
                                      />
                                      <button
                                        onClick={() => {
                                          if (
                                            plan !== null &&
                                            postponeDate !== ""
                                          ) {
                                            patchTask(exam, plan, task.id, {
                                              status: "postponed",
                                              postponedTo: postponeDate,
                                            });
                                          }

                                          setPostponeFor(null);
                                        }}
                                        disabled={busy}
                                        className="rounded-lg bg-cyan-300 px-3 py-1 text-[11px] font-medium text-slate-950 disabled:opacity-50"
                                      >
                                        OK
                                      </button>
                                    </div>
                                  )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}

                      {addingFor === exam.id ? (
                        <div className="grid gap-2 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-3 sm:grid-cols-2">
                          <label className="block text-xs text-slate-400">
                            Datum
                            <input
                              type="date"
                              value={addDraft.date}
                              min={today}
                              onChange={(event) =>
                                setAddDraft({
                                  ...addDraft,
                                  date: event.target.value,
                                })
                              }
                              className="mt-1 w-full rounded-lg border border-white/10 bg-[#111827] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50"
                            />
                          </label>
                          <label className="block text-xs text-slate-400">
                            Art
                            <select
                              value={addDraft.kind}
                              onChange={(event) =>
                                setAddDraft({
                                  ...addDraft,
                                  kind: event.target.value as PlanTaskKind,
                                })
                              }
                              className="mt-1 w-full rounded-lg border border-white/10 bg-[#111827] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50"
                            >
                              {(Object.keys(KIND_LABELS) as PlanTaskKind[]).map(
                                (kind) => (
                                  <option key={kind} value={kind}>
                                    {KIND_LABELS[kind]}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          <label className="block text-xs text-slate-400">
                            Thema (optional)
                            <select
                              value={addDraft.topicId}
                              onChange={(event) =>
                                setAddDraft({
                                  ...addDraft,
                                  topicId: event.target.value,
                                })
                              }
                              className="mt-1 w-full rounded-lg border border-white/10 bg-[#111827] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50"
                            >
                              <option value="">Kein Thema</option>
                              {data.topics.map((topic) => (
                                <option key={topic.id} value={topic.id}>
                                  {topic.title}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="block text-xs text-slate-400">
                            Minuten
                            <input
                              type="number"
                              min={5}
                              max={720}
                              value={addDraft.minutes}
                              onChange={(event) =>
                                setAddDraft({
                                  ...addDraft,
                                  minutes: event.target.value,
                                })
                              }
                              className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50"
                            />
                          </label>
                          <div className="flex gap-2 sm:col-span-2">
                            <button
                              onClick={() => void addManual(exam, plan)}
                              disabled={busy || addDraft.date === ""}
                              className="flex-1 rounded-xl bg-cyan-300 px-4 py-2 text-xs font-medium text-slate-950 disabled:opacity-50"
                            >
                              Aufgabe hinzufügen
                            </button>
                            <button
                              onClick={() => setAddingFor(null)}
                              className="rounded-xl border border-white/10 px-4 py-2 text-xs text-slate-300"
                            >
                              Abbrechen
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={() => setAddingFor(exam.id)}
                          className="flex items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30"
                        >
                          <Plus size={14} />
                          Eigene Aufgabe
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
