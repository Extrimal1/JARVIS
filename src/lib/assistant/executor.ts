/**
 * Client-side plan executor: turns validated `AssistantPlan`s into
 * verified store operations — through the SAME hooks and API routes
 * the calendar and finance pages use.
 *
 * Why client-side: the user's data already lives here (loaded stores),
 * so target resolution (update/delete by reference) needs no extra
 * fetch, works in local AND cloud mode, and inherits all existing
 * validation, authorization, and persistence rules. The server NLU
 * layer never sees user data.
 *
 * Guarantees:
 * - Confirmation messages are built from the persisted result only.
 * - Creates run immediately and offer undo; update/delete always
 *   confirm first (destructive or fuzzy-matched).
 * - Every execution is keyed: retries/double-clicks with the same
 *   idempotency key return the cached report instead of re-running.
 */

import {
  findConflicts,
  isCalendarEvent,
  type CalendarEvent,
} from "@/src/lib/calendar";
import type { RemoteResult } from "@/src/lib/db/useRemoteResource";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  formatCents,
  isEuroTransaction,
  isTransaction,
  type FinanceData,
  type Transaction,
} from "@/src/lib/finance";
import { normalizeDescription } from "@/src/lib/finance/categories";
import {
  type AssistantLocale,
  type AssistantPlan,
  type EventPatch,
  type EventRef,
  type NewEventFields,
  type NewTransactionFields,
} from "./actions";

/** Actionable plans (clarify/unsupported render directly, no executor). */
export type ActionPlan = Exclude<
  AssistantPlan,
  { type: "clarify" } | { type: "unsupported" }
>;

export type CalendarStore = {
  create: (event: CalendarEvent) => Promise<RemoteResult<CalendarEvent>>;
  update: (
    id: string,
    patch: Partial<CalendarEvent>,
  ) => Promise<RemoteResult<CalendarEvent>>;
  remove: (id: string) => Promise<RemoteResult<null>>;
};

export type FinanceStore = {
  saveTransaction: (tx: Transaction) => Promise<RemoteResult<Transaction>>;
  deleteTransaction: (id: string) => Promise<RemoteResult<null>>;
};

export type ExecutorDeps = {
  events: CalendarEvent[];
  finance: FinanceData;
  calendar: CalendarStore;
  transactions: FinanceStore;
  locale: AssistantLocale;
};

export type UndoAction =
  | { kind: "remove-event"; id: string }
  | { kind: "restore-event"; event: CalendarEvent }
  | { kind: "restore-event-patch"; id: string; previous: CalendarEvent }
  | { kind: "remove-transaction"; id: string }
  | { kind: "restore-transaction"; transaction: Transaction };

export type PendingAction =
  | {
      kind: "calendar.update";
      id: string;
      patch: EventPatch;
      previous: CalendarEvent;
      summary: string;
    }
  | { kind: "calendar.delete"; event: CalendarEvent; summary: string };

export type CandidateOption = { label: string; eventId: string };

export type ExecutionReport =
  | {
      status: "done";
      message: string;
      href?: string;
      undoLabel?: string;
      undo?: UndoAction;
    }
  | { status: "confirm"; summary: string; pending: PendingAction }
  | { status: "pick"; question: string; options: CandidateOption[] }
  | { status: "error"; message: string };

// --------------------------------------------------------------- messages

const DAY_DE = new Intl.DateTimeFormat("de-DE", {
  weekday: "short",
  day: "numeric",
  month: "numeric",
  timeZone: "UTC",
});

const DAY_RU = new Intl.DateTimeFormat("ru-RU", {
  weekday: "short",
  day: "numeric",
  month: "numeric",
  timeZone: "UTC",
});

/** Weekday-aware short day; UTC-noon parse avoids timezone shifts. */
export function formatDay(iso: string, locale: AssistantLocale): string {
  const date = new Date(`${iso}T12:00:00Z`);

  return (locale === "ru" ? DAY_RU : DAY_DE).format(date);
}

