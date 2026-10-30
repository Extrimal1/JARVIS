/**
 * Assistant action contract: the shared client/server boundary.
 *
 * The NLU layer (server) turns free text into an `AssistantPlan`; the
 * executor (client) turns a plan into verified store operations. Plans
 * are plain JSON, strictly validated on both sides — never trusted
 * blindly, whether they came from the heuristic parser or a model.
 *
 * Pure module: no DOM, no Node APIs, no storage access. Timezone-safe
 * by construction: relative dates resolve from the client-provided
 * `todayISO` (the user's local calendar day) using UTC-noon date math,
 * so server and client timezones can never shift a day.
 */

import { isUuid } from "@/src/lib/ids";

export type AssistantLocale = "de" | "ru";

export type NluContext = {
  /** Client-local calendar day (YYYY-MM-DD). Basis for heute/morgen/etc. */
  todayISO: string;
  /** Client-local time (HH:MM). */
  nowTime: string;
  /** IANA label, informational (e.g. "Europe/Berlin"). */
  timezone: string;
  locale: AssistantLocale;
};

/** Raw assistant request body (validated by `isAssistantRequest`). */
export type AssistantRequest = {
  text: string;
  todayISO: string;
  nowTime: string;
  timezone: string;
  locale: AssistantLocale;
  /** Client-generated UUID; doubles as the record id for creates. */
  idempotencyKey: string;
};

export const ASSISTANT_TEXT_MAX = 2000;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;

export function isISODateString(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));

  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export function isTimeString(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const match = TIME_PATTERN.exec(value);
  if (match === null) return false;

  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

export function isMonthKey(value: unknown): value is string {
  if (typeof value !== "string") return false;

  const match = MONTH_KEY_PATTERN.exec(value);
  if (match === null) return false;

  const month = Number(match[2]);

  return month >= 1 && month <= 12;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShortText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max
  );
}

export function isAssistantLocale(value: unknown): value is AssistantLocale {
  return value === "de" || value === "ru";
}

export function isNluContext(value: unknown): value is NluContext {
  if (!isRecord(value)) return false;

  return (
    isISODateString(value.todayISO) &&
    isTimeString(value.nowTime) &&
    typeof value.timezone === "string" &&
    value.timezone.length > 0 &&
    value.timezone.length <= 64 &&
    isAssistantLocale(value.locale)
  );
}

export function isAssistantRequest(value: unknown): value is AssistantRequest {
  if (!isRecord(value)) return false;

  return (
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    value.text.length <= ASSISTANT_TEXT_MAX &&
    isISODateString(value.todayISO) &&
    isTimeString(value.nowTime) &&
    typeof value.timezone === "string" &&
    value.timezone.length > 0 &&
    value.timezone.length <= 64 &&
    isAssistantLocale(value.locale) &&
    isUuid(value.idempotencyKey)
  );
}

// ------------------------------------------------------------ date math

