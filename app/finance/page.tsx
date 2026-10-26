"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Plus,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import Sidebar from "@/src/components/Sidebar";
import {
  FinanceChart,
  type MonthPoint,
} from "@/src/components/finance/FinanceChart";
import { BudgetPanel } from "@/src/components/finance/BudgetPanel";
import { GoalsPanel } from "@/src/components/finance/GoalsPanel";
import { TransactionForm } from "@/src/components/finance/TransactionForm";
import { ImportPanel } from "@/src/components/finance/ImportPanel";
import { AnalysisPanel } from "@/src/components/finance/AnalysisPanel";
import { useLocalStorage } from "@/src/hooks/useLocalStorage";
import { useToday } from "@/src/hooks/useToday";
import {
  EMPTY_FINANCE,
  FINANCE_STORAGE_KEY,
  formatCents,
  formatSignedCents,
  isEuroTransaction,
  isFinanceData,
  lastSixMonths,
  monthKey,
  monthLabel,
  monthShortLabel,
  shiftMonth,
  type SavingsGoal,
  type Transaction,
  type TransactionType,
  type YearMonth,
} from "@/src/lib/finance";
import {
  IMPORT_BATCHES_KEY,
  isImportBatchMetaList,
  type ImportBatchMeta,
} from "@/src/lib/finance/importStore";

const DAY_FORMAT = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeZone: "UTC",
});

function formatDay(dateISO: string): string {
  return DAY_FORMAT.format(new Date(`${dateISO}T12:00:00Z`));
}

type TypeFilter = "all" | TransactionType;

const TYPE_FILTERS: { key: TypeFilter; label: string; active: string }[] = [
  {
    key: "all",
    label: "Alle",
    active: "border-white/25 bg-white/10 text-white",
  },
  {
    key: "income",
    label: "Einnahmen",
    active: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  },
  {
    key: "expense",
    label: "Ausgaben",
    active: "border-rose-400/40 bg-rose-400/10 text-rose-200",
  },
];

type Draft =
  | { mode: "new"; defaultType: TransactionType }
  | { mode: "edit"; transaction: Transaction };