export function formatMoney(
  cents: number,
  currency: string,
  locale: AssistantLocale,
): string {
  if (currency === "EUR") return formatCents(cents);

  try {
    return new Intl.NumberFormat(locale === "ru" ? "ru-RU" : "de-DE", {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

type Strings = {
  undo: string;
  undone: string;
  undoFailed: (reason: string) => string;
  saveFailed: (reason: string) => string;
  deleteFailed: (reason: string) => string;
  invalid: string;
  eventCreated: (title: string, day: string, start: string, end: string) => string;
  conflictHint: (other: string) => string;
  eventUpdated: (title: string, day: string, start: string, end: string) => string;
  eventDeleted: (title: string, day: string, start: string) => string;
  eventListHead: (label: string, count: number) => string;
  eventListEmpty: (label: string) => string;
  eventLine: (day: string, start: string, title: string) => string;
  eventLineSameDay: (start: string, title: string) => string;
  moreEvents: (rest: number) => string;
  noMatch: string;
  pickQuestion: string;
  confirmUpdate: (summary: string) => string;
  confirmDelete: (summary: string) => string;
  txExpense: (amount: string, title: string, category: string) => string;
  txIncome: (amount: string, title: string, category: string) => string;
  txListHead: (count: number) => string;
  txListEmpty: string;
  txLine: (day: string, title: string, amount: string) => string;
  summary: (
    label: string,
    expense: string,
    income: string,
    count: number,
  ) => string;
  budgetUsed: (pct: number, budget: string) => string;
  budgetExceeded: string;
  nonEuroNote: (count: number) => string;
};

const STRINGS: Record<AssistantLocale, Strings> = {
  de: {
    undo: "Rückgängig",
    undone: "Rückgängig gemacht.",
    undoFailed: (reason) => `Rückgängig fehlgeschlagen: ${reason}`,
    saveFailed: (reason) => `Speichern fehlgeschlagen: ${reason}`,
    deleteFailed: (reason) => `Löschen fehlgeschlagen: ${reason}`,
    invalid: "Die Aktion war ungültig und wurde nicht ausgeführt.",
    eventCreated: (title, day, start, end) =>
      `Gespeichert: „${title}“ · ${day} · ${start}–${end} Uhr.`,
    conflictHint: (other) => ` Hinweis: Überschneidung mit „${other}“.`,
    eventUpdated: (title, day, start, end) =>
      `Geändert: „${title}“ · ${day} · ${start}–${end} Uhr.`,
    eventDeleted: (title, day, start) =>
      `Gelöscht: „${title}“ (${day}, ${start} Uhr).`,
    eventListHead: (label, count) =>
      `${count} ${count === 1 ? "Termin" : "Termine"} (${label}):`,
    eventListEmpty: (label) => `Keine Termine gefunden (${label}).`,
    eventLine: (day, start, title) => `${day} · ${start} Uhr · ${title}`,
    eventLineSameDay: (start, title) => `${start} Uhr · ${title}`,
    moreEvents: (rest) => `… und ${rest} weitere.`,
    noMatch: "Dazu habe ich keinen passenden Termin gefunden.",
    pickQuestion: "Welchen Termin meinst du?",
    confirmUpdate: (summary) => `Wirklich ändern? ${summary}`,
    confirmDelete: (summary) => `Wirklich löschen? ${summary}`,
    txExpense: (amount, title, category) =>
      title === category
        ? `Ausgabe gespeichert: ${amount} · ${category}.`
        : `Ausgabe gespeichert: ${amount} bei ${title} · ${category}.`,
    txIncome: (amount, title, category) =>
      title === category
        ? `Einnahme gespeichert: ${amount} · ${category}.`
        : `Einnahme gespeichert: ${amount} von ${title} · ${category}.`,
    txListHead: (count) =>
      `${count} ${count === 1 ? "Buchung" : "Buchungen"} (neueste zuerst):`,
    txListEmpty: "Noch keine Buchungen vorhanden.",
    txLine: (day, title, amount) => `${day} · ${title} · ${amount}`,
    summary: (label, expense, income, count) =>
      `Übersicht ${label}: Ausgaben ${expense} · Einnahmen ${income} · ${count} ${count === 1 ? "Buchung" : "Buchungen"}.`,
    budgetUsed: (pct, budget) =>
      ` Budget zu ${pct} % von ${budget} verbraucht.`,
    budgetExceeded: " Budget überschritten!",
    nonEuroNote: (count) =>
      ` (${count} Fremdwährungsbuchungen nicht enthalten.)`,
  },
  ru: {
    undo: "Отменить",
    undone: "Отменено.",
    undoFailed: (reason) => `Не удалось отменить: ${reason}`,
    saveFailed: (reason) => `Не удалось сохранить: ${reason}`,
    deleteFailed: (reason) => `Не удалось удалить: ${reason}`,
    invalid: "Действие недействительно и не было выполнено.",
    eventCreated: (title, day, start, end) =>
      `Сохранено: «${title}» · ${day} · ${start}–${end}.`,
    conflictHint: (other) => ` Обрати внимание: пересекается с «${other}».`,
    eventUpdated: (title, day, start, end) =>
      `Изменено: «${title}» · ${day} · ${start}–${end}.`,
    eventDeleted: (title, day, start) =>
      `Удалено: «${title}» (${day}, ${start}).`,
    eventListHead: (label, count) => `Встречи (${label}), всего ${count}:`,
    eventListEmpty: (label) => `Встречи не найдены (${label}).`,
    eventLine: (day, start, title) => `${day} · ${start} · ${title}`,
    eventLineSameDay: (start, title) => `${start} · ${title}`,
    moreEvents: (rest) => `… и ещё ${rest}.`,
    noMatch: "Подходящая встреча не найдена.",
    pickQuestion: "Какую встречу ты имеешь в виду?",
    confirmUpdate: (summary) => `Точно изменить? ${summary}`,
    confirmDelete: (summary) => `Точно удалить? ${summary}`,
    txExpense: (amount, title, category) =>
      title === category
        ? `Расход сохранён: ${amount} · ${category}.`
        : `Расход сохранён: ${amount} · ${title} · ${category}.`,
    txIncome: (amount, title, category) =>
      title === category
        ? `Доход сохранён: ${amount} · ${category}.`
        : `Доход сохранён: ${amount} · ${title} · ${category}.`,
    txListHead: (count) => `Операции (сначала новые), всего ${count}:`,
    txListEmpty: "Операций пока нет.",
    txLine: (day, title, amount) => `${day} · ${title} · ${amount}`,
    summary: (label, expense, income, count) =>
      `Итоги (${label}): расходы ${expense} · доходы ${income} · операций: ${count}.`,
    budgetUsed: (pct, budget) => ` Бюджет использован на ${pct} % из ${budget}.`,
    budgetExceeded: " Бюджет превышен!",
    nonEuroNote: (count) => ` (без ${count} опер. в валюте).`,
  },
};

// -------------------------------------------------------------- resolution

function normalizeRef(value: string): string {
  return normalizeDescription(value);
}

const REF_STOPWORDS = new Set([
  "bei",
  "beim",
  "mit",
  "von",
  "vom",
  "der",
  "die",
  "das",
  "den",
  "dem",
  "des",
  "ein",
  "eine",
  "einen",
  "einem",
  "einer",
  "für",
  "und",
  "oder",
]);

/**
 * Fuzzy event lookup: full-phrase substring wins, otherwise every
 * significant word (> 2 chars, no prepositions/articles) must occur.
 * Sorted chronologically.
 */
export function resolveEventReference(
  ref: EventRef,
  events: CalendarEvent[],
): CalendarEvent[] {
  const query = normalizeRef(ref.titleQuery);
  const words = query
    .split(" ")
    .filter((word) => word.length > 2 && !REF_STOPWORDS.has(word));

  return events
    .filter((event) => {
      if (ref.date !== undefined && event.date !== ref.date) return false;

      const hay = normalizeRef(
        `${event.title} ${event.description} ${event.location}`,
      );

      if (query !== "" && hay.includes(query)) return true;

      return words.length > 0 && words.every((word) => hay.includes(word));
    })
    .sort((a, b) =>
      a.date === b.date
        ? a.start.localeCompare(b.start)
        : a.date.localeCompare(b.date),
    );
}

function candidateLabel(event: CalendarEvent, locale: AssistantLocale): string {
  return `${formatDay(event.date, locale)} · ${event.start} · ${event.title}`;
}

// -------------------------------------------------------------- idempotency

const REPORT_CACHE = new Map<string, ExecutionReport>();
const INFLIGHT = new Map<string, Promise<ExecutionReport>>();

function cacheReport(key: string, report: ExecutionReport): ExecutionReport {
  REPORT_CACHE.set(key, report);

  if (REPORT_CACHE.size > 50) {
    const oldest = REPORT_CACHE.keys().next().value;

    if (oldest !== undefined) REPORT_CACHE.delete(oldest);
  }

  return report;
}

async function runOnce(
  key: string,
  task: () => Promise<ExecutionReport>,
): Promise<ExecutionReport> {
  const cached = REPORT_CACHE.get(key);

  if (cached !== undefined) return cached;

  const pending = INFLIGHT.get(key);

  if (pending !== undefined) return pending;

  const run = task().then(
    (report) => {
      INFLIGHT.delete(key);

      return cacheReport(key, report);
    },
    (error: unknown) => {
      INFLIGHT.delete(key);

      throw error;
    },
  );

  INFLIGHT.set(key, run);

  return run;
}

/** Test seam: forget cached reports. */
export function clearExecutionCache(): void {
  REPORT_CACHE.clear();
  INFLIGHT.clear();
}

// ------------------------------------------------------------------ create

function buildEvent(id: string, fields: NewEventFields): CalendarEvent {
  return {
    id,
    title: fields.title,
    date: fields.date,
    start: fields.start,
    end: fields.end,
    type: fields.type,
    description: fields.description,
    location: fields.location,
  };
}

function buildTransaction(
  id: string,
  fields: NewTransactionFields,
): Transaction {
  const allowed =
    fields.type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  return {
    id,
    title: fields.title,
    amount: fields.amountCents,
    type: fields.type,
    category: (allowed as readonly string[]).includes(fields.category)
      ? fields.category
      : "Sonstiges",
    date: fields.date,
    currency: fields.currency,
    importStatus: "manual",
  };
}

async function executeCalendarCreate(
  id: string,
  fields: NewEventFields,
  deps: ExecutorDeps,
): Promise<ExecutionReport> {
  const strings = STRINGS[deps.locale];
  const event = buildEvent(id, fields);

  if (!isCalendarEvent(event)) {
    return { status: "error", message: strings.invalid };
  }

  const conflicts = findConflicts(deps.events, event);
  const result = await deps.calendar.create(event);

  if (!result.ok) {
    return { status: "error", message: strings.saveFailed(result.error) };
  }

  const saved = result.data;
  let message = strings.eventCreated(
    saved.title,
    formatDay(saved.date, deps.locale),
    saved.start,
    saved.end,
  );

  if (conflicts.length > 0) {
    message += strings.conflictHint(conflicts[0].title);
  }

  return {
    status: "done",
    message,
    href: "/calendar",
    undoLabel: strings.undo,
    undo: { kind: "remove-event", id: saved.id },
  };
}

async function executeFinanceCreate(
  id: string,
  fields: NewTransactionFields,
  deps: ExecutorDeps,
): Promise<ExecutionReport> {
  const strings = STRINGS[deps.locale];
  const transaction = buildTransaction(id, fields);

  if (!isTransaction(transaction)) {
    return { status: "error", message: strings.invalid };
  }

  const result = await deps.transactions.saveTransaction(transaction);

  if (!result.ok) {
    return { status: "error", message: strings.saveFailed(result.error) };
  }

  const saved = result.data;
  const amount = formatMoney(saved.amount, saved.currency ?? "EUR", deps.locale);
  const message =
    saved.type === "income"
      ? strings.txIncome(amount, saved.title, saved.category)
      : strings.txExpense(amount, saved.title, saved.category);

  return {
    status: "done",
    message,
    href: "/finance",
    undoLabel: strings.undo,
    undo: { kind: "remove-transaction", id: saved.id },
  };
}

// -------------------------------------------------------------------- list

function executeCalendarList(
  from: string,
  to: string,
  label: string,
  deps: ExecutorDeps,
): ExecutionReport {
  const strings = STRINGS[deps.locale];
  const matches = deps.events
    .filter((event) => event.date >= from && event.date <= to)
    .sort((a, b) =>
      a.date === b.date
        ? a.start.localeCompare(b.start)
        : a.date.localeCompare(b.date),
    );

  if (matches.length === 0) {
    return { status: "done", message: strings.eventListEmpty(label) };
  }

  const sameDay = from === to;
  const shown = matches.slice(0, 8).map((event) =>
    sameDay
      ? strings.eventLineSameDay(event.start, event.title)
      : strings.eventLine(
          formatDay(event.date, deps.locale),
          event.start,
          event.title,
        ),
  );

  let message = `${strings.eventListHead(label, matches.length)}\n${shown.map((line) => `• ${line}`).join("\n")}`;

  if (matches.length > shown.length) {
    message += `\n${strings.moreEvents(matches.length - shown.length)}`;
  }

  return { status: "done", message, href: "/calendar" };
}

function executeFinanceList(limit: number, deps: ExecutorDeps): ExecutionReport {
  const strings = STRINGS[deps.locale];
  const sorted = [...deps.finance.transactions].sort((a, b) =>
    a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date),
  );

  if (sorted.length === 0) {
    return { status: "done", message: strings.txListEmpty };
  }

  const shown = sorted.slice(0, limit);
  const lines = shown.map((tx) =>
    strings.txLine(
      formatDay(tx.date, deps.locale),
      tx.title,
      `${tx.type === "income" ? "+" : "−"}${formatMoney(tx.amount, tx.currency ?? "EUR", deps.locale)}`,
    ),
  );

  return {
    status: "done",
    message: `${strings.txListHead(sorted.length)}\n${lines.map((line) => `• ${line}`).join("\n")}`,
    href: "/finance",
  };
}

function executeFinanceSummary(
  plan: Extract<ActionPlan, { type: "finance.summary" }>,
  deps: ExecutorDeps,
): ExecutionReport {
  const strings = STRINGS[deps.locale];
  const inScope = deps.finance.transactions.filter((tx) => {
    if (plan.monthKey !== null && !tx.date.startsWith(plan.monthKey)) {
      return false;
    }

    if (plan.from !== null && tx.date < plan.from) return false;
    if (plan.to !== null && tx.date > plan.to) return false;
    if (plan.category !== null && tx.category !== plan.category) return false;

    return true;
  });

  // Same conventions as the read tools: EUR-only sums, foreign
  // currencies counted separately, never converted.
  let incomeCents = 0;
  let expenseCents = 0;
  let nonEuro = 0;

  for (const tx of inScope) {
    if (!isEuroTransaction(tx)) {
      nonEuro += 1;
      continue;
    }

    if (tx.type === "income") incomeCents += tx.amount;
    else expenseCents += tx.amount;
  }

  let message = strings.summary(
    plan.label,
    formatMoney(expenseCents, "EUR", deps.locale),
    formatMoney(incomeCents, "EUR", deps.locale),
    inScope.length,
  );

  // Reuse existing budgets: monthly total, or the category budget when
  // the summary is category-scoped.
  const budget =
    plan.category !== null
      ? (deps.finance.categoryBudgets[plan.category] ?? 0)
      : plan.monthKey !== null && plan.from === null
        ? deps.finance.monthlyBudgetCents
        : 0;

  if (budget > 0) {
    if (expenseCents > budget) {
      message += strings.budgetExceeded;
    } else {
      message += strings.budgetUsed(
        Math.round((expenseCents / budget) * 100),
        formatMoney(budget, "EUR", deps.locale),
      );
    }
  }

  if (nonEuro > 0) {
    message += strings.nonEuroNote(nonEuro);
  }

  return { status: "done", message, href: "/finance" };
}

// --------------------------------------------------------------- pending

function describePatch(
  previous: CalendarEvent,
  patch: EventPatch,
  locale: AssistantLocale,
): string {
  const next = { ...previous, ...patch };

  return `„${previous.title}“ (${formatDay(previous.date, locale)}, ${previous.start}–${previous.end}) → ${formatDay(next.date, locale)}, ${next.start}–${next.end}`;
}

async function executePendingAction(
  pending: PendingAction,
  deps: ExecutorDeps,
): Promise<ExecutionReport> {
  const strings = STRINGS[deps.locale];

  if (pending.kind === "calendar.delete") {
    const result = await deps.calendar.remove(pending.event.id);

    if (!result.ok) {
      return { status: "error", message: strings.deleteFailed(result.error) };
    }

    return {
      status: "done",
      message: strings.eventDeleted(
        pending.event.title,
        formatDay(pending.event.date, deps.locale),
        pending.event.start,
      ),
      href: "/calendar",
      undoLabel: strings.undo,
      undo: { kind: "restore-event", event: pending.event },
    };
  }

  const result = await deps.calendar.update(pending.id, pending.patch);

  if (!result.ok) {
    return { status: "error", message: strings.saveFailed(result.error) };
  }

  const saved = result.data;

  return {
    status: "done",
    message: strings.eventUpdated(
      saved.title,
      formatDay(saved.date, deps.locale),
      saved.start,
      saved.end,
    ),
    href: "/calendar",
    undoLabel: strings.undo,
    undo: {
      kind: "restore-event-patch",
      id: pending.id,
      previous: pending.previous,
    },
  };
}

// ------------------------------------------------------------------ entry

async function runPlan(
  plan: ActionPlan,
  key: string,
  deps: ExecutorDeps,
): Promise<ExecutionReport> {
  const strings = STRINGS[deps.locale];

  switch (plan.type) {
    case "calendar.create":
      return executeCalendarCreate(key, plan.event, deps);
    case "calendar.list":
      return executeCalendarList(plan.from, plan.to, plan.label, deps);
    case "calendar.update":
    case "calendar.delete": {
      const matches = resolveEventReference(plan.ref, deps.events);

      if (matches.length === 0) {
        return { status: "error", message: strings.noMatch };
      }

      if (matches.length > 1) {
        return {
          status: "pick",
          question: strings.pickQuestion,
          options: matches.slice(0, 4).map((event) => ({
            label: candidateLabel(event, deps.locale),
            eventId: event.id,
          })),
        };
      }

      const target = matches[0];

      if (plan.type === "calendar.delete") {
        const summary = `„${target.title}“ (${formatDay(target.date, deps.locale)}, ${target.start} Uhr)`;

        return {
          status: "confirm",
          summary: strings.confirmDelete(summary),
          pending: { kind: "calendar.delete", event: target, summary },
        };
      }

      const summary = describePatch(target, plan.patch, deps.locale);

      return {
        status: "confirm",
        summary: strings.confirmUpdate(summary),
        pending: {
          kind: "calendar.update",
          id: target.id,
          patch: plan.patch,
          previous: target,
          summary,
        },
      };
    }
    case "finance.create":
      return executeFinanceCreate(key, plan.transaction, deps);
    case "finance.list":
      return executeFinanceList(plan.limit, deps);
    case "finance.summary":
      return executeFinanceSummary(plan, deps);
  }
}

/**
 * Execute one action plan exactly once per idempotency key. The key
 * doubles as the record id for creates, so even a retried request
 * cannot produce duplicates (local upsert-by-id; cloud PK conflict
 * surfaces as a failure, never a silent second row).
 */
export function executePlan(
  plan: ActionPlan,
  key: string,
  deps: ExecutorDeps,
): Promise<ExecutionReport> {
  return runOnce(`plan:${key}`, () => runPlan(plan, key, deps));
}

/**
 * Build the confirmation for a picked candidate (resolves the "which
 * one?" question without a second NLU round-trip).
 */
export function pendingForPick(
  plan: ActionPlan,
  event: CalendarEvent,
  locale: AssistantLocale,
): PendingAction | null {
  if (plan.type === "calendar.delete") {
    const summary = `„${event.title}“ (${formatDay(event.date, locale)}, ${event.start} Uhr)`;

    return { kind: "calendar.delete", event, summary };
  }

  if (plan.type === "calendar.update") {
    return {
      kind: "calendar.update",
      id: event.id,
      patch: plan.patch,
      previous: event,
      summary: describePatch(event, plan.patch, locale),
    };
  }

  return null;
}

/** Localized "really delete/change?" wrapper for a pending summary. */
export function wrapConfirm(
  kind: "update" | "delete",
  summary: string,
  locale: AssistantLocale,
): string {
  const strings = STRINGS[locale];

  return kind === "delete"
    ? strings.confirmDelete(summary)
    : strings.confirmUpdate(summary);
}

/** Run a user-confirmed pending action (double-submit safe). */
export function executePending(
  pending: PendingAction,
  key: string,
  deps: ExecutorDeps,
): Promise<ExecutionReport> {
  return runOnce(`pending:${key}`, () => executePendingAction(pending, deps));
}

/** Reverse a completed write. Best-effort, reports the real outcome. */
export async function executeUndo(
  undo: UndoAction,
  deps: ExecutorDeps,
): Promise<{ ok: boolean; message: string }> {
  const strings = STRINGS[deps.locale];
  let result: RemoteResult<unknown>;

  switch (undo.kind) {
    case "remove-event":
      result = await deps.calendar.remove(undo.id);
      break;
    case "restore-event":
      result = await deps.calendar.create(undo.event);
      break;
    case "restore-event-patch":
      result = await deps.calendar.update(undo.id, undo.previous);
      break;
    case "remove-transaction":
      result = await deps.transactions.deleteTransaction(undo.id);
      break;
    case "restore-transaction":
      result = await deps.transactions.saveTransaction(undo.transaction);
      break;
  }

  if (!result.ok) {
    return { ok: false, message: strings.undoFailed(result.error) };
  }

  return { ok: true, message: strings.undone };
}