/** Shift a YYYY-MM-DD date by N days (UTC-noon math, DST-immune). */
export function addDaysISO(iso: string, days: number): string {
  const base = new Date(`${iso}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);

  return base.toISOString().slice(0, 10);
}

/** Monday (YYYY-MM-DD) of the week containing `iso`. */
export function mondayOfISO(iso: string): string {
  const base = new Date(`${iso}T12:00:00Z`);
  const mondayOffset = (base.getUTCDay() + 6) % 7;
  base.setUTCDate(base.getUTCDate() - mondayOffset);

  return base.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday for a YYYY-MM-DD date. */
export function weekdayOfISO(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

/** Compare two YYYY-MM-DD dates (-1, 0, 1). */
export function compareISO(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- plans

export type CalendarPlanType = "lecture" | "exam" | "personal";

export type NewEventFields = {
  title: string;
  date: string;
  start: string;
  end: string;
  type: CalendarPlanType;
  description: string;
  location: string;
};

/** Fuzzy reference to an existing event (resolved client-side). */
export type EventRef = {
  titleQuery: string;
  /** Optional YYYY-MM-DD restriction. */
  date?: string;
};

export type EventPatch = {
  title?: string;
  date?: string;
  start?: string;
  end?: string;
  type?: CalendarPlanType;
  description?: string;
  location?: string;
};

export type NewTransactionFields = {
  title: string;
  /** Integer cents, always > 0. */
  amountCents: number;
  type: "income" | "expense";
  category: string;
  date: string;
  /** ISO 4217 code (EUR default). */
  currency: string;
  note: string;
};

export type ClarifyOption = {
  /** Button label shown to the user. */
  label: string;
  /** Follow-up fragment; appended to the original text on re-submit. */
  text: string;
};

/**
 * Validated NLU output. `calendar.update` / `calendar.delete` carry
 * only a fuzzy `ref`: the executor resolves it against the user's own
 * loaded data and asks when the target is ambiguous.
 */
export type AssistantPlan =
  | { type: "calendar.create"; event: NewEventFields }
  | { type: "calendar.list"; from: string; to: string; label: string }
  | { type: "calendar.update"; ref: EventRef; patch: EventPatch }
  | { type: "calendar.delete"; ref: EventRef }
  | { type: "finance.create"; transaction: NewTransactionFields }
  | { type: "finance.list"; limit: number }
  | {
      type: "finance.summary";
      monthKey: string | null;
      from: string | null;
      to: string | null;
      category: string | null;
      label: string;
    }
  | { type: "clarify"; question: string; options: ClarifyOption[] }
  | { type: "unsupported"; message: string };

function isEventType(value: unknown): value is CalendarPlanType {
  return value === "lecture" || value === "exam" || value === "personal";
}

function isNewEventFields(value: unknown): value is NewEventFields {
  if (!isRecord(value)) return false;

  return (
    isShortText(value.title, 200) &&
    isISODateString(value.date) &&
    isTimeString(value.start) &&
    isTimeString(value.end) &&
    (value.start as string) < (value.end as string) &&
    isEventType(value.type) &&
    typeof value.description === "string" &&
    value.description.length <= 2000 &&
    typeof value.location === "string" &&
    value.location.length <= 200
  );
}

function isEventRef(value: unknown): value is EventRef {
  if (!isRecord(value)) return false;

  return (
    isShortText(value.titleQuery, 200) &&
    (value.date === undefined || isISODateString(value.date))
  );
}

function isEventPatch(value: unknown): value is EventPatch {
  if (!isRecord(value)) return false;

  const patch = value as Record<string, unknown>;
  const keys = Object.keys(patch);

  if (keys.length === 0) return false;

  for (const key of keys) {
    const item = patch[key];

    switch (key) {
      case "title":
        if (!isShortText(item, 200)) return false;
        break;
      case "date":
        if (!isISODateString(item)) return false;
        break;
      case "start":
      case "end":
        if (!isTimeString(item)) return false;
        break;
      case "type":
        if (!isEventType(item)) return false;
        break;
      case "description":
        if (typeof item !== "string" || item.length > 2000) return false;
        break;
      case "location":
        if (typeof item !== "string" || item.length > 200) return false;
        break;
      default:
        return false;
    }
  }

  if (
    typeof patch.start === "string" &&
    typeof patch.end === "string" &&
    patch.start >= patch.end
  ) {
    return false;
  }

  return true;
}

function isNewTransactionFields(
  value: unknown,
): value is NewTransactionFields {
  if (!isRecord(value)) return false;

  return (
    isShortText(value.title, 200) &&
    typeof value.amountCents === "number" &&
    Number.isInteger(value.amountCents) &&
    value.amountCents > 0 &&
    Number.isSafeInteger(value.amountCents) &&
    (value.type === "income" || value.type === "expense") &&
    isShortText(value.category, 64) &&
    isISODateString(value.date) &&
    typeof value.currency === "string" &&
    /^[A-Z]{3}$/.test(value.currency) &&
    typeof value.note === "string" &&
    value.note.length <= 2000
  );
}

function isClarifyOption(value: unknown): value is ClarifyOption {
  return (
    isRecord(value) &&
    isShortText(value.label, 64) &&
    isShortText(value.text, 200)
  );
}

/** Deep validation for plans from any NLU source (parser or model). */
export function isAssistantPlan(value: unknown): value is AssistantPlan {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  switch (value.type) {
    case "calendar.create":
      return isNewEventFields(value.event);
    case "calendar.list":
      return (
        isISODateString(value.from) &&
        isISODateString(value.to) &&
        (value.from as string) <= (value.to as string) &&
        isShortText(value.label, 120)
      );
    case "calendar.update":
      return isEventRef(value.ref) && isEventPatch(value.patch);
    case "calendar.delete":
      return isEventRef(value.ref);
    case "finance.create":
      return isNewTransactionFields(value.transaction);
    case "finance.list":
      return (
        typeof value.limit === "number" &&
        Number.isInteger(value.limit) &&
        value.limit >= 1 &&
        value.limit <= 25
      );
    case "finance.summary":
      return (
        (value.monthKey === null || isMonthKey(value.monthKey)) &&
        (value.from === null || isISODateString(value.from)) &&
        (value.to === null || isISODateString(value.to)) &&
        (value.from === null ||
          value.to === null ||
          (value.from as string) <= (value.to as string)) &&
        (value.category === null || isShortText(value.category, 64)) &&
        isShortText(value.label, 160)
      );
    case "clarify":
      return (
        isShortText(value.question, 500) &&
        Array.isArray(value.options) &&
        value.options.length <= 4 &&
        value.options.every(isClarifyOption)
      );
    case "unsupported":
      return isShortText(value.message, 800);
    default:
      return false;
  }
}

// ---------------------------------------------------------- descriptions

const INTENT_LABEL: Record<AssistantLocale, Record<string, string>> = {
  de: {
    "calendar.create": "Termin erstellen",
    "calendar.list": "Termine anzeigen",
    "calendar.update": "Termin ändern",
    "calendar.delete": "Termin löschen",
    "finance.create": "Buchung speichern",
    "finance.list": "Buchungen anzeigen",
    "finance.summary": "Ausgaben zusammenfassen",
  },
  ru: {
    "calendar.create": "Создать встречу",
    "calendar.list": "Показать встречи",
    "calendar.update": "Изменить встречу",
    "calendar.delete": "Удалить встречу",
    "finance.create": "Сохранить операцию",
    "finance.list": "Показать операции",
    "finance.summary": "Подвести итоги расходов",
  },
};

/**
 * One-line "what I understood" summary for the UI, in the command's
 * language. Rendered from the validated plan — never from raw text.
 */
export function describePlan(
  plan: AssistantPlan,
  locale: AssistantLocale,
): string {
  if (plan.type === "clarify") return plan.question;
  if (plan.type === "unsupported") return plan.message;

  const label = INTENT_LABEL[locale][plan.type] ?? plan.type;

  switch (plan.type) {
    case "calendar.create":
      return `${label}: „${plan.event.title}“ · ${plan.event.date} · ${plan.event.start}–${plan.event.end}`;
    case "calendar.list":
      return `${label}: ${plan.label}`;
    case "calendar.update":
      return `${label}: „${plan.ref.titleQuery}“`;
    case "calendar.delete":
      return `${label}: „${plan.ref.titleQuery}“`;
    case "finance.create": {
      const sign = plan.transaction.type === "income" ? "+" : "−";
      return `${label}: ${sign}${(plan.transaction.amountCents / 100).toFixed(2)} ${plan.transaction.currency} · ${plan.transaction.title}`;
    }
    case "finance.list":
      return label;
    case "finance.summary":
      return `${label}: ${plan.label}`;
  }
}

/**
 * Tolerate fenced JSON ("```json ... ```") around an otherwise valid
 * model payload. Shared by every model-output parser (NLU + agent).
 */
export function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);

  return fenced?.[1] ?? trimmed;
}
