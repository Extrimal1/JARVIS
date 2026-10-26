"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Route,
  Trash2,
  X,
} from "lucide-react";
import { useLocalStorage } from "@/src/hooks/useLocalStorage";
import { useToday } from "@/src/hooks/useToday";
import { createId } from "@/src/lib/ids";
import { parseISODateLocal } from "@/src/lib/calendar";
import {
  centsToEuroInput,
  formatCents,
  parseEuroToCentsAllowingZero,
} from "@/src/lib/finance";
import {
  CATEGORY_LABELS,
  EMPTY_PLANS,
  LIFESTYLE_PLANS_KEY,
  PLACE_CATEGORIES,
  formatDayMedium,
  isOutingPlanList,
  type OutingPlan,
  type OutingStop,
  type Place,
  type PlaceCategory,
} from "@/src/lib/lifestyle/types";

export function PlannerPanel({ places }: { places: Place[] }) {
  const [plans, setPlans, loaded] = useLocalStorage(
    LIFESTYLE_PLANS_KEY,
    EMPTY_PLANS,
    isOutingPlanList,
  );
  const today = useToday();
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [duration, setDuration] = useState("");
  const [budget, setBudget] = useState("");
  const [categories, setCategories] = useState<PlaceCategory[]>([]);
  const [stops, setStops] = useState<OutingStop[]>([]);
  const [stopPlace, setStopPlace] = useState("");
  const [stopNote, setStopNote] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const placeById = new Map(places.map((place) => [place.id, place]));
  const sortedPlaces = [...places].sort((a, b) =>
    a.name.localeCompare(b.name, "de"),
  );

  function costSummary(draft: OutingStop[]): {
    known: number;
    unknown: number;
  } {
    let known = 0;
    let unknown = 0;

    for (const stop of draft) {
      const cost = placeById.get(stop.placeId)?.costCents ?? null;

      if (cost === null) {
        unknown += 1;
      } else {
        known += cost;
      }
    }

    return { known, unknown };
  }

  function openNew() {
    setEditing("new");
    setTitle("");
    setDate(today ?? "");
    setDuration("");
    setBudget("");
    setCategories([]);
    setStops([]);
    setStopPlace("");
    setStopNote("");
    setNotes("");
    setFormError(null);
    setConfirmDeleteId(null);
  }

  function openEdit(plan: OutingPlan) {
    setEditing(plan.id);
    setTitle(plan.title);
    setDate(plan.date);
    setDuration(
      plan.durationMinutes === null ? "" : String(plan.durationMinutes),
    );
    setBudget(
      plan.budgetCents === null ? "" : centsToEuroInput(plan.budgetCents),
    );
    setCategories([...plan.categories]);
    setStops(plan.stops.map((stop) => ({ ...stop })));
    setStopPlace("");
    setStopNote("");
    setNotes(plan.notes);
    setFormError(null);
    setConfirmDeleteId(null);
  }

  function toggleCategory(category: PlaceCategory) {
    setCategories((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category],
    );
  }

  function addStop() {
    if (stopPlace === "") return;

    setStops((current) => [
      ...current,
      { placeId: stopPlace, note: stopNote.trim() },
    ]);
    setStopPlace("");
    setStopNote("");
  }

  function moveStop(index: number, delta: -1 | 1) {
    setStops((current) => {
      const next = [...current];
      const target = index + delta;

      if (target < 0 || target >= next.length) return current;

      [next[index], next[target]] = [next[target], next[index]];

      return next;
    });
  }

  function removeStop(index: number) {
    setStops((current) => current.filter((_, i) => i !== index));
  }

  function savePlan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing === null) return;

    if (title.trim() === "") {
      setFormError("Bitte gib einen Titel ein.");
      return;
    }

    if (parseISODateLocal(date) === null) {
      setFormError("Bitte wähle ein gültiges Datum.");
      return;
    }

    const durationMinutes =
      duration.trim() === "" ? null : Number(duration.trim());

    if (
      durationMinutes !== null &&
      (!Number.isInteger(durationMinutes) || durationMinutes <= 0)
    ) {
      setFormError("Die Dauer muss eine positive Minutenzahl sein.");
      return;
    }

    const budgetCents =
      budget.trim() === "" ? null : parseEuroToCentsAllowingZero(budget);

    if (budget.trim() !== "" && budgetCents === null) {
      setFormError("Das Budget ist ungültig (z. B. 50,00).");
      return;
    }

    const now = new Date().toISOString();

    if (editing === "new") {
      const entry: OutingPlan = {
        id: createId(),
        title: title.trim(),
        date,
        durationMinutes,
        budgetCents,
        categories,
        stops,
        notes: notes.trim(),
        createdAt: now,
        updatedAt: now,
      };
      setPlans((current) => [...current, entry]);
    } else {
      setPlans((current) =>
        current.map((item) =>
          item.id === editing
            ? {
                ...item,
                title: title.trim(),
                date,
                durationMinutes,
                budgetCents,
                categories,
                stops,
                notes: notes.trim(),
                updatedAt: now,
              }
            : item,
        ),
      );
    }

    setEditing(null);
    setFormError(null);
  }

  function deletePlan(id: string) {
    setPlans((current) => current.filter((item) => item.id !== id));
    setConfirmDeleteId(null);
  }

  const draft = costSummary(stops);
  const draftBudget =
    budget.trim() === "" ? null : parseEuroToCentsAllowingZero(budget);

  return (
    <section
      id="planung"
      aria-label="Ausflugsplanung"
      className="scroll-mt-4 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
            <Route size={21} />
          </div>

          <div>
            <h2 className="font-semibold">Ausflugsplanung</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Stelle Stopps in deiner Reihenfolge zusammen – manuell,
              ohne Routenoptimierung.
            </p>
            <p className="mt-2 text-xs text-cyan-300">
              {plans.length} {plans.length === 1 ? "Plan" : "Pläne"}
            </p>
          </div>
        </div>

        <button
          onClick={openNew}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
        >
          <Plus size={16} />
          Plan erstellen
        </button>
      </div>

      {!loaded ? (
        <p className="mt-5 text-sm text-slate-500">Pläne werden geladen …</p>
      ) : (
        <>
          {editing !== null && (
            <form
              onSubmit={savePlan}
              noValidate
              className="mt-4 space-y-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-slate-400">
                  Titel
                  <input
                    autoFocus
                    value={title}
                    onChange={(change) => {
                      setTitle(change.target.value);
                      setFormError(null);
                    }}
                    placeholder="z. B. Samstagsausflug"
                    maxLength={120}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Datum
                  <input
                    type="date"
                    value={date}
                    onChange={(change) => {
                      setDate(change.target.value);
                      setFormError(null);
                    }}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-slate-400">
                  Verfügbare Zeit in Min. (optional)
                  <input
                    value={duration}
                    onChange={(change) => {
                      setDuration(change.target.value);
                      setFormError(null);
                    }}
                    placeholder="z. B. 240"
                    inputMode="numeric"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Gesamtbudget € (optional)
                  <input
                    value={budget}
                    onChange={(change) => {
                      setBudget(change.target.value);
                      setFormError(null);
                    }}
                    placeholder="z. B. 50,00"
                    inputMode="decimal"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50"
                  />
                </label>
              </div>

              <div>
                <p className="text-xs text-slate-400">
                  Gewünschte Kategorien (optional)
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {PLACE_CATEGORIES.map((category) => {
                    const active = categories.includes(category);

                    return (
                      <button
                        key={category}
                        type="button"
                        onClick={() => toggleCategory(category)}
                        aria-pressed={active}
                        className={`rounded-full border px-3 py-1.5 text-xs transition ${
                          active
                            ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-200"
                            : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200"
                        }`}
                      >
                        {CATEGORY_LABELS[category]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <p className="text-xs text-slate-400">Stopps</p>
                {stops.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {stops.map((stop, index) => {
                      const place = placeById.get(stop.placeId);

                      return (
                        <li
                          key={`${stop.placeId}-${index}`}
                          className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5"
                        >
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-[11px] tabular-nums text-slate-300">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                            {place === undefined ? (
                              <span className="text-rose-300">
                                Entfernter Ort
                              </span>
                            ) : (
                              place.name
                            )}
                            {stop.note !== "" && (
                              <span className="text-slate-500">
                                {" "}
                                · {stop.note}
                              </span>
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => moveStop(index, -1)}
                            disabled={index === 0}
                            aria-label="Stopp nach oben"
                            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200 disabled:opacity-30"
                          >
                            <ChevronUp size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => moveStop(index, 1)}
                            disabled={index === stops.length - 1}
                            aria-label="Stopp nach unten"
                            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-slate-200 disabled:opacity-30"
                          >
                            <ChevronDown size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeStop(index)}
                            aria-label="Stopp entfernen"
                            className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                          >
                            <X size={15} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {places.length === 0 ? (
                  <p className="mt-2 text-xs text-slate-500">
                    Lege zuerst oben Orte an, um Stopps hinzuzufügen.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <select
                      value={stopPlace}
                      onChange={(change) => setStopPlace(change.target.value)}
                      aria-label="Ort für Stopp wählen"
                      className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                    >
                      <option value="">Ort wählen …</option>
                      {sortedPlaces.map((place) => (
                        <option key={place.id} value={place.id}>
                          {place.name}
                        </option>
                      ))}
                    </select>
                    <input
                      value={stopNote}
                      onChange={(change) => setStopNote(change.target.value)}
                      placeholder="Notiz (optional)"
                      maxLength={120}
                      aria-label="Notiz zum Stopp"
                      className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                    />
                    <button
                      type="button"
                      onClick={addStop}
                      disabled={stopPlace === ""}
                      className="flex shrink-0 items-center justify-center gap-1 rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition hover:border-cyan-300/30 disabled:opacity-40"
                    >
                      <Plus size={15} />
                      Stopp
                    </button>
                  </div>
                )}

                <div className="mt-2 rounded-xl border border-white/[0.06] bg-black/20 px-3 py-2.5 text-xs leading-5 text-slate-400">
                  {stops.length === 0 ? (
                    "Noch keine Stopps – Kosten folgen, sobald du Orte hinzufügst."
                  ) : draft.unknown === stops.length ? (
                    "Kosten unbekannt – für keinen Stopp liegt ein Preis vor."
                  ) : (
                    <>
                      Geschätzte Kosten:{" "}
                      <span className="font-medium tabular-nums text-slate-200">
                        {formatCents(draft.known)}
                      </span>
                      {draft.unknown > 0 && (
                        <span className="text-slate-500">
                          {" "}
                          zzgl. {draft.unknown} × unbekannt
                        </span>
                      )}
                      {draftBudget !== null && (
                        <span
                          className={
                            draft.known > draftBudget
                              ? "text-rose-300"
                              : draft.unknown > 0
                                ? "text-slate-500"
                                : "text-emerald-300"
                          }
                        >
                          {" "}
                          ·{" "}
                          {draft.known > draftBudget
                            ? `Über Budget (${formatCents(draftBudget)})`
                            : draft.unknown > 0
                              ? `Voraussichtlich im Budget (${formatCents(draftBudget)})`
                              : `Im Budget (${formatCents(draftBudget)})`}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>

              <label className="block text-xs text-slate-400">
                Notizen (optional)
                <textarea
                  value={notes}
                  onChange={(change) => setNotes(change.target.value)}
                  placeholder="z. B. Picknickdecke einpacken"
                  maxLength={500}
                  rows={2}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                />
              </label>

              {formError !== null && (
                <p role="alert" className="text-xs text-rose-300">
                  {formError}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex-1 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                >
                  {editing === "new" ? "Plan speichern" : "Speichern"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setFormError(null);
                  }}
                  className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                >
                  Abbrechen
                </button>
              </div>
            </form>
          )}

          <div className="mt-4">
            {plans.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                Noch keine Ausflugspläne vorhanden.
              </div>
            ) : (
              <ul className="space-y-2">
                {plans.map((plan) => {
                  const summary = costSummary(plan.stops);

                  return (
                    <li
                      key={plan.id}
                      className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-200">
                            {plan.title}
                          </p>
                          <p className="mt-1 text-xs tabular-nums text-slate-500">
                            {formatDayMedium(plan.date)} · {plan.stops.length}{" "}
                            {plan.stops.length === 1 ? "Stopp" : "Stopps"}
                            {summary.unknown === 0 &&
                            plan.stops.length > 0 ? (
                              <> · {formatCents(summary.known)}</>
                            ) : summary.unknown > 0 ? (
                              <> · Kosten teilweise unbekannt</>
                            ) : null}
                          </p>
                          {plan.notes !== "" && (
                            <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                              {plan.notes}
                            </p>
                          )}
                        </div>

                        <div className="flex shrink-0 gap-1">
                          <button
                            onClick={() => openEdit(plan)}
                            aria-label={`Plan öffnen: ${plan.title}`}
                            title="Öffnen"
                            className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(plan.id)}
                            aria-label={`Plan löschen: ${plan.title}`}
                            title="Löschen"
                            className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>

                      {confirmDeleteId === plan.id && (
                        <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/5 p-4">
                          <p className="text-sm text-rose-200">
                            „{plan.title}“ wirklich löschen?
                          </p>
                          <div className="mt-3 flex gap-2">
                            <button
                              onClick={() => deletePlan(plan.id)}
                              className="flex-1 rounded-xl bg-rose-400 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-rose-300"
                            >
                              Endgültig löschen
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
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
        </>
      )}
    </section>
  );
}
