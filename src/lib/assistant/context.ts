import type { CalendarEvent } from "@/src/lib/calendar";
import type { FinanceData } from "@/src/lib/finance";
import type { StudyData } from "@/src/lib/study";
import type { Task } from "@/src/lib/tasks";
import type { Deadline } from "@/src/lib/briefing";
import type {
  LifestylePreferences,
  OutingPlan,
  Place,
} from "@/src/lib/lifestyle/types";
import { usageOf, type MemoryEntry } from "@/src/lib/memory";
import {
  getApprovedMemory,
  getExamsNeedingAttention,
  getFinanceMonthSummary,
  getLargestTransactions,
  getLifestylePreferences,
  getOpenTasks,
  getSavedPlaces,
  getStudyDeadlines,
  getStudyProgress,
  getTodayEvents,
  getUpcomingPlans,
  type FinanceMonthSummary,
  type StudyProgress,
} from "./tools";

/**
 * Unified assistant context: one snapshot assembled from the module
 * tools — no duplicated business logic, no fabricated data.
 *
 * The caller passes explicit timestamps (`todayISO`, `nowTime`,
 * `builtAt`) so the builder stays pure and time-zone safe: all
 * comparisons use local calendar dates (YYYY-MM-DD) and HH:MM.
 */

export type ContextModuleKey =
  | "tasks"
  | "events"
  | "study"
  | "finance"
  | "lifestyle"
  | "memory";

export type ContextInput = {
  /** Local date YYYY-MM-DD, HH:MM time, and ISO build timestamp. */
  todayISO: string;
  nowTime: string;
  builtAt: string;
  tasks: Task[];
  events: CalendarEvent[];
  study: StudyData;
  finance: FinanceData;
  places: Place[];
  savedIds: string[];
  plans: OutingPlan[];
  prefs: LifestylePreferences;
  memory: MemoryEntry[];
  /** Per-module load state; stale modules are skipped, never guessed. */
  loaded: Record<ContextModuleKey, boolean>;
};

export type InsightSeverity = "info" | "warning" | "alert";

export type Insight = {
  /** Stable id; each insight is emitted at most once per build. */
  id: string;
  severity: InsightSeverity;
  title: string;
  detail: string;
  reason: string;
  href: string;
};

export type OutingFit = {
  plan: OutingPlan;
  reason: string;
};

export type AssistantContext = {
  todayISO: string;
  monthKey: string;
  builtAt: string;
  /** Modules whose data had not loaded when this was built. */
  stale: ContextModuleKey[];
  schedule: { today: CalendarEvent[] };
  tasks: { open: Task[]; overdue: Task[] };
  study: {
    deadlines: Deadline[];
    progress: StudyProgress;
    attention: {
      examId: string;
      title: string;
      date: string;
      daysLeft: number;
      openTopics: number;
    }[];
  };
  finance: { summary: FinanceMonthSummary };
  lifestyle: {
    upcomingPlans: OutingPlan[];
    savedCount: number;
    missingSavedIds: string[];
    configured: boolean;
    outingFit: OutingFit | null;
  };
  memory: { pinned: MemoryEntry[]; activeCount: number };
  insights: Insight[];
};

const EMPTY_PROGRESS: StudyProgress = {
  subjects: 0,
  examsTotal: 0,
  examsUpcoming: 0,
  topicsOpen: 0,
  topicsDone: 0,
  completionPct: null,
};

