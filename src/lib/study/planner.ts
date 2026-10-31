/**
 * Deterministic study planner: per-exam schedules from availability,
 * prerequisites, quiz evidence, and due reviews. No LLM — the same
 * inputs always yield the same plan. Manual work (pinned tasks,
 * manual tasks, completions) survives recalculation; deficits are
 * reported honestly instead of overbooking the user.
 */

import { daysBetween } from "@/src/lib/briefing";
import { addDaysISO } from "@/src/lib/revision";
import { getQuizReviewInfo } from "@/src/lib/quizReview";
import { normalizeTopicName } from "@/src/lib/study/topics";
import { minutesForDate } from "@/src/lib/study/exams";
import type {
  Entry,
  PlanTask,
  PlanTaskKind,
  StudyPlan,
} from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";

/** Minutes per due question inside review tasks. */
export const REVIEW_MINUTES_PER_QUESTION = 5;

/** Max questions grouped into one review task. */
export const REVIEW_GROUP_SIZE = 6;

/** Minutes of one mock exam. */
export const MOCK_MINUTES = 60;

/** Questions sampled into one mock exam. */
export const MOCK_QUESTIONS = 10;

/** Max auto minutes per topic per day (variety over cramming). */
export const TOPIC_DAY_CAP = 45;

/** Final phase: practice goes before theory this close to the exam. */
export const FINAL_PHASE_DAYS = 7;

/** Weak below this mean accuracy (0..1). */
export const WEAK_ACCURACY = 0.6;

export type TopicNeed = {
  topicId: string;
  theory: number;
  practice: number;
  level: number;
  rank: number;
  accuracy: number | null;
};

/** Mean accuracy over attempted linked questions (null = never). */
export function topicAccuracy(
  topicId: string,
  questions: QuizQuestion[],
): number | null {
  const attempted = questions.filter(
    (question) =>
      question.topicId === topicId &&
      typeof question.reviewCount === "number" &&
      question.reviewCount > 0 &&
      typeof question.successCount === "number",
  );

  if (attempted.length === 0) return null;

  const sum = attempted.reduce(
    (total, question) =>
      total +
      (question.successCount as number) / (question.reviewCount as number),
    0,
  );

  return sum / attempted.length;
}

function round5(minutes: number): number {
  return Math.max(5, Math.round(minutes / 5) * 5);
}

/**
 * Transparent effort estimate: base from material size
 * (concepts, formulas, examples, sources), scaled by mastery
 * and weakness. Mastered topics need no study time — only
 * their due reviews still surface.
 */
export function estimateTopicMinutes(
  topic: Entry,
  questions: QuizQuestion[],
): { theory: number; practice: number } {
  if (topic.mastery === "mastered") return { theory: 0, practice: 0 };

  const data = topic.topicData;
  const base =
    15 +
    4 * (data?.concepts.length ?? 0) +
    8 * (data?.formulas.length ?? 0) +
    2 * (data?.examples.length ?? 0) +
    6 * Math.min(topic.sourceRefs?.length ?? 0, 6);
  const masteryMult =
    topic.mastery === "understood"
      ? 0.3
      : topic.mastery === "learning"
        ? 0.8
        : topic.mastery === "needs-revision"
          ? 1.2
          : 1;
  const accuracy = topicAccuracy(topic.id, questions);
  const weakMult =
    accuracy !== null && accuracy < WEAK_ACCURACY ? 1.5 : 1;
  const total = Math.min(
    180,
    Math.max(10, Math.round(base * masteryMult * weakMult)),
  );
  const theory = round5(total * 0.5);

  return { theory, practice: Math.max(5, total - theory) };
}

export type PrerequisiteGraph = {
  levels: Map<string, number>;
  /** Prerequisite names that matched no topic. */
  unknown: string[];
};

/**
 * Prerequisite levels from topic names (0 = no prerequisites).
 * Cycles resolve to level 0 with the topic treated as a root —
 * the plan never deadlocks on extraction noise.
 */
