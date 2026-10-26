"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  EXPENSE_CATEGORIES,
  centsToEuroInput,
  formatCents,
  parseEuroToCents,
} from "@/src/lib/finance";

function ProgressBar({
  spent,
  budget,
  label,
}: {
  spent: number;
  budget: number;
  label: string;
}) {
  const percent = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
  const exceeded = budget > 0 && spent > budget;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="tabular-nums text-slate-300">
          {formatCents(spent)} <span className="text-slate-500">/ {formatCents(budget)}</span>
        </span>
      </div>

      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-2 h-2 overflow-hidden rounded-full bg-white/[0.06]"
      >
        <div
          style={{ width: `${percent}%` }}
          className={`h-full rounded-full ${exceeded ? "bg-rose-400" : "bg-cyan-300"}`}
        />
      </div>

      {exceeded && (
        <p className="mt-1 text-[11px] text-rose-300">
          Budget um {formatCents(spent - budget)} überschritten.
        </p>
      )}
    </div>
  );
}

export function BudgetPanel({
  monthExpenseTotal,
  categoryTotals,
  monthlyBudgetCents,
  categoryBudgets,
  onSaveTotal,
  onSaveCategory,
  onDeleteCategory,
}: {
  monthExpenseTotal: number;
  categoryTotals: { category: string; spent: number }[];
  monthlyBudgetCents: number;
  categoryBudgets: Record<string, number>;
  onSaveTotal: (cents: number) => void;
  onSaveCategory: (category: string, cents: number) => void;
  onDeleteCategory: (category: string) => void;
}) {
  const [editingTotal, setEditingTotal] = useState(false);
  const [totalInput, setTotalInput] = useState("");
  const [totalError, setTotalError] = useState<string | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const [newCategory, setNewCategory] = useState<string>(EXPENSE_CATEGORIES[0]);
  const [newCategoryInput, setNewCategoryInput] = useState("");
  const [newCategoryError, setNewCategoryError] = useState<string | null>(null);

  const budgetedCategories = Object.entries(categoryBudgets).sort(([a], [b]) =>
    a.localeCompare(b, "de"),
  );
  const unbudgetedCategories = EXPENSE_CATEGORIES.filter(
    (category) => !(category in categoryBudgets),
  );

  function spentFor(category: string): number {
    return (
      categoryTotals.find((total) => total.category === category)?.spent ?? 0
    );
  }

  function openTotalEditor() {
    setTotalInput(
      monthlyBudgetCents > 0 ? centsToEuroInput(monthlyBudgetCents) : "",
    );
    setTotalError(null);
    setEditingTotal(true);
  }

  function submitTotal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const cents = parseEuroToCents(totalInput);

    if (cents === null) {
      setTotalError("Bitte gib einen gültigen Betrag ein (z. B. 800,00).");
      return;
    }

    onSaveTotal(cents);
    setEditingTotal(false);
  }

  function submitCategory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const cents = parseEuroToCents(newCategoryInput);

    if (cents === null) {
      setNewCategoryError(
        "Bitte gib einen gültigen Betrag ein (z. B. 250,00).",
      );
      return;
    }

    onSaveCategory(newCategory, cents);
    setAddingCategory(false);
    setNewCategoryInput("");
    setNewCategoryError(null);
  }

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-slate-200">
            Gesamtbudget (monatlich)
          </h3>

          {!editingTotal &&
            (monthlyBudgetCents > 0 ? (
              <div className="flex gap-2">
                <button
                  onClick={openTotalEditor}
                  className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-cyan-300/30"
                >
                  Ändern
                </button>
                <button
                  onClick={() => onSaveTotal(0)}
                  aria-label="Gesamtbudget entfernen"
                  title="Gesamtbudget entfernen"
                  className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ) : (
              <button
                onClick={openTotalEditor}
                className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-cyan-300/30"
              >
                Festlegen
              </button>
            ))}
        </div>

        {editingTotal ? (
          <form
            onSubmit={submitTotal}
            noValidate
            className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4"
          >
            <label className="block text-xs text-slate-400">
              Monatsbudget (€)
              <input
                autoFocus
                value={totalInput}
                onChange={(change) => {
                  setTotalInput(change.target.value);
                  setTotalError(null);
                }}
                placeholder="z. B. 800,00"
                inputMode="decimal"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
              />
            </label>

            {totalError && (
              <p className="mt-2 text-xs text-rose-300">{totalError}</p>
            )}

            <div className="mt-3 flex gap-2">
              <button
                type="submit"
                className="flex-1 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
              >
                Speichern
              </button>
              <button
                type="button"
                onClick={() => setEditingTotal(false)}
                className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
              >
                Abbrechen
              </button>
            </div>
          </form>
        ) : monthlyBudgetCents > 0 ? (
          <ProgressBar
            spent={monthExpenseTotal}
            budget={monthlyBudgetCents}
            label="Ausgaben im Monat"
          />
        ) : (
          <p className="text-sm text-slate-500">
            Kein Gesamtbudget festgelegt.
          </p>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-slate-200">
            Budgets nach Kategorie
          </h3>

          {!addingCategory && unbudgetedCategories.length > 0 && (
            <button
              onClick={() => {
                setNewCategory(unbudgetedCategories[0]);
                setNewCategoryInput("");
                setNewCategoryError(null);
                setAddingCategory(true);
              }}
              className="flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 transition hover:border-cyan-300/30"
            >
              <Plus size={13} />
              Hinzufügen
            </button>
          )}
        </div>

        {addingCategory && (
          <form
            onSubmit={submitCategory}
            noValidate
            className="mb-3 space-y-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4"
          >
            <label className="block text-xs text-slate-400">
              Kategorie
              <select
                value={newCategory}
                onChange={(change) => setNewCategory(change.target.value)}
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
              >
                {unbudgetedCategories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-xs text-slate-400">
              Monatsbudget (€)
              <input
                value={newCategoryInput}
                onChange={(change) => {
                  setNewCategoryInput(change.target.value);
                  setNewCategoryError(null);
                }}
                placeholder="z. B. 250,00"
                inputMode="decimal"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
              />
            </label>

            {newCategoryError && (
              <p className="text-xs text-rose-300">{newCategoryError}</p>
            )}

            <div className="flex gap-2">
              <button
                type="submit"
                className="flex-1 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
              >
                Speichern
              </button>
              <button
                type="button"
                onClick={() => setAddingCategory(false)}
                className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
              >
                Abbrechen
              </button>
            </div>
          </form>
        )}

        {budgetedCategories.length === 0 ? (
          <p className="text-sm text-slate-500">
            Keine Kategoriebudgets festgelegt.
          </p>
        ) : (
          <ul className="space-y-4">
            {budgetedCategories.map(([category, budget]) => (
              <li key={category}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-300">
                    {category}
                  </span>
                  <button
                    onClick={() => onDeleteCategory(category)}
                    aria-label={`Budget entfernen: ${category}`}
                    title="Budget entfernen"
                    className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                <ProgressBar
                  spent={spentFor(category)}
                  budget={budget}
                  label={`Ausgaben für ${category}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
