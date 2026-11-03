import {
  isCalendarEventList,
  timeToMinutes,
  type CalendarEvent,
} from "@/src/lib/calendar";
import {
  EMPTY_FINANCE,
  isEuroTransaction,
  isFinanceData,
  type FinanceData,
} from "@/src/lib/finance";
import { EMPTY_STUDY, isStudyData } from "@/src/lib/study";
import {
  isTaskList,
  isTaskOverdue,
  type Task,
} from "@/src/lib/tasks";
import {
  collectDeadlines,
  openTasks,
  type Deadline,
} from "@/src/lib/briefing";
import {
  isLifestylePreferences,
  isOutingPlanList,
  isPlaceList,
  isSavedList,
  type LifestylePreferences,
  type OutingPlan,
  type Place,
} from "@/src/lib/lifestyle/types";
import {
  activeMemory,
  isMemoryEntryList,
  type MemoryEntry,
} from "@/src/lib/memory";
import {
  isLectureSessionList,
  isLocalRecordingList,
  type LectureSession,
  type LocalRecording,
} from "@/src/lib/lecture/types";

/**
 * Local-only assistant tools (read-only in this phase).
 *
 * Tools never touch storage directly: callers pass already-loaded,
 * validated module data in. Every tool re-validates its input and
 * returns a typed result, so a future model adapter gets a safe,
 * predictable boundary. No PDFs, no statements, no raw blobs here —
 * only summaries the UI could already display.
 */

export type ToolErrorCode =
  | "invalid-input"
  | "missing-date"
  | "not-loaded"
  | "unavailable";

export type ToolError = {
  code: ToolErrorCode;
  message: string;
};

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError };

export function toolError(code: ToolErrorCode, message: string): ToolError {
  return { code, message };
}

function invalidInput(tool: string): ToolError {
  return toolError(
    "invalid-input",
    `${tool}: ungültige Eingabedaten (Modul fehlt oder ist beschädigt).`,
  );
}

export type TodayEvents = {
  todayISO: string;
  events: CalendarEvent[];
};

/** Today's calendar events, sorted by start time. */
export function getTodayEvents(input: {
  events: unknown;
  todayISO: string | null;
}): ToolResult<TodayEvents> {
  if (input.todayISO === null) {
    return {
      ok: false,
      error: toolError("missing-date", "getTodayEvents: kein Datum verfügbar."),
    };
  }

  if (!isCalendarEventList(input.events)) {
    return { ok: false, error: invalidInput("getTodayEvents") };
  }

  const todayISO = input.todayISO;

  return {
    ok: true,
    data: {
      todayISO,
      events: input.events
        .filter((event) => event.date === todayISO)
        .sort((a, b) => a.start.localeCompare(b.start)),
    },
  };
}

export type UpcomingEvents = {
  todayISO: string;
  days: number;
  events: CalendarEvent[];
};