export function prerequisiteLevels(topics: Entry[]): PrerequisiteGraph {
  const byName = new Map(
    topics.map((topic) => [normalizeTopicName(topic.title), topic.id]),
  );
  const levels = new Map<string, number>();
  const unknown = new Set<string>();
  const visiting = new Set<string>();

  const levelOf = (topic: Entry): number => {
    const cached = levels.get(topic.id);

    if (cached !== undefined) return cached;

    if (visiting.has(topic.id)) return 0;

    visiting.add(topic.id);

    let level = 0;

    for (const name of topic.topicData?.prerequisites ?? []) {
      const depId = byName.get(normalizeTopicName(name));

      if (depId === undefined) {
        unknown.add(name);
        continue;
      }

      const dep = topics.find((entry) => entry.id === depId);

      if (dep !== undefined) {
        level = Math.max(level, levelOf(dep) + 1);
      }
    }

    visiting.delete(topic.id);
    levels.set(topic.id, level);

    return level;
  };

  for (const topic of topics) levelOf(topic);

  return { levels, unknown: [...unknown].sort() };
}

/**
 * Rank for study order (lower = earlier). User priority wins
 * over evidence except mastery: a mastered topic stays
 * review-only even when marked important.
 */
function topicRank(topic: Entry, accuracy: number | null): number {
  if (topic.mastery === "mastered") return 4;

  const priority = topic.topicData?.priority ?? "normal";

  if (priority === "high") return 0;
  if (priority === "low") return 4;
  if (topic.mastery === "needs-revision") return 0;
  if (accuracy !== null && accuracy < WEAK_ACCURACY) return 0;
  if (topic.mastery === undefined || topic.mastery === "not-started") return 1;
  if (topic.mastery === "learning") return 2;

  return 3;
}

function scopeTopics(exam: Entry, topics: Entry[]): Entry[] {
  const linked = exam.examData?.topicIds ?? [];

  if (linked.length > 0) {
    const ids = new Set(linked);

    return topics.filter((topic) => ids.has(topic.id));
  }

  if (exam.subject !== undefined && exam.subject !== "") {
    return topics.filter((topic) => topic.subject === exam.subject);
  }

  return [];
}

function scopeQuestions(
  exam: Entry,
  scoped: Entry[],
  questions: QuizQuestion[],
): QuizQuestion[] {
  const topicIds = new Set(scoped.map((topic) => topic.id));

  return questions.filter(
    (question) =>
      question.examId === exam.id ||
      (question.topicId !== null && topicIds.has(question.topicId)),
  );
}

