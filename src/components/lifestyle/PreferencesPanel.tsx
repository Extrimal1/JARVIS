"use client";

import { useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  Heart,
  Home,
  Navigation,
  RotateCcw,
  SlidersHorizontal,
  Sun,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import {
  centsToEuroInput,
  parseEuroToCentsAllowingZero,
} from "@/src/lib/finance";
import {
  CATEGORY_LABELS,
  DEFAULT_PREFERENCES,
  PLACE_CATEGORIES,
  type LifestylePreferences,
  type OutingCompany,
  type PlaceCategory,
  type SettingPreference,
} from "@/src/lib/lifestyle/types";

const SETTING_OPTIONS: { key: SettingPreference; label: string }[] = [
  { key: "any", label: "Egal" },
  { key: "indoor", label: "Drinnen" },
  { key: "outdoor", label: "Draußen" },
];

const COMPANY_OPTIONS: { key: OutingCompany; label: string }[] = [
  { key: "any", label: "Egal" },
  { key: "solo", label: "Solo" },
  { key: "friends", label: "Freunde" },
  { key: "date", label: "Date" },
];

const DURATION_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Egal" },
  { value: "60", label: "Max. 1 Stunde" },
  { value: "120", label: "Max. 2 Stunden" },
  { value: "240", label: "Max. 4 Stunden" },
  { value: "480", label: "Max. 8 Stunden" },
];