export default function FinancePage() {
  const [data, setData] = useLocalStorage(
    FINANCE_STORAGE_KEY,
    EMPTY_FINANCE,
    isFinanceData,
  );
  const [batches, setBatches] = useLocalStorage<ImportBatchMeta[]>(
    IMPORT_BATCHES_KEY,
    [],
    isImportBatchMetaList,
  );
  const [month, setMonth] = useState<YearMonth | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [draft, setDraft] = useState<Draft | null>(null);
  const today = useToday();

  useEffect(() => {
    const current = new Date();
    // Mount-gated: prerendered HTML must not depend on the current date.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMonth({ year: current.getFullYear(), month: current.getMonth() });
  }, []);

  const key = month === null ? "" : monthKey(month);

  const monthTransactions = useMemo(
    () =>
      key === ""
        ? []
        : data.transactions.filter((transaction) =>
            transaction.date.startsWith(key),
          ),
    [data.transactions, key],
  );

  /** Euro transactions only: sums never mix in foreign currencies. */
  const euroMonthTransactions = useMemo(
    () => monthTransactions.filter(isEuroTransaction),
    [monthTransactions],
  );

  const hasNonEuro = useMemo(
    () => monthTransactions.some((transaction) => !isEuroTransaction(transaction)),
    [monthTransactions],
  );

  const totals = useMemo(() => {
    let income = 0;
    let expense = 0;

    for (const transaction of euroMonthTransactions) {
      if (transaction.type === "income") {
        income += transaction.amount;
      } else {
        expense += transaction.amount;
      }
    }

    return { income, expense, net: income - expense };
  }, [euroMonthTransactions]);

  const categoryTotals = useMemo(() => {
    const spentByCategory = new Map<string, number>();

    for (const transaction of euroMonthTransactions) {
      if (transaction.type !== "expense") continue;

      spentByCategory.set(
        transaction.category,
        (spentByCategory.get(transaction.category) ?? 0) + transaction.amount,
      );
    }

    return [...spentByCategory.entries()]
      .map(([category, spent]) => ({ category, spent }))
      .sort((a, b) => a.category.localeCompare(b.category, "de"));
  }, [euroMonthTransactions]);

  const availableCategories = useMemo(() => {
    const categories = new Set(
      monthTransactions.map((transaction) => transaction.category),
    );

    return [...categories].sort((a, b) => a.localeCompare(b, "de"));
  }, [monthTransactions]);

  const visibleTransactions = useMemo(
    () =>
      monthTransactions
        .filter(
          (transaction) =>
            (typeFilter === "all" || transaction.type === typeFilter) &&
            (categoryFilter === "all" ||
              transaction.category === categoryFilter),
        )
        .sort((a, b) => b.date.localeCompare(a.date)),
    [monthTransactions, typeFilter, categoryFilter],
  );

  const series: MonthPoint[] = useMemo(() => {
    if (month === null) return [];

    return lastSixMonths(month).map((past) => {
      const pastKey = monthKey(past);
      let income = 0;
      let expense = 0;

      for (const transaction of data.transactions) {
        if (!transaction.date.startsWith(pastKey)) continue;
        if (!isEuroTransaction(transaction)) continue;

        if (transaction.type === "income") {
          income += transaction.amount;
        } else {
          expense += transaction.amount;
        }
      }

      return {
        key: pastKey,
        label: monthShortLabel(past),
        income,
        expense,
      };
    });
  }, [data.transactions, month]);

  const defaultDate =
    month === null
      ? ""
      : today !== null && today.startsWith(key)
        ? today
        : `${key}-01`;

  function goToCurrentMonth() {
    const current = new Date();
    setMonth({ year: current.getFullYear(), month: current.getMonth() });
  }

  function shiftDisplayMonth(delta: number) {
    setMonth((current) =>
      current === null ? current : shiftMonth(current, delta),
    );
  }

  function saveTransaction(transaction: Transaction) {
    if (draft?.mode === "new") {
      setData((current) => ({
        ...current,
        transactions: [...current.transactions, transaction],
      }));
    } else {
      setData((current) => ({
        ...current,
        transactions: current.transactions.map((item) =>
          item.id === transaction.id ? transaction : item,
        ),
      }));
    }

    setDraft(null);
  }

  function deleteTransaction(id: string) {
    setData((current) => ({
      ...current,
      transactions: current.transactions.filter((item) => item.id !== id),
    }));
    setDraft(null);
  }

  function importBatch(rows: Transaction[], batch: ImportBatchMeta) {
    setData((current) => ({
      ...current,
      transactions: [...current.transactions, ...rows],
    }));
    setBatches((current) => [...current, batch]);
  }

  function deleteBatch(batchId: string) {
    setData((current) => ({
      ...current,
      transactions: current.transactions.filter(
        (item) => item.sourceDocumentId !== batchId,
      ),
    }));
    setBatches((current) =>
      current.filter((batch) => batch.id !== batchId),
    );
  }

  function saveTotalBudget(cents: number) {
    setData((current) => ({ ...current, monthlyBudgetCents: cents }));
  }

  function saveCategoryBudget(category: string, cents: number) {
    setData((current) => ({
      ...current,
      categoryBudgets: { ...current.categoryBudgets, [category]: cents },
    }));
  }

  function deleteCategoryBudget(category: string) {
    setData((current) => {
      const categoryBudgets = { ...current.categoryBudgets };
      delete categoryBudgets[category];
      return { ...current, categoryBudgets };
    });
  }

  function addGoal(goal: SavingsGoal) {
    setData((current) => ({ ...current, goals: [...current.goals, goal] }));
  }

  function updateGoal(goal: SavingsGoal) {
    setData((current) => ({
      ...current,
      goals: current.goals.map((item) =>
        item.id === goal.id ? goal : item,
      ),
    }));
  }

  function deleteGoal(id: string) {
    setData((current) => ({
      ...current,
      goals: current.goals.filter((item) => item.id !== id),
    }));
  }

  return (
    <main className="min-h-screen bg-[#080b12] text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col md:flex-row">
        <Sidebar />

        <section className="min-w-0 flex-1 px-5 py-7 sm:px-8 lg:px-12">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-slate-500 transition hover:text-cyan-200"
          >
            <ArrowLeft size={16} />
            Zur Übersicht
          </Link>

          <header className="mt-7">
            <p className="text-sm tracking-wide text-cyan-300">FINANZEN</p>

            <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">
              Finanzen
            </h1>

            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              Behalte Einnahmen, Ausgaben, Budgets und Sparziele im Blick –
              alle Zahlen stammen aus deinen eigenen Buchungen.
            </p>
          </header>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-2xl border border-white/[0.08] bg-[#0d111b] p-1">
              <button
                onClick={() => shiftDisplayMonth(-1)}
                aria-label="Vorheriger Monat"
                className="rounded-xl p-2.5 text-slate-300 transition hover:bg-white/5 hover:text-white"
              >
                <ChevronLeft size={18} />
              </button>

              <button
                onClick={goToCurrentMonth}
                className="rounded-xl px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white"
              >
                Dieser Monat
              </button>

              <button
                onClick={() => shiftDisplayMonth(1)}
                aria-label="Nächster Monat"
                className="rounded-xl p-2.5 text-slate-300 transition hover:bg-white/5 hover:text-white"
              >
                <ChevronRight size={18} />
              </button>
            </div>

            <p aria-live="polite" className="text-sm font-medium text-slate-200">
              {month === null ? "…" : monthLabel(month)}
            </p>

            <div
              role="group"
              aria-label="Buchungen filtern"
              className="flex flex-wrap items-center gap-2"
            >
              {TYPE_FILTERS.map(({ key: filterKey, label, active }) => {
                const activeFilter = typeFilter === filterKey;

                return (
                  <button
                    key={filterKey}
                    onClick={() => setTypeFilter(filterKey)}
                    aria-pressed={activeFilter}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      activeFilter
                        ? active
                        : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-400">
              Kategorie
              <select
                value={categoryFilter}
                onChange={(change) => setCategoryFilter(change.target.value)}
                className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50"
              >
                <option value="all">Alle</option>
                {availableCategories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>

            <div className="ml-auto flex flex-wrap gap-2">
              <button
                onClick={() =>
                  setDraft({ mode: "new", defaultType: "income" })
                }
                disabled={month === null}
                className="flex items-center gap-1.5 rounded-xl bg-emerald-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus size={16} />
                Einnahme
              </button>

              <button
                onClick={() =>
                  setDraft({ mode: "new", defaultType: "expense" })
                }
                disabled={month === null}
                className="flex items-center gap-1.5 rounded-xl bg-rose-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-rose-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus size={16} />
                Ausgabe
              </button>
            </div>
          </div>

          {month === null ? (
            <div className="mt-6 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-10 text-center text-sm text-slate-500">
              Finanzen werden geladen …
            </div>
          ) : (
            <>
              {hasNonEuro && (
                <p className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-3 text-xs leading-5 text-slate-400">
                  Hinweis: Dieser Monat enthält Buchungen in Fremdwährung. Sie
                  sind unten aufgeführt, fließen aber mangels Wechselkurs nicht
                  in die Summen ein.
                </p>
              )}

              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <div className="rounded-2xl border border-white/[0.08] bg-[#0d111b] p-5">
                  <TrendingUp className="text-emerald-300" size={22} />
                  <p className="mt-4 text-2xl font-semibold tabular-nums text-emerald-200">
                    {formatCents(totals.income)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Einnahmen · {monthLabel(month)}
                  </p>
                </div>

                <div className="rounded-2xl border border-white/[0.08] bg-[#0d111b] p-5">
                  <TrendingDown className="text-rose-300" size={22} />
                  <p className="mt-4 text-2xl font-semibold tabular-nums text-rose-200">
                    {formatCents(totals.expense)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Ausgaben · {monthLabel(month)}
                  </p>
                </div>

                <div className="rounded-2xl border border-white/[0.08] bg-[#0d111b] p-5">
                  <Wallet className="text-cyan-300" size={22} />
                  <p
                    className={`mt-4 text-2xl font-semibold tabular-nums ${
                      totals.net < 0 ? "text-rose-200" : "text-cyan-200"
                    }`}
                  >
                    {formatSignedCents(totals.net)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Netto · {monthLabel(month)}
                  </p>
                </div>
              </div>

              <div className="mt-6 grid gap-5 xl:grid-cols-2">
                <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-6">
                  <h2 className="font-semibold">Übersicht</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Einnahmen und Ausgaben der letzten sechs Monate
                  </p>
                  <div className="mt-5">
                    <FinanceChart series={series} />
                  </div>
                </section>

                <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-6">
                  <h2 className="font-semibold">Budgets</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Monatliche Ausgabenlimits mit Fortschritt
                  </p>
                  <div className="mt-5">
                    <BudgetPanel
                      monthExpenseTotal={totals.expense}
                      categoryTotals={categoryTotals}
                      monthlyBudgetCents={data.monthlyBudgetCents}
                      categoryBudgets={data.categoryBudgets}
                      onSaveTotal={saveTotalBudget}
                      onSaveCategory={saveCategoryBudget}
                      onDeleteCategory={deleteCategoryBudget}
                    />
                  </div>
                </section>
              </div>

              <div className="mt-6 grid gap-5 xl:grid-cols-2">
                <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-6">
                  <h2 className="font-semibold">Sparziele</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Ziele anlegen und Fortschritt verfolgen
                  </p>
                  <div className="mt-5">
                    <GoalsPanel
                      goals={data.goals}
                      onAdd={addGoal}
                      onUpdate={updateGoal}
                      onDelete={deleteGoal}
                    />
                  </div>
                </section>

                <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-6">
                  <div className="flex items-baseline justify-between gap-2">
                    <h2 className="font-semibold">Buchungen</h2>
                    <p className="text-xs text-slate-500">
                      {visibleTransactions.length}{" "}
                      {visibleTransactions.length === 1
                        ? "Eintrag"
                        : "Einträge"}
                    </p>
                  </div>

                  <div className="mt-5 space-y-2">
                    {visibleTransactions.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                        Keine Buchungen für diesen Filter. Lege oben eine
                        Einnahme oder Ausgabe an.
                      </div>
                    ) : (
                      visibleTransactions.map((transaction) => (
                        <button
                          key={transaction.id}
                          onClick={() =>
                            setDraft({ mode: "edit", transaction })
                          }
                          className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4 text-left transition hover:bg-white/[0.04]"
                        >
                          <span
                            aria-hidden="true"
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              transaction.type === "income"
                                ? "bg-emerald-400"
                                : "bg-rose-400"
                            }`}
                          />

                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-slate-200">
                              {transaction.title}
                            </span>
                            <span className="mt-1 block truncate text-xs text-slate-500">
                              {formatDay(transaction.date)} ·{" "}
                              {transaction.category}
                              {transaction.currency !== undefined &&
                              transaction.currency !== "EUR"
                                ? ` · ${transaction.currency}`
                                : ""}
                              {transaction.importStatus === "imported"
                                ? " · PDF-Import"
                                : ""}
                              {transaction.note
                                ? ` · ${transaction.note}`
                                : ""}
                            </span>
                          </span>

                          <span
                            className={`shrink-0 text-sm font-medium tabular-nums ${
                              transaction.type === "income"
                                ? "text-emerald-300"
                                : "text-rose-300"
                            }`}
                          >
                            {transaction.type === "income" ? "+" : "−"}
                            {formatCents(transaction.amount)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </section>
              </div>

              <div className="mt-6 grid gap-5 xl:grid-cols-2">
                <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-6">
                  <ImportPanel
                    transactions={data.transactions}
                    displayMonthKey={key}
                    batches={batches}
                    onImport={importBatch}
                    onDeleteBatch={deleteBatch}
                  />
                </section>

                <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-6">
                  <AnalysisPanel data={data} month={month} />
                </section>
              </div>
            </>
          )}

          <footer className="py-8 text-center text-xs text-slate-600">
            J.A.R.V.I.S. · Finanzen · Lokale Speicherung
          </footer>
        </section>
      </div>

      {draft !== null && (
        <TransactionForm
          key={
            draft.mode === "edit"
              ? draft.transaction.id
              : `new-${draft.defaultType}`
          }
          mode={draft.mode}
          initial={draft.mode === "edit" ? draft.transaction : null}
          defaultType={
            draft.mode === "edit"
              ? draft.transaction.type
              : draft.defaultType
          }
          defaultDate={defaultDate}
          onSave={saveTransaction}
          onDelete={deleteTransaction}
          onClose={() => setDraft(null)}
        />
      )}
    </main>
  );
}
