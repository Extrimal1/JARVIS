/**
 * Finance math, validation, and import checks with hand-computed
 * expectations. Sums cover confirmed Euro transactions only;
 * foreign currencies are counted, never converted.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RECURRING_LABELS,
  centsToEuroInput,
  isTransaction,
  lastSixMonths,
  monthKey,
  parseEuroToCents,
  parseEuroToCentsAllowingZero,
  shiftMonth,
  type FinanceData,
  type Transaction,
} from "@/src/lib/finance";
import { getFinanceMonthSummary } from "@/src/lib/assistant/tools";
import {
  alreadyImported,
  detectDuplicates,
  isImportBatchMeta,
  normalizeKey,
  reviewRowsToTransactions,
  type ImportBatchMeta,
  type ReviewRow,
} from "@/src/lib/finance/importStore";

function tx(patch: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx1",
    title: "Supermarkt",
    amount: 1250,
    type: "expense",
    category: "Lebensmittel",
    date: "2026-11-05",
    ...patch,
  };
}

function finance(transactions: Transaction[]): FinanceData {
  return {
    transactions,
    monthlyBudgetCents: 0,
    categoryBudgets: {},
    goals: [],
  };
}

describe("euro parsing", () => {
  it("parses German and plain decimals into cents", () => {
    assert.equal(parseEuroToCents("12,34"), 1234);
    assert.equal(parseEuroToCents("12.34"), 1234);
    assert.equal(parseEuroToCents(" 12,5 "), 1250);
    assert.equal(parseEuroToCents("0,01"), 1);
  });

  it("rejects zero, negatives, and malformed input", () => {
    assert.equal(parseEuroToCents("0"), null);
    assert.equal(parseEuroToCents("0,00"), null);
    assert.equal(parseEuroToCents("-5"), null);
    assert.equal(parseEuroToCents("12,345"), null);
    assert.equal(parseEuroToCents("1.234"), null);
    assert.equal(parseEuroToCents("abc"), null);
    assert.equal(parseEuroToCents(""), null);
    assert.equal(parseEuroToCentsAllowingZero("0"), 0);
    assert.equal(parseEuroToCentsAllowingZero("-1"), null);
  });

  it("round-trips through the form format", () => {
    assert.equal(centsToEuroInput(1234), "12,34");
    assert.equal(parseEuroToCents(centsToEuroInput(999)), 999);
  });
});

describe("month helpers", () => {
  it("rolls over year boundaries", () => {
    assert.equal(monthKey({ year: 2026, month: 0 }), "2026-01");
    assert.deepEqual(shiftMonth({ year: 2026, month: 11 }, 1), {
      year: 2027,
      month: 0,
    });
    assert.deepEqual(shiftMonth({ year: 2026, month: 0 }, -1), {
      year: 2025,
      month: 11,
    });
  });

  it("lists six months ending with the given one", () => {
    const months = lastSixMonths({ year: 2026, month: 10 });

    assert.equal(months.length, 6);
    assert.equal(monthKey(months[0]!), "2026-06");
    assert.equal(monthKey(months[5]!), "2026-11");
  });
});

describe("transaction validation", () => {
  it("accepts complete records and rejects bad ones", () => {
    assert.equal(isTransaction(tx()), true);
    assert.equal(
      isTransaction(tx({ currency: "USD", recurring: "monthly" })),
      true,
    );
    assert.equal(isTransaction(tx({ amount: -5 })), false);
    assert.equal(isTransaction(tx({ amount: 12.5 })), false);
    assert.equal(isTransaction(tx({ date: "05.11.2026" })), false);
    assert.equal(
      isTransaction({ ...tx(), type: "transfer" } as unknown),
      false,
    );
    assert.equal(
      isTransaction(tx({ recurring: "weekly" as "monthly" })),
      false,
    );
  });

  it("labels every recurring cadence", () => {
    assert.deepEqual(Object.keys(RECURRING_LABELS).sort(), [
      "monthly",
      "none",
      "quarterly",
      "yearly",
    ]);
  });
});

describe("monthly summary math", () => {
  const data = finance([
    tx({ id: "e1", amount: 1000, type: "expense", date: "2026-11-02" }),
    tx({ id: "e2", amount: 250, type: "expense", date: "2026-11-20" }),
    tx({
      id: "i1",
      amount: 3000,
      type: "income",
      category: "Gehalt",
      date: "2026-11-01",
    }),
    tx({ id: "old", amount: 9999, type: "expense", date: "2026-10-31" }),
    tx({
      id: "usd",
      amount: 5000,
      type: "expense",
      currency: "USD",
      date: "2026-11-03",
    }),
  ]);

  it("sums the month in Euro only and counts the rest", () => {
    const result = getFinanceMonthSummary({
      finance: data,
      monthKey: "2026-11",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok ? result.data : null,
      {
        monthKey: "2026-11",
        incomeCents: 3000,
        expenseCents: 1250,
        netCents: 1750,
        txCount: 4,
        nonEuroCount: 1,
        budgetCents: 0,
        budgetUsedPct: null,
        budgetExceeded: false,
      },
    );
  });

  it("reports budget usage without inventing a budget", () => {
    const budgeted: FinanceData = {
      ...data,
      monthlyBudgetCents: 1000,
    };
    const result = getFinanceMonthSummary({
      finance: budgeted,
      monthKey: "2026-11",
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data.budgetUsedPct, 1.25);
    assert.equal(result.ok && result.data.budgetExceeded, true);
  });

  it("rejects malformed months", () => {
    assert.equal(
      getFinanceMonthSummary({ finance: data, monthKey: "Nov 26" }).ok,
      false,
    );
  });
});

describe("import duplicate detection", () => {
  const existing = [
    tx({ id: "old", title: "Lidl", amount: 2450, date: "2026-11-02" }),
    tx({
      id: "renamed",
      title: "Bäckerei (neu)",
      originalDescription: "BAECKEREI K-STR",
      amount: 320,
      date: "2026-11-03",
    }),
  ];

  it("classifies exact, fuzzy, and new rows", () => {
    const decisions = detectDuplicates(
      [
        {
          date: "2026-11-02",
          amountCents: 2450,
          type: "expense",
          description: "LIDL",
        },
        {
          date: "2026-11-02",
          amountCents: 2450,
          type: "expense",
          description: "Anderswo",
        },
        {
          date: "2026-11-04",
          amountCents: 100,
          type: "expense",
          description: "Neu",
        },
      ],
      existing,
    );

    assert.deepEqual(decisions, ["duplicate", "review", "new"]);
  });

  it("matches renamed transactions via their original text", () => {
    const decisions = detectDuplicates(
      [
        {
          date: "2026-11-03",
          amountCents: 320,
          type: "expense",
          description: "Baeckerei K-Str",
        },
      ],
      existing,
    );

    assert.deepEqual(decisions, ["duplicate"]);
  });

  it("normalizes descriptions deterministically", () => {
    assert.equal(normalizeKey("LIDL SAGT DANKE!"), normalizeKey("lidl sagt danke"));
    assert.ok(normalizeKey("x".repeat(200)).length <= 80);
  });
});

describe("import confirmation", () => {
  function row(patch: Partial<ReviewRow> = {}): ReviewRow {
    return {
      date: "2026-11-02",
      amountCents: 2450,
      type: "expense",
      description: "Lidl",
      tempId: "r1",
      include: true,
      amountInput: "24,50",
      currency: "EUR",
      category: "Lebensmittel",
      needsReview: false,
      reviewReasons: [],
      duplicate: "new",
      ...patch,
    };
  }

  it("imports valid rows and skips invalid ones without guessing", () => {
    const { transactions, skipped } = reviewRowsToTransactions(
      [
        row(),
        row({ tempId: "r2", amountInput: "viel" }),
        row({ tempId: "r3", date: "gestern" }),
        row({ tempId: "r4", include: false }),
      ],
      "batch-1",
    );

    assert.equal(transactions.length, 1);
    assert.equal(skipped, 2);
    assert.equal(transactions[0]?.amount, 2450);
    assert.equal(transactions[0]?.sourceDocumentId, "batch-1");
    assert.equal(transactions[0]?.importStatus, "imported");
  });

  it("defaults empty categories and currencies honestly", () => {
    const { transactions } = reviewRowsToTransactions(
      [row({ category: "", currency: "" })],
      "batch-1",
    );

    assert.equal(transactions[0]?.category, "Sonstiges");
    assert.equal(transactions[0]?.currency, "EUR");
  });
});

describe("import batch matching", () => {
  const batch: ImportBatchMeta = {
    id: "b1",
    fileName: "konto.pdf",
    fileSize: 1024,
    importedAt: "2026-11-03T10:00:00.000Z",
    statementMonth: "2026-11",
    count: 12,
    sha256: "a".repeat(64),
  };

  it("validates batch metadata with and without hashes", () => {
    assert.equal(isImportBatchMeta(batch), true);
    assert.equal(isImportBatchMeta({ ...batch, sha256: undefined }), true);
    assert.equal(isImportBatchMeta({ ...batch, count: "12" }), false);
  });

  it("matches identical content even after a rename", () => {
    const found = alreadyImported([batch], "neu.pdf", 2048, "a".repeat(64));

    assert.equal(found?.id, "b1");
  });

  it("distinguishes same-size files with different hashes", () => {
    assert.equal(
      alreadyImported([batch], "konto.pdf", 1024, "b".repeat(64)),
      null,
    );
  });

  it("falls back to name plus size for legacy batches", () => {
    const legacy: ImportBatchMeta = { ...batch, sha256: undefined };
    delete legacy.sha256;

    assert.equal(
      alreadyImported([legacy], "konto.pdf", 1024, "b".repeat(64))?.id,
      "b1",
    );
    assert.equal(
      alreadyImported([legacy], "konto.pdf", 1024)?.id,
      "b1",
    );
    assert.equal(alreadyImported([legacy], "anders.pdf", 1024), null);
  });
});