export function PreferencesPanel({
  prefs,
  setPrefs,
  loaded,
}: {
  prefs: LifestylePreferences;
  setPrefs: Dispatch<SetStateAction<LifestylePreferences>>;
  loaded: boolean;
}) {
  const [budgetInput, setBudgetInput] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [geoLoading, setGeoLoading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  function update(patch: Partial<LifestylePreferences>) {
    setPrefs((current) => ({ ...current, ...patch }));
  }

  function toggleCategory(category: PlaceCategory) {
    update({
      categories: prefs.categories.includes(category)
        ? prefs.categories.filter((item) => item !== category)
        : [...prefs.categories, category],
    });
  }

  function requestGeolocation() {
    setGeoError(null);

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoError(
        "Geolokalisierung wird von diesem Browser nicht unterstützt.",
      );
      return;
    }

    setGeoLoading(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setGeoLoading(false);
        update({
          useGeolocation: true,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      () => {
        setGeoLoading(false);
        setGeoError(
          "Standort wurde nicht freigegeben. Du kannst stattdessen eine Stadt manuell eintragen.",
        );
      },
      { timeout: 10_000 },
    );
  }

  const budgetValue =
    budgetInput ??
    (prefs.maxBudgetCents === null
      ? ""
      : centsToEuroInput(prefs.maxBudgetCents));

  return (
    <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
          <SlidersHorizontal size={21} />
        </div>

        <div>
          <h2 className="font-semibold">Vorlieben</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Diese Angaben steuern Filter und Vorschläge. Alles bleibt lokal
            gespeichert.
          </p>
        </div>
      </div>

      {!loaded ? (
        <p className="mt-5 text-sm text-slate-500">
          Vorlieben werden geladen …
        </p>
      ) : (
        <div className="mt-5 space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-xs text-slate-400">
              Stadt oder Ort (manuell)
              <input
                value={prefs.city}
                onChange={(change) =>
                  update({ city: change.target.value })
                }
                placeholder="z. B. Berlin"
                maxLength={80}
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
              />
            </label>

            <div>
              <p className="text-xs text-slate-400">Genauer Standort</p>
              {prefs.useGeolocation &&
              prefs.latitude !== null &&
              prefs.longitude !== null ? (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5">
                  <p className="truncate text-sm tabular-nums text-slate-200">
                    {prefs.latitude.toFixed(4)},{" "}
                    {prefs.longitude.toFixed(4)}
                  </p>
                  <button
                    onClick={() =>
                      update({
                        useGeolocation: false,
                        latitude: null,
                        longitude: null,
                      })
                    }
                    className="flex shrink-0 items-center gap-1 text-xs text-slate-500 transition hover:text-rose-300"
                  >
                    <Trash2 size={13} />
                    Entfernen
                  </button>
                </div>
              ) : (
                <button
                  onClick={requestGeolocation}
                  disabled={geoLoading}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-sm text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 disabled:opacity-50"
                >
                  <Navigation size={15} />
                  {geoLoading ? "Wird ermittelt …" : "Standort verwenden"}
                </button>
              )}
              <p className="mt-1.5 text-[11px] leading-4 text-slate-500">
                Optional: dient nur der Entfernungsberechnung und wird nur
                mit deiner Zustimmung lokal gespeichert.
              </p>
              {geoError !== null && (
                <p role="alert" className="mt-1.5 text-xs text-rose-300">
                  {geoError}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-xs text-slate-400">
              Suchradius: {prefs.radiusKm} km
              <input
                type="range"
                min={1}
                max={50}
                step={1}
                value={prefs.radiusKm}
                onChange={(change) =>
                  update({ radiusKm: Number(change.target.value) })
                }
                className="mt-3 w-full accent-cyan-300"
              />
            </label>

            <label className="block text-xs text-slate-400">
              Max. Budget pro Person (€, leer = egal)
              <input
                value={budgetValue}
                onChange={(change) => {
                  const raw = change.target.value;
                  setBudgetInput(raw);

                  if (raw.trim() === "") {
                    update({ maxBudgetCents: null });
                    return;
                  }

                  const cents = parseEuroToCentsAllowingZero(raw);

                  if (cents !== null) {
                    update({ maxBudgetCents: cents });
                  }
                }}
                placeholder="z. B. 20,00"
                inputMode="decimal"
                className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
              />
            </label>
          </div>

          <div>
            <p className="text-xs text-slate-400">
              Bevorzugte Kategorien (leer = alle)
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {PLACE_CATEGORIES.map((category) => {
                const active = prefs.categories.includes(category);

                return (
                  <button
                    key={category}
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

          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <p className="text-xs text-slate-400">Drinnen / Draußen</p>
              <div className="mt-2 flex gap-2">
                {SETTING_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    onClick={() => update({ setting: option.key })}
                    aria-pressed={prefs.setting === option.key}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-xs transition ${
                      prefs.setting === option.key
                        ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-200"
                        : "border-white/10 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {option.key === "indoor" && <Home size={14} />}
                    {option.key === "outdoor" && <Sun size={14} />}
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="block text-xs text-slate-400">
              Verfügbare Zeit
              <select
                value={
                  prefs.maxDurationMinutes === null
                    ? ""
                    : String(prefs.maxDurationMinutes)
                }
                onChange={(change) =>
                  update({
                    maxDurationMinutes:
                      change.target.value === ""
                        ? null
                        : Number(change.target.value),
                  })
                }
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
              >
                {DURATION_OPTIONS.map((option) => (
                  <option key={option.label} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <p className="text-xs text-slate-400">Begleitung</p>
              <div className="mt-2 flex gap-2">
                {COMPANY_OPTIONS.map((option) => (
                  <button
                    key={option.key}
                    onClick={() => update({ company: option.key })}
                    aria-pressed={prefs.company === option.key}
                    aria-label={`Begleitung: ${option.label}`}
                    title={option.label}
                    className={`flex flex-1 items-center justify-center gap-1 rounded-xl border px-2 py-2.5 text-xs transition ${
                      prefs.company === option.key
                        ? "border-cyan-300/40 bg-cyan-300/10 text-cyan-200"
                        : "border-white/10 text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {option.key === "solo" && <User size={14} />}
                    {option.key === "friends" && <Users size={14} />}
                    {option.key === "date" && <Heart size={14} />}
                    {option.key === "any" ? "Egal" : ""}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            {!confirmReset ? (
              <button
                onClick={() => setConfirmReset(true)}
                className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-400 transition hover:border-rose-400/30 hover:text-rose-300"
              >
                <RotateCcw size={13} />
                Vorlieben zurücksetzen
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-400/5 p-3">
                <p className="min-w-40 flex-1 text-xs text-rose-200">
                  Alle Vorlieben auf die Standardwerte zurücksetzen?
                </p>
                <button
                  onClick={() => {
                    setPrefs(DEFAULT_PREFERENCES);
                    setBudgetInput(null);
                    setConfirmReset(false);
                  }}
                  className="rounded-lg bg-rose-400 px-3 py-2 text-xs font-medium text-slate-950 transition hover:bg-rose-300"
                >
                  Zurücksetzen
                </button>
                <button
                  onClick={() => setConfirmReset(false)}
                  aria-label="Abbrechen"
                  className="rounded-lg border border-white/10 p-2 text-slate-300 hover:bg-white/5"
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
