import {
  isEuroTransaction,
  monthKey,
  shiftMonth,
  type FinanceData,
  type Transaction,
  type YearMonth,
} from "@/src/lib/finance";
import { normalizeKey } from "./importStore";

/**
 * Monthly analysis over confirmed transactions only (unconfirmed review
 * rows are never passed in here). Foreign-currency transactions are
 * excluded from EUR sums and reported separately instead of converted
 * with an invented exchange rate.
 */

export type RecurringGroup = {
  label: string;
  category: string;
  type: Transaction["type"];
  amountCents: number;
  occurrences: number;
  months: string[];
};

export type Anomaly = {
  kind: "large" | "new-category" | "spike" | "non-euro";
  text: string;
  transactionId?: string;
};

export type MonthComparison = {
  incomePct: number | null;
  expensePct: number | null;
  prevIncome: number;
  prevExpense: number;
  hasPrev: boolean;
};

export type MonthlyAnalysis = {
  month: string;
  income: number;
  expense: number;
  net: number;
  txCount: number;
  byCategory: { category: string; spent: number; sharePct: number }[];
  largest: Transaction[];
  recurring: RecurringGroup[];
  comparison: MonthComparison;
  anomalies: Anomaly[];
  nonEuroCount: number;
};

const PERCENT_FORMAT = new Intl.NumberFormat("de-DE", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "exceptZero",
});

export function formatPercent(value: number | null): string {
  if (value === null) return "–";

  return PERCENT_FORMAT.format(value);
}

function pctChange(current: number, baseline: number): number | null {
  if (baseline <= 0) return null;

  return (current - baseline) / baseline;
}

function transactionsInMonth(
  transactions: Transaction[],
  key: string,
): Transaction[] {
  return transactions.filter((transaction) =>
    transaction.date.startsWith(key),
  );
}

function detectRecurring(
  transactions: Transaction[],
  end: YearMonth,
): RecurringGroup[] {
  const window: string[] = [];

  for (let delta = -5; delta <= 0; delta += 1) {
    window.push(monthKey(shiftMonth(end, delta)));
  }

  const groups = new Map<
    string,
    { sample: Transaction; months: Set<string>; occurrences: number }
  >();

  for (const transaction of transactions) {
    if (!isEuroTransaction(transaction)) continue;

    const key = transaction.date.slice(0, 7);
    if (!window.includes(key)) continue;

    const groupKey = `${normalizeKey(transaction.title)}|${transaction.amount}|${transaction.type}`;
    const group = groups.get(groupKey) ?? {
      sample: transaction,
      months: new Set<string>(),
      occurrences: 0,
    };

    group.months.add(key);
    group.occurrences += 1;
    groups.set(groupKey, group);
  }

  const recurring: RecurringGroup[] = [];

  for (const group of groups.values()) {
    if (group.months.size < 2 || group.occurrences < 3) continue;

    recurring.push({
      label: group.sample.title,
      category: group.sample.category,
      type: group.sample.type,
      amountCents: group.sample.amount,
      occurrences: group.occurrences,
      months: [...group.months].sort(),
    });
  }

  recurring.sort((a, b) => b.occurrences - a.occurrences);

  return recurring.slice(0, 8);
}

