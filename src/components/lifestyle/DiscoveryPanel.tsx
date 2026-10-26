"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Bookmark, Sparkles } from "lucide-react";
import {
  CATEGORY_LABELS,
  formatDistanceKm,
  type LifestylePreferences,
  type Place,
} from "@/src/lib/lifestyle/types";
import { recommendPlaces } from "@/src/lib/lifestyle/recommend";

export function DiscoveryPanel({
  places,
  prefs,
  loaded,
  savedIds,
  onToggleSave,
}: {
  places: Place[];
  prefs: LifestylePreferences;
  loaded: boolean;
  savedIds: string[];
  onToggleSave: (id: string) => void;
}) {
  const top = useMemo(
    () => (loaded ? recommendPlaces(places, prefs, 5) : []),
    [loaded, places, prefs],
  );

  return (
    <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
          <Sparkles size={21} />
        </div>

        <div>
          <h2 className="font-semibold">Entdecken</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Regelbasierte Vorschläge aus deinen Vorlieben – kein KI-Modell,
            jede Empfehlung ist begründet.
          </p>
        </div>
      </div>

      <div className="mt-5">
        {!loaded ? (
          <p className="text-sm text-slate-500">Vorschläge werden geladen …</p>
        ) : places.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center">
            <p className="text-sm text-slate-400">
              Noch keine Orte eingetragen.
            </p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-slate-500">
              Empfehlungen entstehen erst aus deinen eigenen Einträgen –
              es gibt hier keine erfundenen Tipps und keine externen
              Anbieter.
            </p>
            <Link
              href="#orte"
              className="mt-4 inline-block rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
            >
              Erste Orte anlegen
            </Link>
          </div>
        ) : top.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
            Keine Orte passen zu deinen aktuellen Vorlieben. Passe oben
            Kategorien, Budget oder Umkreis an.
          </div>
        ) : (
          <ul className="space-y-2">
            {top.map(({ place, reasons, distanceKm }) => {
              const saved = savedIds.includes(place.id);

              return (
                <li
                  key={place.id}
                  className="flex items-start gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-200">
                      {place.name}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      <span className="rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[10px] text-cyan-200">
                        {CATEGORY_LABELS[place.category]}
                      </span>
                      {distanceKm !== null && (
                        <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] tabular-nums text-slate-400">
                          {formatDistanceKm(distanceKm)}
                        </span>
                      )}
                    </div>
                    <ul className="mt-2 space-y-1">
                      {reasons.map((reason) => (
                        <li
                          key={reason}
                          className="text-xs leading-4 text-slate-500"
                        >
                          · {reason}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <button
                    onClick={() => onToggleSave(place.id)}
                    aria-pressed={saved}
                    aria-label={
                      saved
                        ? `Entfernen: ${place.name}`
                        : `Merken: ${place.name}`
                    }
                    title={saved ? "Entfernen" : "Merken"}
                    className={`shrink-0 rounded-lg p-2 transition ${
                      saved
                        ? "text-cyan-300 hover:text-cyan-200"
                        : "text-slate-500 hover:bg-white/5 hover:text-slate-200"
                    }`}
                  >
                    <Bookmark
                      size={16}
                      fill={saved ? "currentColor" : "none"}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="mt-4 text-xs leading-5 text-slate-600">
        Quelle: Eigene Einträge · Externe Anbieter sind nicht konfiguriert.{" "}
        <Link
          href="#datenquellen"
          className="text-slate-500 underline-offset-2 transition hover:text-cyan-200 hover:underline"
        >
          Mehr erfahren
        </Link>
      </p>
    </section>
  );
}
