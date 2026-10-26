"use client";

import { useRef } from "react";
import Link from "next/link";
import { ArrowLeft, Bookmark } from "lucide-react";
import Sidebar from "@/src/components/Sidebar";
import { DiscoveryPanel } from "@/src/components/lifestyle/DiscoveryPanel";
import { EventsPanel } from "@/src/components/lifestyle/EventsPanel";
import { PlacesPanel } from "@/src/components/lifestyle/PlacesPanel";
import { PlannerPanel } from "@/src/components/lifestyle/PlannerPanel";
import { PreferencesPanel } from "@/src/components/lifestyle/PreferencesPanel";
import {
  usePlaces,
  usePrefs,
  useSavedIds,
} from "@/src/lib/db/useModules";
import {
  CATEGORY_LABELS,
  formatDistanceKm,
  haversineKm,
  type LifestylePreferences,
  type Place,
} from "@/src/lib/lifestyle/types";
import type { GeoPoint } from "@/src/lib/lifestyle/providers";

export default function LifestylePage() {
  const placesStore = usePlaces();
  const places = placesStore.items;
  const prefsStore = usePrefs();
  const prefs = prefsStore.data;
  const savedStore = useSavedIds();
  const savedIds = savedStore.ids;
  const placesLoaded = !placesStore.loading;
  const prefsLoaded = !prefsStore.loading;
  const prefsPending = useRef<LifestylePreferences | null>(null);
  const prefsFlushing = useRef(false);

  const center: GeoPoint | null =
    prefs.useGeolocation &&
    prefs.latitude !== null &&
    prefs.longitude !== null
      ? { latitude: prefs.latitude, longitude: prefs.longitude }
      : null;

  async function toggleSave(id: string) {
    if (savedIds.includes(id)) {
      await savedStore.unsave(id);
    } else {
      await savedStore.save(id);
    }
  }

  /** Trailing-flush: rapid slider drags must not lose the last value. */
  async function savePrefs(next: LifestylePreferences) {
    prefsPending.current = next;

    if (prefsFlushing.current) return;

    prefsFlushing.current = true;

    try {
      while (prefsPending.current !== null) {
        const latest = prefsPending.current;
        prefsPending.current = null;
        await prefsStore.save(latest);
      }
    } finally {
      prefsFlushing.current = false;
    }
  }

  async function createPlace(place: Place) {
    return placesStore.create(place);
  }

  async function updatePlace(id: string, patch: Partial<Place>) {
    return placesStore.update(id, patch);
  }

  async function deletePlace(id: string) {
    await placesStore.remove(id);
    await savedStore.unsave(id);
  }

  const savedPlaces = places.filter((place) => savedIds.includes(place.id));
  const mode = placesStore.mode;

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
            <p className="text-sm tracking-wide text-cyan-300">FREIZEIT</p>

            <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">
              Ideen für deine Freizeit
            </h1>

            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              Orte entdecken, Veranstaltungen im Blick behalten und
              Ausflüge planen – auf Basis deiner eigenen Einträge und
              Vorlieben.
            </p>
          </header>

          <div className="mt-8 space-y-5">
            <PreferencesPanel
              prefs={prefs}
              onSave={(next) => void savePrefs(next)}
              loading={!prefsLoaded}
              error={prefsStore.error}
              onRetry={() => void prefsStore.refresh()}
              mode={mode}
            />

            <DiscoveryPanel
              places={places}
              prefs={prefs}
              loaded={placesLoaded && prefsLoaded}
              savedIds={savedIds}
              onToggleSave={toggleSave}
            />

            <section
              aria-label="Gemerkte Orte"
              className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
                  <Bookmark size={21} />
                </div>

                <div>
                  <h2 className="font-semibold">Gemerkte Orte</h2>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Deine Favoriten für später –{" "}
                    {mode === "cloud"
                      ? "geräteübergreifend synchronisiert."
                      : "lokal gespeichert."}
                  </p>
                  <p className="mt-2 text-xs text-cyan-300">
                    {savedPlaces.length}{" "}
                    {savedPlaces.length === 1 ? "Ort" : "Orte"}
                  </p>
                </div>
              </div>

              <div className="mt-5">
                {!placesLoaded ? (
                  <p className="text-sm text-slate-500">
                    Wird geladen …
                  </p>
                ) : savedPlaces.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                    Noch nichts gemerkt. Tippe bei einem Ort auf das
                    Lesezeichen, um ihn hier zu sammeln.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {savedPlaces.map((place) => {
                      const distance =
                        center !== null &&
                        place.latitude !== null &&
                        place.longitude !== null
                          ? haversineKm(
                              center.latitude,
                              center.longitude,
                              place.latitude,
                              place.longitude,
                            )
                          : null;

                      return (
                        <li
                          key={place.id}
                          className="flex items-center gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] px-4 py-3"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                            {place.name}
                          </span>
                          <span className="hidden shrink-0 rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[10px] text-cyan-200 sm:block">
                            {CATEGORY_LABELS[place.category]}
                          </span>
                          {distance !== null && (
                            <span className="shrink-0 text-xs tabular-nums text-slate-500">
                              {formatDistanceKm(distance)}
                            </span>
                          )}
                          <button
                            onClick={() => toggleSave(place.id)}
                            aria-label={`Entfernen: ${place.name}`}
                            title="Entfernen"
                            className="shrink-0 rounded-lg p-2 text-cyan-300 transition hover:text-cyan-200"
                          >
                            <Bookmark size={15} fill="currentColor" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>

            <PlacesPanel
              places={places}
              loading={!placesLoaded}
              error={placesStore.error}
              onRetry={() => void placesStore.refresh()}
              onCreate={createPlace}
              onUpdate={updatePlace}
              onDelete={deletePlace}
              savedIds={savedIds}
              onToggleSave={toggleSave}
              center={center}
            />

            <EventsPanel />

            <PlannerPanel places={places} />

            <details
              id="datenquellen"
              className="scroll-mt-4 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
            >
              <summary className="cursor-pointer text-sm font-semibold text-slate-200">
                Datenquellen & Hinweise
              </summary>

              <div className="mt-3 space-y-3 text-xs leading-5 text-slate-400">
                <p>
                  <span className="font-medium text-slate-200">
                    Aktiv: Eigene Einträge.
                  </span>{" "}
                  Alle Orte, Veranstaltungen und Pläne auf dieser Seite
                  stammen von dir und liegen{" "}
                  {mode === "cloud"
                    ? "in deinem privaten Cloud-Bereich."
                    : "nur lokal in deinem Browser."}{" "}
                  Angaben wie Öffnungszeiten oder Preise sind nicht
                  verifiziert – bitte prüfe sie beim Anbieter, bevor du
                  losgehst.
                </p>
                <p>
                  <span className="font-medium text-slate-200">
                    Nicht konfiguriert:
                  </span>{" "}
                  externe Orts- und Event-Anbieter. Es werden keine
                  Geschäfte, Öffnungszeiten, Preise, Bewertungen oder
                  Ticketverfügbarkeiten erfunden oder als live
                  dargestellt.
                </p>
                <div>
                  <p className="font-medium text-slate-200">
                    Mögliche Quellen für später (nicht angebunden):
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    <li>
                      OpenStreetMap (Nominatim-Suche, Overpass-API) –
                      frei nutzbar im Fair-Use-Rahmen mit
                      Quellenangabe, kein Schlüssel nötig. Geeignet für
                      Adresssuche und Points of Interest.
                    </li>
                    <li>
                      Kommerzielle Orts-APIs (z. B. Google Places,
                      Foursquare) – erfordern in der Regel
                      kostenpflichtige API-Schlüssel und Abrechnung;
                      Schlüssel müssten serverseitig in einer API-Route
                      liegen, niemals im Client.
                    </li>
                    <li>
                      Event-APIs (z. B. Ticketmaster Discovery,
                      Eventbrite) – erfordern Schlüssel und die
                      Einhaltung der Nutzungsbedingungen; kein
                      Scraping.
                    </li>
                    <li>
                      Wetter (z. B. Open-Meteo, frei ohne Schlüssel) –
                      denkbar für Ausflugshinweise; derzeit nicht
                      angebunden, keine Vorhersagen vorhanden.
                    </li>
                  </ul>
                </div>
                <p>
                  Es werden keine Fahr- oder Gehzeiten berechnet, da
                  keine verlässliche Routing-Quelle angebunden ist.
                </p>
              </div>
            </details>
          </div>

          <footer className="py-8 text-center text-xs text-slate-600">
            J.A.R.V.I.S. · Freizeit ·{" "}
            {mode === "cloud" ? "Cloud-Synchronisierung" : "Lokale Speicherung"}
          </footer>
        </section>
      </div>
    </main>
  );
}