function detectAnomalies(
  monthTx: Transaction[],
  all: Transaction[],
  month: YearMonth,
  nonEuroCount: number,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const euroTx = monthTx.filter(isEuroTransaction);

  // Category baselines from the three previous months.
  const previousKeys = [1, 2, 3].map((delta) =>
    monthKey(shiftMonth(month, -delta)),
  );
  const baseline = new Map<string, { total: number; count: number }>();

  for (const transaction of all) {
    if (!isEuroTransaction(transaction)) continue;
    if (transaction.type !== "expense") continue;

    const key = transaction.date.slice(0, 7);
    if (!previousKeys.includes(key)) continue;

    const entry = baseline.get(transaction.category) ?? { total: 0, count: 0 };
    entry.total += transaction.amount;
    entry.count += 1;
    baseline.set(transaction.category, entry);
  }

  const seenCategories = new Set(baseline.keys());
  const flaggedCategories = new Set<string>();

  for (const transaction of euroTx) {
    if (transaction.type !== "expense") continue;

    const stats = baseline.get(transaction.category);

    if (stats === undefined) {
      if (!flaggedCategories.has(transaction.category)) {
        flaggedCategories.add(transaction.category);
        anomalies.push({
          kind: "new-category",
          text: `Neue Ausgabenkategorie „${transaction.category}“ – kam in den letzten 3 Monaten nicht vor.`,
        });
      }

      continue;
    }

    if (
      stats.count >= 3 &&
      stats.total > 0 &&
      transaction.amount >= (stats.total / stats.count) * 3 &&
      transaction.amount >= 2000
    ) {
      anomalies.push({
        kind: "large",
        text: `„${transaction.title}“ ist ungewöhnlich hoch für ${transaction.category} (mind. 3× über dem 3-Monats-Schnitt).`,
        transactionId: transaction.id,
      });
    }
  }

  void seenCategories;

  // Monthly spike: this month's expenses vs. previous 3-month average.
  const thisExpense = euroTx
    .filter((transaction) => transaction.type === "expense")
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const prevTotals = previousKeys.map((key) =>
    transactionsInMonth(all, key)
      .filter(isEuroTransaction)
      .filter((transaction) => transaction.type === "expense")
      .reduce((sum, transaction) => sum + transaction.amount, 0),
  );
  const prevAvg =
    prevTotals.reduce((sum, value) => sum + value, 0) /
    Math.max(1, prevTotals.filter((value) => value > 0).length);

  if (prevAvg > 0 && thisExpense >= prevAvg * 2 && thisExpense >= 5000) {
    anomalies.push({
      kind: "spike",
      text: "Die Ausgaben dieses Monats liegen mindestens doppelt so hoch wie im Schnitt der letzten 3 Monate.",
    });
  }

  if (nonEuroCount > 0) {
    anomalies.push({
      kind: "non-euro",
      text: `${nonEuroCount} ${nonEuroCount === 1 ? "Buchung" : "Buchungen"} in Fremdwährung ${nonEuroCount === 1 ? "ist" : "sind"} in den Summen nicht enthalten (kein Wechselkurs verfügbar).`,
    });
  }

  return anomalies;
}

export function analyzeMonth(
  data: FinanceData,
  month: YearMonth,
): MonthlyAnalysis {
  const key = monthKey(month);
  const monthTx = transactionsInMonth(data.transactions, key);
  const euroTx = monthTx.filter(isEuroTransaction);

  let income = 0;
  let expense = 0;

  for (const transaction of euroTx) {
    if (transaction.type === "income") {
      income += transaction.amount;
    } else {
      expense += transaction.amount;
    }
  }

  const spentByCategory = new Map<string, number>();

  for (const transaction of euroTx) {
    if (transaction.type !== "expense") continue;

    spentByCategory.set(
      transaction.category,
      (spentByCategory.get(transaction.category) ?? 0) + transaction.amount,
    );
  }

  const byCategory = [...spentByCategory.entries()]
    .map(([category, spent]) => ({
      category,
      spent,
      sharePct: expense > 0 ? spent / expense : 0,
    }))
    .sort((a, b) => b.spent - a.spent);

  const largest = [...euroTx]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  const prevKey = monthKey(shiftMonth(month, -1));
  const prevTx = transactionsInMonth(data.transactions, prevKey).filter(
    isEuroTransaction,
  );
  let prevIncome = 0;
  let prevExpense = 0;

  for (const transaction of prevTx) {
    if (transaction.type === "income") {
      prevIncome += transaction.amount;
    } else {
      prevExpense += transaction.amount;
    }
  }

  const hasPrev = prevTx.length > 0;
  const nonEuroCount = monthTx.length - euroTx.length;

  return {
    month: key,
    income,
    expense,
    net: income - expense,
    txCount: monthTx.length,
    byCategory,
    largest,
    recurring: detectRecurring(data.transactions, month),
    comparison: {
      incomePct: hasPrev ? pctChange(income, prevIncome) : null,
      expensePct: hasPrev ? pctChange(expense, prevExpense) : null,
      prevIncome,
      prevExpense,
      hasPrev,
    },
    anomalies: detectAnomalies(monthTx, data.transactions, month, nonEuroCount),
    nonEuroCount,
  };
}

/** Largest expense transactions across all confirmed history. */
export function largestAllTime(
  transactions: Transaction[],
  limit = 5,
): Transaction[] {
  return [...transactions]
    .filter(isEuroTransaction)
    .filter((transaction) => transaction.type === "expense")
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}
