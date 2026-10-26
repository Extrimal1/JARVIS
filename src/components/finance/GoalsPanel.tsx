"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  centsToEuroInput,
  formatCents,
  parseEuroToCents,
  parseEuroToCentsAllowingZero,
  type SavingsGoal,
} from "@/src/lib/finance";

type FormErrors = Partial<Record<"title" | "target" | "saved", string>>;

export function GoalsPanel({
  goals,
  onAdd,
  onUpdate,
  onDelete,
}: {
  goals: SavingsGoal[];
  onAdd: (goal: SavingsGoal) => void;
  onUpdate: (goal: SavingsGoal) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [saved, setSaved] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function openNew() {
    setEditingId("new");
    setTitle("");
    setTarget("");
    setSaved(centsToEuroInput(0));
    setErrors({});
    setConfirmDeleteId(null);
  }

  function openEdit(goal: SavingsGoal) {
    setEditingId(goal.id);
    setTitle(goal.title);
    setTarget(centsToEuroInput(goal.targetCents));
    setSaved(centsToEuroInput(goal.savedCents));
    setErrors({});
    setConfirmDeleteId(null);
  }

  function closeForm() {
    setEditingId(null);
    setErrors({});
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextErrors: FormErrors = {};

    if (title.trim() === "") {
      nextErrors.title = "Bitte gib einen Titel ein.";
    }

    const targetCents = parseEuroToCents(target);

    if (targetCents === null) {
      nextErrors.target = "Bitte gib ein gültiges Sparziel ein.";
    }

    const savedCents = parseEuroToCentsAllowingZero(saved);

    if (savedCents === null) {
      nextErrors.saved = "Bitte gib einen gültigen Betrag ein.";
    }

    setErrors(nextErrors);

    if (
      Object.keys(nextErrors).length > 0 ||
      targetCents === null ||
      savedCents === null
    ) {
      return;
    }

    if (editingId === "new") {
      onAdd({
        id: Date.now().toString(),
        title: title.trim(),
        targetCents,
        savedCents,
      });
    } else if (editingId !== null) {
      onUpdate({
        id: editingId,
        title: title.trim(),
        targetCents,
        savedCents,
      });
    }

    closeForm();
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-xs leading-5 text-slate-500">
          {goals.length === 0
            ? "Lege Sparziele an und verfolge deinen Fortschritt."
            : `${goals.length} ${goals.length === 1 ? "Sparziel" : "Sparziele"}`}
        </p>

        {editingId === null && (
          <button
            onClick={openNew}
            className="flex shrink-0 items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30"
          >
            <Plus size={15} />
            Hinzufügen
          </button>
        )}
      </div>

      {editingId !== null && (
        <form
          onSubmit={submit}
          noValidate
          className="mb-4 space-y-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4"
        >
          <label className="block text-xs text-slate-400">
            Titel
            <input
              autoFocus
              value={title}
              onChange={(change) => {
                setTitle(change.target.value);
                setErrors({});
              }}
              placeholder="z. B. Urlaub in Italien"
              maxLength={120}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
            />
            {errors.title && (
              <span className="mt-1 block text-xs text-rose-300">
                {errors.title}
              </span>
            )}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-slate-400">
              Sparziel (€)
              <input
                value={target}
                onChange={(change) => {
                  setTarget(change.target.value);
                  setErrors({});
                }}
                placeholder="z. B. 1200,00"
                inputMode="decimal"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
              />
              {errors.target && (
                <span className="mt-1 block text-xs text-rose-300">
                  {errors.target}
                </span>
              )}
            </label>

            <label className="block text-xs text-slate-400">
              Bereits gespart (€)
              <input
                value={saved}
                onChange={(change) => {
                  setSaved(change.target.value);
                  setErrors({});
                }}
                placeholder="z. B. 300,00"
                inputMode="decimal"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
              />
              {errors.saved && (
                <span className="mt-1 block text-xs text-rose-300">
                  {errors.saved}
                </span>
              )}
            </label>
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              className="flex-1 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
            >
              {editingId === "new" ? "Sparziel anlegen" : "Speichern"}
            </button>
            <button
              type="button"
              onClick={closeForm}
              className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
            >
              Abbrechen
            </button>
          </div>
        </form>
      )}

      {goals.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
          Noch keine Sparziele vorhanden.
        </div>
      ) : (
        <ul className="space-y-3">
          {goals.map((goal) => {
            const percent =
              goal.targetCents > 0
                ? Math.min(100, (goal.savedCents / goal.targetCents) * 100)
                : 0;
            const reached =
              goal.targetCents > 0 && goal.savedCents >= goal.targetCents;

            return (
              <li
                key={goal.id}
                className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-200">
                      {goal.title}
                    </p>
                    <p className="mt-1 text-xs tabular-nums text-slate-500">
                      {formatCents(goal.savedCents)}{" "}
                      <span className="text-slate-600">
                        / {formatCents(goal.targetCents)}
                      </span>
                      {reached && (
                        <span className="ml-2 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-300">
                          Erreicht
                        </span>
                      )}
                    </p>
                  </div>

                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => openEdit(goal)}
                      aria-label={`Sparziel bearbeiten: ${goal.title}`}
                      title="Bearbeiten"
                      className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(goal.id)}
                      aria-label={`Sparziel löschen: ${goal.title}`}
                      title="Löschen"
                      className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>

                <div
                  role="progressbar"
                  aria-label={`Fortschritt: ${goal.title}`}
                  aria-valuenow={Math.round(percent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.06]"
                >
                  <div
                    style={{ width: `${percent}%` }}
                    className={`h-full rounded-full ${reached ? "bg-emerald-400" : "bg-cyan-300"}`}
                  />
                </div>

                {confirmDeleteId === goal.id && (
                  <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/5 p-3">
                    <p className="text-xs text-rose-200">
                      Dieses Sparziel wirklich löschen?
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => {
                          onDelete(goal.id);
                          setConfirmDeleteId(null);
                        }}
                        className="flex-1 rounded-lg bg-rose-400 px-3 py-2 text-xs font-medium text-slate-950 transition hover:bg-rose-300"
                      >
                        Endgültig löschen
                      </button>
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-300 hover:bg-white/5"
                      >
                        Abbrechen
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