function emptySummary(monthKey: string): FinanceMonthSummary {
  return {
    monthKey,
    incomeCents: 0,
    expenseCents: 0,
    netCents: 0,
    txCount: 0,
    nonEuroCount: 0,
    budgetCents: 0,
    budgetUsedPct: null,
    budgetExceeded: false,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export function buildAssistantContext(input: ContextInput): AssistantContext {
  const monthKey = input.todayISO.slice(0, 7);
  const stale = (
    Object.keys(input.loaded) as ContextModuleKey[]
  ).filter((key) => !input.loaded[key]);
  const fresh = (key: ContextModuleKey): boolean => input.loaded[key];

  const todayEvents = fresh("events")
    ? getTodayEvents({ events: input.events, todayISO: input.todayISO })
    : null;
  const openTasks = fresh("tasks")
    ? getOpenTasks({ tasks: input.tasks, nowTime: input.nowTime })
    : null;
  const deadlines = fresh("study")
    ? getStudyDeadlines({ study: input.study, todayISO: input.todayISO })
    : null;
  const progress = fresh("study")
    ? getStudyProgress({ study: input.study, todayISO: input.todayISO })
    : null;
  const attention = fresh("study")
    ? getExamsNeedingAttention({ study: input.study, todayISO: input.todayISO })
    : null;
  const summary = fresh("finance")
    ? getFinanceMonthSummary({ finance: input.finance, monthKey })
    : null;
  const largestAll = fresh("finance")
    ? getLargestTransactions({ finance: input.finance, monthKey, limit: 5 })
    : null;
  const largestExpense =
    largestAll !== null && largestAll.ok
      ? (largestAll.data.find((item) => item.type === "expense") ?? null)
      : null;
  const saved = fresh("lifestyle")
    ? getSavedPlaces({ places: input.places, savedIds: input.savedIds })
    : null;
  const upcomingPlans = fresh("lifestyle")
    ? getUpcomingPlans({ plans: input.plans, todayISO: input.todayISO })
    : null;
  const prefs = fresh("lifestyle")
    ? getLifestylePreferences({ preferences: input.prefs })
    : null;
  const memory = fresh("memory")
    ? getApprovedMemory({ memory: input.memory, todayISO: input.todayISO })
    : null;

  const financeSummary =
    summary !== null && summary.ok ? summary.data : emptySummary(monthKey);
  const lifestylePlans =
    upcomingPlans !== null && upcomingPlans.ok
      ? upcomingPlans.data.plans
      : [];
  const lifestylePrefs =
    prefs !== null && prefs.ok ? prefs.data.preferences : null;
  const memoryEntries =
    memory !== null && memory.ok ? memory.data.entries : [];

  const outingFit = findOutingFit(
    lifestylePlans,
    lifestylePrefs,
    input.places,
  );
  const insights = buildInsights({
    openTasks: openTasks !== null && openTasks.ok ? openTasks.data : null,
    attention: attention !== null && attention.ok ? attention.data : null,
    summary: financeSummary,
    financeFresh: fresh("finance"),
    largest: largestExpense,
    finance: input.finance,
    monthKey,
    outingFit,
  });

  return {
    todayISO: input.todayISO,
    monthKey,
    builtAt: input.builtAt,
    stale,
    schedule: {
      today: todayEvents !== null && todayEvents.ok ? todayEvents.data.events : [],
    },
    tasks: {
      open: openTasks !== null && openTasks.ok ? openTasks.data.open : [],
      overdue:
        openTasks !== null && openTasks.ok ? openTasks.data.overdue : [],
    },
    study: {
      deadlines: deadlines !== null && deadlines.ok ? deadlines.data.deadlines : [],
      progress: progress !== null && progress.ok ? progress.data : EMPTY_PROGRESS,
      attention: attention !== null && attention.ok ? attention.data : [],
    },
    finance: { summary: financeSummary },
    lifestyle: {
      upcomingPlans: lifestylePlans,
      savedCount: saved !== null && saved.ok ? saved.data.saved.length : 0,
      missingSavedIds:
        saved !== null && saved.ok ? saved.data.missingIds : [],
      configured: prefs !== null && prefs.ok ? prefs.data.configured : false,
      outingFit,
    },
    memory: {
      pinned: memoryEntries.filter((entry) =>
        usageOf(entry, input.todayISO).includes("Tagesbriefing"),
      ),
      activeCount: memoryEntries.length,
    },
    insights,
  };
}

function findOutingFit(
  plans: OutingPlan[],
  prefs: LifestylePreferences | null,
  places: Place[],
): OutingFit | null {
  if (prefs === null) return null;
  if (prefs.maxBudgetCents === null && prefs.maxDurationMinutes === null) {
    return null;
  }

  const byId = new Map(places.map((place) => [place.id, place]));

  for (const plan of plans) {
    if (plan.budgetCents === null && plan.durationMinutes === null) continue;

    const budgetOk =
      prefs.maxBudgetCents === null ||
      plan.budgetCents === null ||
      plan.budgetCents <= prefs.maxBudgetCents;
    const timeOk =
      prefs.maxDurationMinutes === null ||
      plan.durationMinutes === null ||
      plan.durationMinutes <= prefs.maxDurationMinutes;

    if (!budgetOk || !timeOk) continue;

    const stopNames = plan.stops
      .map((stop) => byId.get(stop.placeId)?.name)
      .filter((name) => name !== undefined);

    const reasons: string[] = [];

    if (prefs.maxBudgetCents !== null && plan.budgetCents !== null) {
      reasons.push("passt ins Budget");
    }

    if (prefs.maxDurationMinutes !== null && plan.durationMinutes !== null) {
      reasons.push("passt in die verfügbare Zeit");
    }

    if (reasons.length === 0) continue;

    return {
      plan,
      reason: `${reasons.join(" und ")}${stopNames.length > 0 ? ` · ${stopNames.slice(0, 3).join(", ")}` : ""}`,
    };
  }

  return null;
}

function buildInsights(input: {
  openTasks: { open: Task[]; overdue: Task[] } | null;
  attention:
    | {
        examId: string;
        title: string;
        date: string;
        daysLeft: number;
        openTopics: number;
      }[]
    | null;
  summary: FinanceMonthSummary;
  financeFresh: boolean;
  largest: {
    id: string;
    title: string;
    date: string;
    amountCents: number;
    type: "income" | "expense";
    category: string;
  } | null;
  finance: FinanceData;
  monthKey: string;
  outingFit: OutingFit | null;
}): Insight[] {
  const insights: Insight[] = [];

  if (input.attention !== null) {
    for (const exam of input.attention.slice(0, 3)) {
      const when =
        exam.daysLeft === 0
          ? "heute"
          : exam.daysLeft === 1
            ? "morgen"
            : `in ${exam.daysLeft} Tagen`;

      insights.push({
        id: `exam-${exam.examId}`,
        severity: exam.daysLeft <= 3 ? "alert" : "warning",
        title: `Prüfung ${when}: ${exam.title}`,
        detail: `Noch ${exam.openTopics} ${exam.openTopics === 1 ? "offenes Thema" : "offene Themen"}.`,
        reason: `Die Prüfung findet ${when} statt und hat unerledigte Themen.`,
        href: "/study",
      });
    }
  }

  if (input.openTasks !== null && input.openTasks.overdue.length > 0) {
    const count = input.openTasks.overdue.length;

    insights.push({
      id: "tasks-overdue",
      severity: "warning",
      title: `${count} ${count === 1 ? "überfällige Aufgabe" : "überfällige Aufgaben"}`,
      detail: input.openTasks.overdue
        .slice(0, 3)
        .map((task) => task.title)
        .join(" · "),
      reason:
        "Die Uhrzeit dieser Aufgaben liegt heute bereits in der Vergangenheit.",
      href: "/#aufgaben",
    });
  }

  if (
    input.financeFresh &&
    input.summary.budgetUsedPct !== null &&
    input.summary.budgetUsedPct >= 0.8 &&
    !input.summary.budgetExceeded
  ) {
    // Exceeded budgets are shown inline in the finance strip; the insight
    // covers only the approaching-limit case (no duplicates).
    const pct = Math.round(input.summary.budgetUsedPct * 100);

    insights.push({
      id: "budget-near",
      severity: "warning",
      title: `Budget zu ${pct} % ausgeschöpft`,
      detail: "Die Ausgaben nähern sich dem Monatslimit.",
      reason: `Bestätigte Ausgaben erreichen ${pct} % des konfigurierten Monatsbudgets.`,
      href: "/finance",
    });
  }

  if (input.financeFresh && input.largest !== null) {
    const expenses = input.finance.transactions
      .filter(
        (transaction) =>
          transaction.date.startsWith(input.monthKey) &&
          transaction.type === "expense" &&
          (transaction.currency === undefined ||
            transaction.currency === "EUR"),
      )
      .map((transaction) => transaction.amount);
    const med = median(expenses);

    if (
      input.largest.type === "expense" &&
      expenses.length >= 3 &&
      med > 0 &&
      input.largest.amountCents >= 5000 &&
      input.largest.amountCents >= med * 3
    ) {
      const factor = (input.largest.amountCents / med).toFixed(1).replace(".", ",");

      insights.push({
        id: `large-tx-${input.largest.id}`,
        severity: "info",
        title: `Große Ausgabe: ${input.largest.title}`,
        detail: `Das ${factor}-Fache des Medians (${expenses.length} Ausgaben im Monat).`,
        reason:
          "Die größte bestätigte Ausgabe liegt mindestens 3× über dem Median.",
        href: "/finance",
      });
    }
  }

  if (input.outingFit !== null) {
    insights.push({
      id: `outing-${input.outingFit.plan.id}`,
      severity: "info",
      title: `Ausflugsidee: ${input.outingFit.plan.title}`,
      detail: input.outingFit.reason,
      reason: "Ein gespeicherter Ausflug passt zu deinen Zeit- und Budgetfiltern.",
      href: "/lifestyle",
    });
  }

  return insights;
}
