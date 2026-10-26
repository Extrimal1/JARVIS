"use client";

import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { useLockBodyScroll } from "@/src/hooks/useLockBodyScroll";
import { parseISODateLocal } from "@/src/lib/calendar";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  centsToEuroInput,
  parseEuroToCents,
  type Transaction,
  type TransactionType,
} from "@/src/lib/finance";

type FormErrors = Partial<Record<"title" | "amount" | "date", string>>;

type Fields = {
  title: string;
  /** Euro input as typed ("12,34"). Converted to cents on save. */
  amount: string;
  date: string;
  type: TransactionType;
  category: string;
  note: string;
};

function toFields(
  initial: Transaction | null,
  defaultType: TransactionType,
  defaultDate: string,
): Fields {
  if (initial) {
    return {
      title: initial.title,
      amount: centsToEuroInput(initial.amount),
      date: initial.date,
      type: initial.type,
      category: initial.category,
      note: initial.note ?? "",
    };
  }

  return {
    title: "",
    amount: "",
    date: defaultDate,
    type: defaultType,
    category:
      defaultType === "income" ? INCOME_CATEGORIES[0] : EXPENSE_CATEGORIES[0],
    note: "",
  };
}

export function TransactionForm({
  mode,
  initial,
  defaultType,
  defaultDate,
  onSave,
  onDelete,
  onClose,
}: {
  mode: "new" | "edit";
  initial: Transaction | null;
  defaultType: TransactionType;
  defaultDate: string;
  onSave: (transaction: Transaction) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [fields, setFields] = useState<Fields>(() =>
    toFields(initial, defaultType, defaultDate),
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  useLockBodyScroll(true);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  function setField<Key extends keyof Fields>(key: Key, value: Fields[Key]) {
    setFields((current) => ({ ...current, [key]: value }) as Fields);
    setErrors({});
  }

  function setType(type: TransactionType) {
    setFields((current) => {
      const allowed = type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
      const category = (allowed as readonly string[]).includes(
        current.category,
      )
        ? current.category
        : allowed[0];

      return { ...current, type, category };
    });
    setErrors({});
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextErrors: FormErrors = {};

    if (fields.title.trim() === "") {
      nextErrors.title = "Bitte gib eine Bezeichnung ein.";
    }

    const cents = parseEuroToCents(fields.amount);

    if (cents === null) {
      nextErrors.amount =
        "Bitte gib einen gültigen Betrag ein (z. B. 12,34).";
    }

    if (parseISODateLocal(fields.date) === null) {
      nextErrors.date = "Bitte wähle ein gültiges Datum.";
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || cents === null) return;

    onSave({
      id: initial?.id ?? Date.now().toString(),
      title: fields.title.trim(),
      amount: cents,
      type: fields.type,
      category: fields.category,
      date: fields.date,
      ...(fields.note.trim() === "" ? {} : { note: fields.note.trim() }),
      // Preserve import linkage when editing an imported transaction.
      ...(initial?.currency !== undefined ? { currency: initial.currency } : {}),
      ...(initial?.sourceDocumentId !== undefined
        ? { sourceDocumentId: initial.sourceDocumentId }
        : {}),
      ...(initial?.importStatus !== undefined
        ? { importStatus: initial.importStatus }
        : {}),
      ...(initial?.originalDescription !== undefined
        ? { originalDescription: initial.originalDescription }
        : {}),
      // Remember the parsed title once when the user renames an import.
      ...(initial !== null &&
      initial.originalDescription === undefined &&
      fields.title.trim() !== initial.title
        ? { originalDescription: initial.title }
        : {}),
    });
  }

  const categories =
    fields.type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="transaction-form-title"
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
    >
      <button
        aria-label="Schließen"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/70"
      />

      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#0d111b] p-6">
        <div className="flex items-start justify-between gap-3">
          <h2 id="transaction-form-title" className="text-lg font-semibold">
            {mode === "new"
              ? fields.type === "income"
                ? "Neue Einnahme"
                : "Neue Ausgabe"
              : "Buchung bearbeiten"}
          </h2>

          <button
            onClick={onClose}
            aria-label="Schließen"
            className="rounded-xl border border-white/10 p-2 text-slate-400 transition hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} noValidate className="mt-5 space-y-4">
          <div
            role="group"
            aria-label="Art der Buchung"
            className="grid grid-cols-2 gap-2"
          >
            {(
              [
                { value: "income", label: "Einnahme" },
                { value: "expense", label: "Ausgabe" },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setType(option.value)}
                aria-pressed={fields.type === option.value}
                className={`rounded-xl border px-4 py-3 text-sm transition ${
                  fields.type === option.value
                    ? option.value === "income"
                      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                      : "border-rose-400/40 bg-rose-400/10 text-rose-200"
                    : "border-white/10 text-slate-400 hover:text-slate-200"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="block text-xs text-slate-400">
            Bezeichnung
            <input
              autoFocus
              value={fields.title}
              onChange={(change) => setField("title", change.target.value)}
              placeholder={
                fields.type === "income" ? "z. B. Nebenjob" : "z. B. Supermarkt"
              }
              maxLength={120}
              aria-invalid={errors.title !== undefined}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
            {errors.title && (
              <span className="mt-1 block text-xs text-rose-300">
                {errors.title}
              </span>
            )}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-slate-400">
              Betrag (€)
              <input
                value={fields.amount}
                onChange={(change) => setField("amount", change.target.value)}
                placeholder="z. B. 12,34"
                inputMode="decimal"
                aria-invalid={errors.amount !== undefined}
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
              />
              {errors.amount && (
                <span className="mt-1 block text-xs text-rose-300">
                  {errors.amount}
                </span>
              )}
            </label>

            <label className="block text-xs text-slate-400">
              Datum
              <input
                type="date"
                value={fields.date}
                onChange={(change) => setField("date", change.target.value)}
                aria-invalid={errors.date !== undefined}
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
              />
              {errors.date && (
                <span className="mt-1 block text-xs text-rose-300">
                  {errors.date}
                </span>
              )}
            </label>
          </div>

          <label className="block text-xs text-slate-400">
            Kategorie
            <select
              value={fields.category}
              onChange={(change) => setField("category", change.target.value)}
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            >
              {categories.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs text-slate-400">
            Notiz (optional)
            <input
              value={fields.note}
              onChange={(change) => setField("note", change.target.value)}
              placeholder="Optionale Notiz"
              maxLength={200}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
          </label>

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              className="flex-1 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
            >
              {mode === "new" ? "Buchung speichern" : "Änderungen speichern"}
            </button>

            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Abbrechen
            </button>
          </div>

          {mode === "edit" && initial !== null && !confirmDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/25 px-4 py-3 text-sm text-rose-300 transition hover:bg-rose-400/10"
            >
              <Trash2 size={16} />
              Buchung löschen
            </button>
          )}

          {mode === "edit" && initial !== null && confirmDelete && (
            <div className="rounded-xl border border-rose-400/30 bg-rose-400/5 p-4">
              <p className="text-sm text-rose-200">
                Diese Buchung wirklich löschen?
              </p>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => onDelete(initial.id)}
                  className="flex-1 rounded-xl bg-rose-400 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-rose-300"
                >
                  Endgültig löschen
                </button>

                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                >
                  Abbrechen
                </button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