/** Stable input fingerprint — mismatch marks a stored plan stale. */
export function planInputsSignature(
  exam: Entry,
  topics: Entry[],
  questions: QuizQuestion[],
): string {
  const scoped = scopeTopics(exam, topics);
  const inScope = scopeQuestions(exam, scoped, questions);

  return JSON.stringify({
    d: exam.date ?? null,
    a: exam.examData?.availability ?? null,
    t: scoped
      .map((topic) => [
        topic.id,
        topic.title,
        topic.mastery ?? null,
        JSON.stringify(topic.topicData ?? null),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    q: inScope
      .map((question) => [
        question.id,
        question.reviewCount ?? 0,
        question.successCount ?? 0,
        question.nextReviewAt ?? null,
        question.examId ?? null,
        question.topicId ?? null,
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  });
}

export type CombinedDay = {
  date: string;
  poolMinutes: number;
  plannedMinutes: number;
  exams: { examId: string; minutes: number }[];
};

export type PlanConflict = {
  date: string;
  poolMinutes: number;
  demandedMinutes: number;
  examIds: string[];
};

export type PlannerResult = {
  plans: StudyPlan[];
  combined: CombinedDay[];
  conflicts: PlanConflict[];
};

export function generateStudyPlans(args: {
  exams: Entry[];
  topics: Entry[];
  questions: QuizQuestion[];
  todayISO: string;
}): PlannerResult {
  const { exams, topics, questions, todayISO } = args;
  const graph = prerequisiteLevels(topics);
  const plans: StudyPlan[] = [];

  type ExamState = {
    exam: Entry;
    scoped: Entry[];
    inScope: QuizQuestion[];
    horizon: string[];
    needs: TopicNeed[];
    dueGroups: { topicId: string | null; questionIds: string[] }[];
    mocksLeft: number;
    mockDone: number;
    tasks: PlanTask[];
    warnings: string[];
    seq: number;
  };

  const states: ExamState[] = [];

  for (const exam of exams) {
    const signature = planInputsSignature(exam, topics, questions);
    const previous = exam.examData?.plan ?? null;
    const carried: PlanTask[] = (previous?.tasks ?? []).filter(
      (task) => task.status === "done",
    );
    const warnings: string[] = [];
    const daysLeft =
      exam.date === undefined ? null : daysBetween(todayISO, exam.date);

    if (exam.date === undefined || daysLeft === null) {
      warnings.push("Kein Prüfungstermin gesetzt — lege ein Datum fest.");
      plans.push({
        examId: exam.id,
        generatedAt: new Date().toISOString(),
        inputsSignature: signature,
        deficitMinutes: 0,
        warnings,
        tasks: carried,
      });
      continue;
    }

    if (daysLeft <= 0) {
      warnings.push("Der Prüfungstermin liegt in der Vergangenheit.");
      plans.push({
        examId: exam.id,
        generatedAt: new Date().toISOString(),
        inputsSignature: signature,
        deficitMinutes: 0,
        warnings,
        tasks: carried,
      });
      continue;
    }

    const horizon: string[] = [];

    for (let offset = 0; offset < daysLeft; offset += 1) {
      const day = addDaysISO(todayISO, offset);

      if (day !== null) horizon.push(day);
    }

    const scoped = scopeTopics(exam, topics);
    const inScope = scopeQuestions(exam, scoped, questions);

    if (scoped.length === 0 && inScope.length === 0) {
      warnings.push("Keine Themen oder Fragen verknüpft.");
    }

    const unknownHere = graph.unknown.filter((name) =>
      scoped.some((topic) =>
        (topic.topicData?.prerequisites ?? []).includes(name),
      ),
    );

    if (unknownHere.length > 0) {
      warnings.push(
        `Unbekannte Voraussetzungen werden ignoriert: ${unknownHere.join(", ")}.`,
      );
    }

    // Covered work reduces the remaining need per topic: done
    // tasks plus pinned/manual/postponed slots (they occupy real
    // capacity, so auto scheduling must not duplicate them).
    // Reviews stay question-driven — only the quiz flow clears dues.
    const coveredTheory = new Map<string, number>();
    const coveredPractice = new Map<string, number>();
    let mocksCovered = 0;

    const cover = (task: PlanTask): void => {
      if (task.topicId === null) {
        if (task.kind === "mock") mocksCovered += 1;

        return;
      }

      if (task.kind === "review") return;

      const target =
        task.kind === "theory" ? coveredTheory : coveredPractice;

      target.set(
        task.topicId,
        (target.get(task.topicId) ?? 0) + task.minutes,
      );
    };

    for (const task of previous?.tasks ?? []) {
      if (
        task.status === "done" ||
        (task.status === "open" &&
          (task.origin === "pinned" || task.origin === "manual")) ||
        task.status === "postponed"
      ) {
        cover(task);
      }
    }

    const needs: TopicNeed[] = scoped.map((topic) => {
      const accuracy = topicAccuracy(topic.id, questions);
      const estimate = estimateTopicMinutes(topic, questions);

      return {
        topicId: topic.id,
        theory: Math.max(
          0,
          estimate.theory - (coveredTheory.get(topic.id) ?? 0),
        ),
        practice: Math.max(
          0,
          estimate.practice - (coveredPractice.get(topic.id) ?? 0),
        ),
        level: graph.levels.get(topic.id) ?? 0,
        rank: topicRank(topic, accuracy),
        accuracy,
      };
    });

    // Due reviews first: grouped per topic, earliest due first.
    const due = inScope
      .map((question) => ({
        question,
        info: getQuizReviewInfo(question, todayISO),
      }))
      .filter(({ info }) => info.status !== "later")
      .sort(
        (a, b) =>
          a.info.dueISO.localeCompare(b.info.dueISO) ||
          a.question.id.localeCompare(b.question.id),
      );
    const dueGroups: ExamState["dueGroups"] = [];
    const groupOf = new Map<string, { topicId: string | null; questionIds: string[] }>();

    for (const { question } of due) {
      const key = question.topicId ?? "general";
      let group = groupOf.get(key);

      if (
        group === undefined ||
        group.questionIds.length >= REVIEW_GROUP_SIZE
      ) {
        group = { topicId: question.topicId, questionIds: [] };
        groupOf.set(`${key}#${dueGroups.length}`, group);
        dueGroups.push(group);
      }

      group.questionIds.push(question.id);
    }

    const mocksWanted =
      horizon.length >= 30 ? 2 : horizon.length >= 14 ? 1 : 0;

    states.push({
      exam,
      scoped,
      inScope,
      horizon,
      needs,
      dueGroups,
      mocksLeft: Math.max(0, mocksWanted - mocksCovered),
      mockDone: mocksCovered,
      tasks: [...carried],
      warnings,
      seq: 0,
    });
  }

  // Fixed tasks (pinned/manual open, postponed) occupy capacity first.
  const fixedByDate = new Map<string, { examId: string; task: PlanTask }[]>();

  for (const state of states) {
    const previous = state.exam.examData?.plan ?? null;
    const lastDay = state.horizon[state.horizon.length - 1] ?? todayISO;

    for (const task of previous?.tasks ?? []) {
      if (task.status === "done" || task.status === "skipped") continue;

      if (task.status === "postponed") {
        const target =
          task.postponedTo !== undefined && task.postponedTo >= todayISO
            ? task.postponedTo
            : todayISO;
        const clamped = target > lastDay ? lastDay : target;
        const moved: PlanTask = {
          ...task,
          id: `t:${state.exam.id}:${clamped}:${task.kind}:${task.topicId ?? "x"}:v${(state.seq += 1)}`,
          date: clamped,
          origin: "auto",
          status: "open",
          postponedTo: undefined,
          reason: `${task.reason} (Verschoben vom ${task.date}.)`,
        };

        if (clamped !== target) {
          state.warnings.push(
            `Eine verschobene Aufgabe passte nicht mehr in den Zeitraum und liegt jetzt am ${clamped}.`,
          );
        }

        state.tasks.push(moved);
        pushFixed(fixedByDate, clamped, state.exam.id, moved);
        continue;
      }

      // Open pinned/manual tasks keep their slot (past → today).
      const day = task.date < todayISO ? todayISO : task.date;
      const kept: PlanTask =
        day === task.date
          ? { ...task }
          : {
              ...task,
              date: day,
              reason: `${task.reason} (Überfällig — auf heute gelegt.)`,
            };

      state.tasks.push(kept);
      pushFixed(fixedByDate, day, state.exam.id, kept);
    }
  }

  // Joint day-by-day allocation over the shared pool.
  const allDates = [
    ...new Set(states.flatMap((state) => state.horizon)),
  ].sort();
  const combined: CombinedDay[] = [];
  const conflicts: PlanConflict[] = [];

  for (const date of allDates) {
    const activeToday = states.filter((state) =>
      state.horizon.includes(date),
    );
    const avail = new Map(
      activeToday.map((state) => [
        state.exam.id,
        minutesForDate(state.exam, date),
      ]),
    );
    const pool = Math.max(0, ...avail.values());
    const fixed = fixedByDate.get(date) ?? [];
    const fixedMinutes = fixed.reduce(
      (sum, entry) => sum + entry.task.minutes,
      0,
    );
    const planned = new Map<string, number>();

    for (const entry of fixed) {
      planned.set(
        entry.examId,
        (planned.get(entry.examId) ?? 0) + entry.task.minutes,
      );
    }

    let remaining = pool - fixedMinutes;
    const demanded = [...avail.values()].reduce((sum, n) => sum + n, 0);
    const backlogOpen = activeToday.some(
      (state) => backlogMinutes(state) > 0,
    );

    if (fixedMinutes > pool || (demanded > pool && backlogOpen)) {
      conflicts.push({
        date,
        poolMinutes: pool,
        demandedMinutes: Math.max(demanded, fixedMinutes),
        examIds: activeToday.map((state) => state.exam.id).sort(),
      });
    }

    // Deadline first, then weakness, then stable id order.
    const ordered = [...activeToday].sort((a, b) => {
      const dateCmp = String(a.exam.date).localeCompare(String(b.exam.date));

      if (dateCmp !== 0) return dateCmp;

      const weakCmp = weaknessOf(b) - weaknessOf(a);

      if (weakCmp !== 0) return weakCmp;

      return a.exam.id.localeCompare(b.exam.id);
    });

    for (const state of ordered) {
      const ownFixed = fixed
        .filter((entry) => entry.examId === state.exam.id)
        .reduce((sum, entry) => sum + entry.task.minutes, 0);
      const share = Math.max(
        0,
        Math.min((avail.get(state.exam.id) ?? 0) - ownFixed, remaining),
      );

      if (share <= 0) continue;

      const used = scheduleDay(state, date, share, topics);

      planned.set(state.exam.id, (planned.get(state.exam.id) ?? 0) + used);
      remaining -= used;
    }

    combined.push({
      date,
      poolMinutes: pool,
      plannedMinutes: [...planned.values()].reduce((sum, n) => sum + n, 0),
      exams: [...planned.entries()]
        .map(([examId, minutes]) => ({ examId, minutes }))
        .sort((a, b) => a.examId.localeCompare(b.examId)),
    });
  }

  // Deficits + warnings per exam.
  for (const state of states) {
    const left =
      state.needs.reduce(
        (sum, need) => sum + need.theory + need.practice,
        0,
      ) +
      state.dueGroups.reduce(
        (sum, group) =>
          sum + group.questionIds.length * REVIEW_MINUTES_PER_QUESTION,
        0,
      ) +
      state.mocksLeft * MOCK_MINUTES;

    if (left > 0) {
      state.warnings.push(
        `Die verfügbare Zeit reicht nicht: ${left} Minuten Lernstoff bleiben ungeplant. Verfügbarkeit erhöhen oder Stoff kürzen.`,
      );
    }

    plans.push({
      examId: state.exam.id,
      generatedAt: new Date().toISOString(),
      inputsSignature: planInputsSignature(
        state.exam,
        topics,
        questions,
      ),
      deficitMinutes: left,
      warnings: state.warnings,
      tasks: state.tasks.sort((a, b) =>
        a.date.localeCompare(b.date) ||
        a.kind.localeCompare(b.kind) ||
        a.id.localeCompare(b.id),
      ),
    });
  }

  return { plans, combined, conflicts };
}

function pushFixed(
  fixedByDate: Map<string, { examId: string; task: PlanTask }[]>,
  date: string,
  examId: string,
  task: PlanTask,
): void {
  const list = fixedByDate.get(date) ?? [];

  list.push({ examId, task });
  fixedByDate.set(date, list);
}

/** Unscheduled minutes incl. reviews and mocks (conflict signal). */
function backlogMinutes(state: {
  needs: TopicNeed[];
  dueGroups: { questionIds: string[] }[];
  mocksLeft: number;
}): number {
  return (
    state.needs.reduce(
      (sum, need) => sum + need.theory + need.practice,
      0,
    ) +
    state.dueGroups.reduce(
      (sum, group) =>
        sum + group.questionIds.length * REVIEW_MINUTES_PER_QUESTION,
      0,
    ) +
    state.mocksLeft * MOCK_MINUTES
  );
}

function weaknessOf(state: {
  needs: TopicNeed[];
  dueGroups: { questionIds: string[] }[];
}): number {
  return (
    state.needs
      .filter((need) => need.rank === 0)
      .reduce((sum, need) => sum + need.theory + need.practice, 0) +
    state.dueGroups.reduce(
      (sum, group) =>
        sum + group.questionIds.length * REVIEW_MINUTES_PER_QUESTION,
      0,
    )
  );
}

function topicTitle(topics: Entry[], topicId: string | null): string {
  if (topicId === null) return "Gemischte Wiederholung";

  return topics.find((topic) => topic.id === topicId)?.title ?? "Thema";
}

/**
 * Schedules one exam's backlog into a daily share. Order: due
 * reviews → mock (final week only) → topics by prerequisite
 * level, then weakness. Returns the minutes consumed.
 */
function scheduleDay(
  state: {
    exam: Entry;
    horizon: string[];
    needs: TopicNeed[];
    dueGroups: { topicId: string | null; questionIds: string[] }[];
    mocksLeft: number;
    inScope: QuizQuestion[];
    tasks: PlanTask[];
    seq: number;
  },
  date: string,
  share: number,
  topics: Entry[],
): number {
  let remaining = share;

  const nextId = (kind: PlanTaskKind, topicId: string | null): string => {
    state.seq += 1;

    return `t:${state.exam.id}:${date}:${kind}:${topicId ?? "x"}:${state.seq}`;
  };

  // 1. Due reviews (oldest first, already grouped).
  while (remaining > 0 && state.dueGroups.length > 0) {
    const group = state.dueGroups[0] as (typeof state.dueGroups)[number];
    const minutes = group.questionIds.length * REVIEW_MINUTES_PER_QUESTION;

    if (minutes > remaining) break;

    state.dueGroups.shift();
    state.tasks.push({
      id: nextId("review", group.topicId),
      date,
      kind: "review",
      topicId: group.topicId,
      questionIds: [...group.questionIds],
      minutes,
      priority: "high",
      reason: `Fällige Wiederholung: ${group.questionIds.length} ${group.questionIds.length === 1 ? "Frage" : "Fragen"} zu „${topicTitle(topics, group.topicId)}“.`,
      origin: "auto",
      status: "open",
    });
    remaining -= minutes;
  }

  // 2. Mock exam on a strong final-week day.
  const daysToExam = state.exam.date === undefined ? null : daysBetween(date, state.exam.date);

  if (
    state.mocksLeft > 0 &&
    state.inScope.length > 0 &&
    daysToExam !== null &&
    daysToExam <= FINAL_PHASE_DAYS &&
    remaining >= Math.min(MOCK_MINUTES, 45)
  ) {
    const minutes = Math.min(MOCK_MINUTES, remaining);
    const sampled = [...state.inScope]
      .sort((a, b) => {
        const accA = accuracyOf(a);
        const accB = accuracyOf(b);

        return accA - accB || a.id.localeCompare(b.id);
      })
      .slice(0, MOCK_QUESTIONS)
      .map((question) => question.id);

    state.mocksLeft -= 1;
    state.tasks.push({
      id: nextId("mock", null),
      date,
      kind: "mock",
      topicId: null,
      questionIds: sampled,
      minutes,
      priority: "high",
      reason: `Probeprüfung ${daysToExam} ${daysToExam === 1 ? "Tag" : "Tage"} vor der Prüfung — Simulation unter Zeitdruck.`,
      origin: "auto",
      status: "open",
    });
    remaining -= minutes;
  }

  // 3. Topics by prerequisite level, then weakness.
  const orderedNeeds = state.needs
    .filter((need) => need.theory + need.practice > 0)
    .sort(
      (a, b) =>
        a.level - b.level ||
        a.rank - b.rank ||
        String(a.topicId).localeCompare(String(b.topicId)),
    );
  const finalPhase =
    daysToExam !== null && daysToExam <= FINAL_PHASE_DAYS;

  for (const need of orderedNeeds) {
    if (remaining <= 0) break;

    // Blocked levels wait: a topic starts only when every lower
    // level is fully scheduled (prerequisites first).
    const blocked = state.needs.some(
      (other) =>
        other.level < need.level && other.theory + other.practice > 0,
    );

    if (blocked) continue;

    const slices: { kind: PlanTaskKind; group: "theory" | "practice" }[] =
      finalPhase
        ? [
            { kind: "quiz", group: "practice" },
            { kind: "exercise", group: "practice" },
            { kind: "theory", group: "theory" },
          ]
        : [
            { kind: "theory", group: "theory" },
            { kind: "exercise", group: "practice" },
            { kind: "quiz", group: "practice" },
          ];

    for (const slice of slices) {
      if (remaining <= 0) break;

      const open = need[slice.group];

      if (open <= 0) continue;

      const minutes = Math.min(open, remaining, TOPIC_DAY_CAP);

      if (minutes < 5) continue;

      need[slice.group] -= minutes;
      state.tasks.push({
        id: nextId(slice.kind, need.topicId),
        date,
        kind: slice.kind,
        topicId: need.topicId,
        questionIds: [],
        minutes,
        priority:
          need.rank === 0 ? "high" : need.rank <= 2 ? "normal" : "low",
        reason: reasonFor(topics, need, slice.kind, finalPhase),
        origin: "auto",
        status: "open",
      });
      remaining -= minutes;
    }
  }

  return share - remaining;
}

function accuracyOf(question: QuizQuestion): number {
  if (
    typeof question.reviewCount !== "number" ||
    question.reviewCount <= 0 ||
    typeof question.successCount !== "number"
  ) {
    return 0.5;
  }

  return question.successCount / question.reviewCount;
}

function reasonFor(
  topics: Entry[],
  need: TopicNeed,
  kind: PlanTaskKind,
  finalPhase: boolean,
): string {
  const title = topicTitle(topics, need.topicId);
  const kindLabel =
    kind === "theory"
      ? "Theorie"
      : kind === "exercise"
        ? "Übung"
        : "Abfrage";

  const priority = topics.find(
    (topic) => topic.id === need.topicId,
  )?.topicData?.priority;

  if (priority === "high") {
    return `${kindLabel} zu „${title}“ — von dir als wichtig markiert.`;
  }

  if (need.accuracy !== null && need.accuracy < WEAK_ACCURACY) {
    const percent = Math.round(need.accuracy * 100);

    return `${kindLabel} zu „${title}“ — schwaches Thema (Trefferquote ${percent} %).`;
  }

  if (need.rank === 0) {
    return `${kindLabel} zu „${title}“ — braucht Wiederholung.`;
  }

  if (need.level > 0) {
    return `${kindLabel} zu „${title}“ — baut auf früheren Themen auf.`;
  }

  if (finalPhase) {
    return `${kindLabel} zu „${title}“ — prüfungsnahe Festigung.`;
  }

  return `${kindLabel} zu „${title}“ — Grundlagen aufbauen.`;
}