/** Events from today until `days` days out (inclusive). */
export function getUpcomingEvents(input: {
  events: unknown;
  todayISO: string | null;
  days?: number;
}): ToolResult<UpcomingEvents> {
  if (input.todayISO === null) {
    return {
      ok: false,
      error: toolError("missing-date", "getUpcomingEvents: kein Datum verfügbar."),
    };
  }

  if (!isCalendarEventList(input.events)) {
    return { ok: false, error: invalidInput("getUpcomingEvents") };
  }

  const days =
    input.days !== undefined &&
    Number.isInteger(input.days) &&
    input.days >= 0 &&
    input.days <= 60
      ? input.days
      : 7;
  const todayISO = input.todayISO;
  const end = new Date(`${todayISO}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + days);
  const endISO = end.toISOString().slice(0, 10);

  return {
    ok: true,
    data: {
      todayISO,
      days,
      events: input.events
        .filter((event) => event.date >= todayISO && event.date <= endISO)
        .sort((a, b) =>
          a.date === b.date
            ? a.start.localeCompare(b.start)
            : a.date.localeCompare(b.date),
        ),
    },
  };
}

export type OpenTasks = {
  open: Task[];
  /**
   * Open tasks that are overdue: past their due date (when `todayISO`
   * is given), or — for tasks without a due date — whose HH:MM time
   * already passed (dashboard tasks without a date are today's list).
   */
  overdue: Task[];
};

/** Incomplete tasks, highest priority first, plus overdue ones. */
export function getOpenTasks(input: {
  tasks: unknown;
  nowTime: string | null;
  todayISO?: string;
}): ToolResult<OpenTasks> {
  if (!isTaskList(input.tasks)) {
    return { ok: false, error: invalidInput("getOpenTasks") };
  }

  const open = openTasks(input.tasks);
  const nowMinutes =
    input.nowTime === null ? null : timeToMinutes(input.nowTime);
  const todayISO =
    input.todayISO !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(input.todayISO)
      ? input.todayISO
      : null;

  const overdue = open.filter((task) => {
    if (todayISO !== null && isTaskOverdue(task, todayISO)) return true;
    if (nowMinutes === null) return false;
    if (task.dueDate !== undefined) return false;

    const taskMinutes = timeToMinutes(task.time);

    return taskMinutes !== null && taskMinutes < nowMinutes;
  });

  return { ok: true, data: { open, overdue } };
}

export type StudyDeadlines = {
  todayISO: string;
  deadlines: Deadline[];
};

/** Exams and open topics with valid dates, most overdue first. */
export function getStudyDeadlines(input: {
  study: unknown;
  todayISO: string | null;
}): ToolResult<StudyDeadlines> {
  if (input.todayISO === null) {
    return {
      ok: false,
      error: toolError("missing-date", "getStudyDeadlines: kein Datum verfügbar."),
    };
  }

  if (!isStudyData(input.study)) {
    return { ok: false, error: invalidInput("getStudyDeadlines") };
  }

  return {
    ok: true,
    data: {
      todayISO: input.todayISO,
      deadlines: collectDeadlines(input.study, input.todayISO),
    },
  };
}

export type StudyProgress = {
  subjects: number;
  examsTotal: number;
  examsUpcoming: number;
  topicsOpen: number;
  topicsDone: number;
  /** Null when there are no topics at all. */
  completionPct: number | null;
};

/** Study counts and overall topic completion. */
export function getStudyProgress(input: {
  study: unknown;
  todayISO: string | null;
}): ToolResult<StudyProgress> {
  const study = isStudyData(input.study) ? input.study : EMPTY_STUDY;
  const todayISO = input.todayISO ?? "";
  const topicsDone = study.topics.filter(
    (topic) => topic.done === true,
  ).length;
  const topicsOpen = study.topics.length - topicsDone;

  return {
    ok: true,
    data: {
      subjects: study.subjects.length,
      examsTotal: study.exams.length,
      examsUpcoming: study.exams.filter(
        (exam) => exam.date !== undefined && exam.date >= todayISO,
      ).length,
      topicsOpen,
      topicsDone,
      completionPct:
        study.topics.length === 0
          ? null
          : topicsDone / study.topics.length,
    },
  };
}

export type ExamAttention = {
  examId: string;
  title: string;
  date: string;
  daysLeft: number;
  openTopics: number;
};

/**
 * Upcoming exams (within `withinDays`, default 14) that still have
 * unfinished topics. Topics match by equal subject (case-insensitive);
 * exams without a subject count all open topics.
 */
export function getExamsNeedingAttention(input: {
  study: unknown;
  todayISO: string | null;
  withinDays?: number;
}): ToolResult<ExamAttention[]> {
  const deadlines = getStudyDeadlines({
    study: input.study,
    todayISO: input.todayISO,
  });

  if (!deadlines.ok) return deadlines;
  if (!isStudyData(input.study)) {
    return { ok: false, error: invalidInput("getExamsNeedingAttention") };
  }

  const withinDays =
    input.withinDays !== undefined &&
    Number.isInteger(input.withinDays) &&
    input.withinDays >= 0 &&
    input.withinDays <= 90
      ? input.withinDays
      : 14;
  const openTopics = input.study.topics.filter(
    (topic) => topic.done !== true,
  );
  const result: ExamAttention[] = [];

  for (const deadline of deadlines.data.deadlines) {
    if (deadline.kind !== "exam") continue;
    if (deadline.daysLeft < 0 || deadline.daysLeft > withinDays) continue;

    const subject = (deadline.subject ?? "").trim().toLowerCase();
    const matching =
      subject === ""
        ? openTopics.length
        : openTopics.filter(
            (topic) => (topic.subject ?? "").trim().toLowerCase() === subject,
          ).length;

    if (matching === 0) continue;

    result.push({
      examId: deadline.id,
      title: deadline.title,
      date: deadline.date,
      daysLeft: deadline.daysLeft,
      openTopics: matching,
    });
  }

  return { ok: true, data: result };
}

export type FinanceMonthSummary = {
  monthKey: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  txCount: number;
  nonEuroCount: number;
  budgetCents: number;
  /** Null when no budget is configured. */
  budgetUsedPct: number | null;
  budgetExceeded: boolean;
};

/** Confirmed Euro transactions of one month (YYYY-MM) + budget usage. */
export function getFinanceMonthSummary(input: {
  finance: unknown;
  monthKey: string;
}): ToolResult<FinanceMonthSummary> {
  if (!/^\d{4}-\d{2}$/.test(input.monthKey)) {
    return {
      ok: false,
      error: toolError("invalid-input", "getFinanceMonthSummary: ungültiger Monat."),
    };
  }

  const finance: FinanceData = isFinanceData(input.finance)
    ? input.finance
    : EMPTY_FINANCE;
  let incomeCents = 0;
  let expenseCents = 0;
  let txCount = 0;
  let nonEuroCount = 0;

  for (const transaction of finance.transactions) {
    if (!transaction.date.startsWith(input.monthKey)) continue;

    txCount += 1;

    if (!isEuroTransaction(transaction)) {
      nonEuroCount += 1;
      continue;
    }

    if (transaction.type === "income") {
      incomeCents += transaction.amount;
    } else {
      expenseCents += transaction.amount;
    }
  }

  const budgetCents = finance.monthlyBudgetCents;

  return {
    ok: true,
    data: {
      monthKey: input.monthKey,
      incomeCents,
      expenseCents,
      netCents: incomeCents - expenseCents,
      txCount,
      nonEuroCount,
      budgetCents,
      budgetUsedPct: budgetCents > 0 ? expenseCents / budgetCents : null,
      budgetExceeded: budgetCents > 0 && expenseCents > budgetCents,
    },
  };
}

export type LargestTransaction = {
  id: string;
  title: string;
  date: string;
  amountCents: number;
  type: "income" | "expense";
  category: string;
};

/** Largest confirmed Euro transactions of one month (no notes, no IBANs). */
export function getLargestTransactions(input: {
  finance: unknown;
  monthKey: string;
  limit?: number;
}): ToolResult<LargestTransaction[]> {
  if (!/^\d{4}-\d{2}$/.test(input.monthKey)) {
    return {
      ok: false,
      error: toolError(
        "invalid-input",
        "getLargestTransactions: ungültiger Monat.",
      ),
    };
  }

  if (!isFinanceData(input.finance)) {
    return { ok: false, error: invalidInput("getLargestTransactions") };
  }

  const limit =
    input.limit !== undefined &&
    Number.isInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= 20
      ? input.limit
      : 5;

  const largest = input.finance.transactions
    .filter(
      (transaction) =>
        transaction.date.startsWith(input.monthKey) &&
        isEuroTransaction(transaction),
    )
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit)
    .map((transaction) => ({
      id: transaction.id,
      title: transaction.title,
      date: transaction.date,
      amountCents: transaction.amount,
      type: transaction.type,
      category: transaction.category,
    }));

  return { ok: true, data: largest };
}

export type SavedPlaces = {
  saved: Place[];
  /** Ids without a matching place (deleted after saving). */
  missingIds: string[];
};

/** Saved places with full details; no coordinates unless stored. */
export function getSavedPlaces(input: {
  places: unknown;
  savedIds: unknown;
}): ToolResult<SavedPlaces> {
  if (!isPlaceList(input.places) || !isSavedList(input.savedIds)) {
    return { ok: false, error: invalidInput("getSavedPlaces") };
  }

  const byId = new Map(input.places.map((place) => [place.id, place]));
  const saved: Place[] = [];
  const missingIds: string[] = [];

  for (const id of input.savedIds) {
    const place = byId.get(id);

    if (place === undefined) {
      missingIds.push(id);
    } else {
      saved.push(place);
    }
  }

  return { ok: true, data: { saved, missingIds } };
}

export type UpcomingPlans = {
  todayISO: string;
  plans: OutingPlan[];
};

/** Outing plans dated today or later, soonest first. */
export function getUpcomingPlans(input: {
  plans: unknown;
  todayISO: string | null;
}): ToolResult<UpcomingPlans> {
  if (input.todayISO === null) {
    return {
      ok: false,
      error: toolError("missing-date", "getUpcomingPlans: kein Datum verfügbar."),
    };
  }

  if (!isOutingPlanList(input.plans)) {
    return { ok: false, error: invalidInput("getUpcomingPlans") };
  }

  const todayISO = input.todayISO;

  return {
    ok: true,
    data: {
      todayISO,
      plans: input.plans
        .filter((plan) => plan.date >= todayISO)
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
  };
}

export type ApprovedMemory = {
  todayISO: string;
  entries: MemoryEntry[];
};

/**
 * User-approved memory only: user entries plus approved derived ones,
 * excluding archived and expired entries. Never returns unapproved
 * drafts.
 */
export function getApprovedMemory(input: {
  memory: unknown;
  todayISO: string | null;
}): ToolResult<ApprovedMemory> {
  if (input.todayISO === null) {
    return {
      ok: false,
      error: toolError("missing-date", "getApprovedMemory: kein Datum verfügbar."),
    };
  }

  if (!isMemoryEntryList(input.memory)) {
    return { ok: false, error: invalidInput("getApprovedMemory") };
  }

  return {
    ok: true,
    data: {
      todayISO: input.todayISO,
      entries: activeMemory(input.memory, input.todayISO),
    },
  };
}

export type LifestylePrefs = {
  preferences: LifestylePreferences;
  /** True when the user configured anything beyond defaults. */
  configured: boolean;
};

/** Lifestyle preferences (city, budget, filters) — opt-in data only. */
export function getLifestylePreferences(input: {
  preferences: unknown;
}): ToolResult<LifestylePrefs> {
  if (!isLifestylePreferences(input.preferences)) {
    return { ok: false, error: invalidInput("getLifestylePreferences") };
  }

  const prefs = input.preferences;
  const configured =
    prefs.city !== "" ||
    prefs.maxBudgetCents !== null ||
    prefs.categories.length > 0 ||
    prefs.setting !== "any" ||
    prefs.maxDurationMinutes !== null ||
    prefs.company !== "any" ||
    prefs.useGeolocation;

  return { ok: true, data: { preferences: prefs, configured } };
}

export type CalendarList = {
  from: string;
  to: string;
  events: CalendarEvent[];
};

/** Events between two ISO days (inclusive); past ranges allowed. */
export function getCalendarList(input: {
  events: unknown;
  todayISO: string | null;
  from?: string;
  to?: string;
}): ToolResult<CalendarList> {
  if (input.todayISO === null) {
    return {
      ok: false,
      error: toolError("missing-date", "getCalendarList: kein Datum verfügbar."),
    };
  }

  if (!isCalendarEventList(input.events)) {
    return { ok: false, error: invalidInput("getCalendarList") };
  }

  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const from = input.from ?? input.todayISO;
  const to = input.to ?? input.todayISO;

  if (!iso.test(from) || !iso.test(to) || from > to) {
    return {
      ok: false,
      error: toolError("invalid-input", "getCalendarList: ungültiger Zeitraum."),
    };
  }

  return {
    ok: true,
    data: {
      from,
      to,
      events: input.events
        .filter((event) => event.date >= from && event.date <= to)
        .sort((a, b) =>
          a.date === b.date
            ? a.start.localeCompare(b.start)
            : a.date.localeCompare(b.date),
        ),
    },
  };
}

export type RecentTransaction = {
  id: string;
  title: string;
  date: string;
  amountCents: number;
  type: "income" | "expense";
  category: string;
  currency: string;
};

/** Newest transactions of any currency (display only, never converted). */
export function getFinanceList(input: {
  finance: unknown;
  limit?: number;
}): ToolResult<RecentTransaction[]> {
  if (!isFinanceData(input.finance)) {
    return { ok: false, error: invalidInput("getFinanceList") };
  }

  const limit =
    input.limit !== undefined &&
    Number.isInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= 50
      ? input.limit
      : 10;

  const recent = input.finance.transactions
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
    .map((transaction) => ({
      id: transaction.id,
      title: transaction.title,
      date: transaction.date,
      amountCents: transaction.amount,
      type: transaction.type,
      category: transaction.category,
      currency: transaction.currency ?? "EUR",
    }));

  return { ok: true, data: recent };
}

/** Month summary, defaulting an omitted month to the current one. */
export function getFinanceSummary(input: {
  finance: unknown;
  todayISO: string | null;
  monthKey?: string;
}): ToolResult<FinanceMonthSummary> {
  const monthKey = input.monthKey ?? input.todayISO?.slice(0, 7) ?? "";

  return getFinanceMonthSummary({ finance: input.finance, monthKey });
}

export type LectureOverview = {
  sessionCount: number;
  recordingCount: number;
  /** Successfully stored recordings only (no in-progress/failed). */
  savedCount: number;
  failedCount: number;
  totalDurationSeconds: number;
  sessions: LectureSession[];
  /** Newest recordings first (max 10); metadata only, never audio. */
  recent: LocalRecording[];
};

/**
 * Local lecture library overview: sessions plus recording metadata.
 * No audio, no transcripts here — only counts and descriptors the
 * lecture page could already display.
 */
export function getLectureOverview(input: {
  sessions: unknown;
  recordings: unknown;
}): ToolResult<LectureOverview> {
  if (!isLectureSessionList(input.sessions)) {
    return { ok: false, error: invalidInput("getLectureOverview") };
  }

  if (!isLocalRecordingList(input.recordings)) {
    return { ok: false, error: invalidInput("getLectureOverview") };
  }

  const recent = [...input.recordings]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);

  return {
    ok: true,
    data: {
      sessionCount: input.sessions.length,
      recordingCount: input.recordings.length,
      savedCount: input.recordings.filter(
        (recording) => recording.status === "saved_locally",
      ).length,
      failedCount: input.recordings.filter(
        (recording) => recording.status === "failed",
      ).length,
      totalDurationSeconds: input.recordings.reduce(
        (sum, recording) => sum + Math.max(0, recording.durationSeconds),
        0,
      ),
      sessions: input.sessions,
      recent,
    },
  };
}

// ------------------------------------------------------------ study intel
// Server/IDB-backed tools: unlike the sync tools above, these run
// through `AgentOptions.asyncReads` (the caller fetches owned data
// from the API or IndexedDB). Only the result shapes live here so
// the registry `output` names keep resolving to `./tools` types.

export type StudyDocumentRef = {
  id: string;
  name: string;
  kind: string;
  subject: string | null;
  extractionStatus: string;
};

export type StudyDocuments = {
  documents: StudyDocumentRef[];
};

export type StudySource = {
  documentId: string;
  documentName: string;
  refLabel: string;
  text: string;
  score: number;
  matchedTerms: string[];
};

export type StudyRetrieval = {
  sources: StudySource[];
  totalCandidates: number;
  terms: string[];
};

// ------------------------------------------------------- daily briefing
// One composite read for "Tagesbriefing / was steht heute an": today’s
// events, open tasks, study deadlines, and the current month’s finance
// summary — composed ONLY from the caller’s loaded data through the
// same validated tools the single-purpose reads use. No module is
// guessed: when any input is missing or corrupt the whole read fails
// and names the broken modules, so the caller can fall back to the
// single-purpose reads. Never mock data, never invented values.

export type BriefingToday = {
  todayISO: string;
  today: TodayEvents;
  tasks: OpenTasks;
  deadlines: StudyDeadlines;
  finance: FinanceMonthSummary;
};

export function getBriefingToday(input: {
  events: unknown;
  tasks: unknown;
  study: unknown;
  finance: unknown;
  todayISO: string | null;
  nowTime: string | null;
}): ToolResult<BriefingToday> {
  if (input.todayISO === null) {
    return {
      ok: false,
      error: toolError("missing-date", "getBriefingToday: kein Datum verfügbar."),
    };
  }

  const todayISO = input.todayISO;
  const unavailable: { module: string; message: string }[] = [];

  const today = getTodayEvents({ events: input.events, todayISO });
  const tasks = getOpenTasks({ tasks: input.tasks, nowTime: input.nowTime });
  const deadlines = getStudyDeadlines({ study: input.study, todayISO });
  const finance = getFinanceSummary({
    finance: input.finance,
    todayISO,
  });

  if (!today.ok) {
    unavailable.push({ module: "calendar", message: today.error.message });
  }

  if (!tasks.ok) {
    unavailable.push({ module: "tasks", message: tasks.error.message });
  }

  if (!deadlines.ok) {
    unavailable.push({ module: "study", message: deadlines.error.message });
  }

  if (!finance.ok) {
    unavailable.push({ module: "finance", message: finance.error.message });
  }

  if (!today.ok || !tasks.ok || !deadlines.ok || !finance.ok) {
    return {
      ok: false,
      error: toolError(
        "invalid-input",
        `getBriefingToday: unvollständige Daten (${unavailable.map((entry) => entry.module).join(", ")}).`,
      ),
    };
  }

  return {
    ok: true,
    data: {
      todayISO,
      today: today.data,
      tasks: tasks.data,
      deadlines: deadlines.data,
      finance: finance.data,
    },
  };
}
