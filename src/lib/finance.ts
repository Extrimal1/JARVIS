import { parseISODateLocal } from "@/src/lib/calendar";

export type TransactionType = "income" | "expense";

export type Transaction = {
  id: string;
  title: string;
  /** Amount in integer cents (always >= 0; direction comes from `type`). */
  amount: number;
  type: TransactionType;
  category: string;
  /** Local date as YYYY-MM-DD. */
  date: string;
  note?: string;
  /** ISO currency code; absent means EUR (all pre-import records). */
  currency?: string;
  /** Import batch id for PDF-imported transactions. */
  sourceDocumentId?: string;
  /** Absent means manually created. */
  importStatus?: "manual" | "imported";
  /** Original parsed description when the user edited the title. */
  originalDescription?: string;
};

export type SavingsGoal = {
  id: string;
  title: string;
  targetCents: number;
  savedCents: number;
};

export type FinanceData = {
  transactions: Transaction[];
  /** Total monthly expense budget in cents (0 = none). */
  monthlyBudgetCents: number;
  /** Per-category monthly expense budgets in cents. */
  categoryBudgets: Record<string, number>;
  goals: SavingsGoal[];
};

export const FINANCE_STORAGE_KEY = "jarvis-finance";

/** Shared empty initial value (never mutated; the storage hook replaces it). */
export const EMPTY_FINANCE: FinanceData = {
  transactions: [],
  monthlyBudgetCents: 0,
  categoryBudgets: {},
  goals: [],
};

export const INCOME_CATEGORIES = [
  "Gehalt",
  "Stipendium",
  "Nebenjob",
  "Erstattung",
  "Sonstiges",
] as const;

export const EXPENSE_CATEGORIES = [
  "Lebensmittel",
  "Miete",
  "Transport",
  "Freizeit",
  "Studium",
  "Gesundheit",
  "Abos",
  "Umbuchung",
  "Sonstiges",
] as const;

const EURO_FORMAT = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

const EURO_SIGNED_FORMAT = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  signDisplay: "exceptZero",
});

export function formatCents(cents: number): string {
  return EURO_FORMAT.format(cents / 100);
}

export function formatSignedCents(cents: number): string {
  return EURO_SIGNED_FORMAT.format(cents / 100);
}

/**
 * Parses German decimal input ("12,34" or "12.34") into integer cents.
 * Returns null for anything that is not a plain non-negative amount
 * with at most two decimals (no thousands separators, no negatives).
 */
function parseEuroInput(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;

  const cents = Math.round(Number(normalized) * 100);

  if (!Number.isSafeInteger(cents) || cents < 0) return null;

  return cents;
}

/** Parses a transaction/budget amount (must be greater than zero). */
export function parseEuroToCents(value: string): number | null {
  const cents = parseEuroInput(value);
  return cents !== null && cents > 0 ? cents : null;
}

/** Parses an amount where zero is valid (e.g. already-saved sums). */
export function parseEuroToCentsAllowingZero(value: string): number | null {
  return parseEuroInput(value);
}

/** Formats cents for the Euro text input ("12,34"). */
export function centsToEuroInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/** Calendar month; `month` is 0-based (0 = January). */
export type YearMonth = { year: number; month: number };

export function monthKey({ year, month }: YearMonth): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

export function shiftMonth(current: YearMonth, delta: number): YearMonth {
  const date = new Date(current.year, current.month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat("de-DE", {
  month: "long",
  year: "numeric",
});

const MONTH_SHORT_FORMAT = new Intl.DateTimeFormat("de-DE", {
  month: "short",
});

export function monthLabel(current: YearMonth): string {
  return MONTH_LABEL_FORMAT.format(
    new Date(current.year, current.month, 1),
  );
}

export function monthShortLabel(current: YearMonth): string {
  return MONTH_SHORT_FORMAT.format(
    new Date(current.year, current.month, 1),
  );
}

/** Six consecutive months ending with `end` (oldest first). */
export function lastSixMonths(end: YearMonth): YearMonth[] {
  return Array.from({ length: 6 }, (_, index) => shiftMonth(end, index - 5));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0
  );
}

/**
 * True for EUR transactions. Records without a currency field (every
 * manually created and every pre-import transaction) count as EUR.
 */
export function isEuroTransaction(transaction: Transaction): boolean {
  return (
    transaction.currency === undefined || transaction.currency === "EUR"
  );
}

export function isTransaction(value: unknown): value is Transaction {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isNonNegativeInt(value.amount) &&
    (value.type === "income" || value.type === "expense") &&
    typeof value.category === "string" &&
    typeof value.date === "string" &&
    parseISODateLocal(value.date) !== null &&
    (value.note === undefined || typeof value.note === "string") &&
    (value.currency === undefined || typeof value.currency === "string") &&
    (value.sourceDocumentId === undefined ||
      typeof value.sourceDocumentId === "string") &&
    (value.importStatus === undefined ||
      value.importStatus === "manual" ||
      value.importStatus === "imported") &&
    (value.originalDescription === undefined ||
      typeof value.originalDescription === "string")
  );
}

export function isSavingsGoal(value: unknown): value is SavingsGoal {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isNonNegativeInt(value.targetCents) &&
    isNonNegativeInt(value.savedCents)
  );
}

export function isFinanceData(value: unknown): value is FinanceData {
  if (!isRecord(value)) return false;

  return (
    Array.isArray(value.transactions) &&
    value.transactions.every(isTransaction) &&
    isNonNegativeInt(value.monthlyBudgetCents) &&
    isRecord(value.categoryBudgets) &&
    Object.values(value.categoryBudgets).every(isNonNegativeInt) &&
    Array.isArray(value.goals) &&
    value.goals.every(isSavingsGoal)
  );
}
