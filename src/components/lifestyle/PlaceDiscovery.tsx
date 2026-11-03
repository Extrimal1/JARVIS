"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  ExternalLink,
  Plus,
  Radar,
  Search,
} from "lucide-react";
import {
  CATEGORY_LABELS,
  PLACE_CATEGORIES,
  formatDistanceKm,
  haversineKm,
  type LifestylePreferences,
  type Place,
  type PlaceCategory,
} from "@/src/lib/lifestyle/types";
import type { GeoPoint } from "@/src/lib/lifestyle/providers";
import {
  canonicalizeQuery,
  detectPlaceCategory,
} from "@/src/lib/lifestyle/intent";
import {
  GENERAL_SUGGESTIONS,
  GENERAL_SUGGESTIONS_LABEL,
  OSM_ATTRIBUTION,
  osmRefOfNotes,
  type PlaceSearchCategory,
  type PlaceSearchDiagnostics,
  type ResolvedLocation,
} from "@/src/lib/lifestyle/placesSearch";
import { searchLivePlaces } from "@/src/lib/lifestyle/searchClient";

const RESULT_LIMIT = 10;

function isSearchCategoryValue(
  value: string | null,
): value is PlaceSearchCategory {
  return (
    value === "all" ||
    (PLACE_CATEGORIES as readonly string[]).includes(value ?? "")
  );
}

/** Shareable-URL params (client only; SSR-safe no-op on the server). */
function readSearchParams(): {
  query: string;
  near: string | null;
  category: PlaceSearchCategory | null;
} {
  if (typeof window === "undefined") {
    return { query: "", near: null, category: null };
  }

  const params = new URL(window.location.href).searchParams;
  const category = params.get("sucheKategorie");

  return {
    query: (params.get("suche") ?? "").slice(0, 200),
    near: params.get("ort"),
    category: isSearchCategoryValue(category) ? category : null,
  };
}

function mapUrl(place: Place): string | null {
  if (place.latitude !== null && place.longitude !== null) {
    return `https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=16/${place.latitude}/${place.longitude}`;
  }

  if (place.address.trim() !== "") {
    return `https://www.openstreetmap.org/search?query=${encodeURIComponent(place.address.trim())}`;
  }

  return null;
}

function distanceOf(
  place: Place,
  center: GeoPoint | null,
): number | null {
  if (
    center === null ||
    place.latitude === null ||
    place.longitude === null
  ) {
    return null;
  }

  return haversineKm(
    center.latitude,
    center.longitude,
    place.latitude,
    place.longitude,
  );
}

/**
 * Live place discovery over OpenStreetMap (server route
 * /api/lifestyle/places/search: Nominatim for text, Overpass for
 * category browse). Uses the opt-in coordinates from the preferences
 * when set, otherwise a manual area (`near`, prefilled with the
 * stored city). The category select is explicit; in Auto mode the
 * intent is detected from the query text ("Kinoabend" → Kino &
 * Unterhaltung) and resets whenever the intent changes — ambiguous
 * input always falls back to "Alle Kategorien", never to a forced
 * guess. Search state syncs to shareable URL params.
 * Live hits are badged "Live" and stay visually distinct from stored
 * places; adopting one creates a real stored copy (fresh id) and
 * saves it. When live search fails or finds nothing, a clearly
 * labeled general-ideas fallback shows — never invented places,
 * addresses, ratings, or hours.
 */
export function PlaceDiscovery({
  prefs,
  places,
  savedIds,
  onAdoptLive,
  onToggleSave,
}: {
  prefs: LifestylePreferences;
  /** Stored places (adopt matching + saved state). */
  places: Place[];
  savedIds: string[];
  /**
   * Materialize a live hit as a stored place and save it. Resolves
   * to the stored id, or null when storing failed.
   */
  onAdoptLive: (live: Place) => Promise<string | null>;
  onToggleSave: (id: string) => void;
}) {
  const [initialUrl] = useState(readSearchParams);
  const [query, setQuery] = useState(initialUrl.query);
  const [near, setNear] = useState(initialUrl.near ?? prefs.city);
  const [nearTouched, setNearTouched] = useState(initialUrl.near !== null);
  const [category, setCategory] = useState<PlaceSearchCategory>(
    initialUrl.category ?? "all",
  );
  const [categoryMode, setCategoryMode] = useState<"auto" | "manual">(
    initialUrl.category === null ? "auto" : "manual",
  );
  const [results, setResults] = useState<Place[]>([]);
  const [resolved, setResolved] = useState<ResolvedLocation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] =
    useState<PlaceSearchDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [adoptingId, setAdoptingId] = useState<string | null>(null);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  const requestId = useRef(0);

  /** Intent detected from the query; ambiguous input stays broad. */
  const detected = useMemo(() => detectPlaceCategory(query), [query]);

  // Auto mode: follow the detected intent, resetting whenever it
  // changes (clearing the query resets to "Alle Kategorien").
  useEffect(() => {
    if (categoryMode !== "auto") return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCategory(detected);
  }, [categoryMode, detected]);

  // Prefill the manual area with the stored city until edited.
  useEffect(() => {
    if (!nearTouched) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNear(prefs.city);
    }
  }, [nearTouched, prefs.city]);

  /** Keep the search shareable via URL params (no navigation). */
  function syncUrl(next: {
    query: string;
    near: string;
    category: PlaceSearchCategory;
  }) {
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);

    if (next.query.trim() === "") {
      url.searchParams.delete("suche");
    } else {
      url.searchParams.set("suche", next.query.trim());
    }

    if (next.near.trim() === "") {
      url.searchParams.delete("ort");
    } else {
      url.searchParams.set("ort", next.near.trim());
    }

    if (next.category === "all") {
      url.searchParams.delete("sucheKategorie");
    } else {
      url.searchParams.set("sucheKategorie", next.category);
    }

    window.history.replaceState(null, "", url.toString());
  }

  const prefsCenter: GeoPoint | null =
    prefs.useGeolocation &&
    prefs.latitude !== null &&
    prefs.longitude !== null
      ? { latitude: prefs.latitude, longitude: prefs.longitude }
      : null;

  const distanceCenter: GeoPoint | null =
    prefsCenter ??
    (resolved === null
      ? null
      : { latitude: resolved.latitude, longitude: resolved.longitude });

  async function runSearch(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    const token = (requestId.current += 1);
    setLoading(true);
    setError(null);
    setNotice(null);
    setDiagnostics(null);
    setAdoptError(null);

    // In Auto mode the search uses the freshly detected intent even
    // if the state update above has not flushed yet.
    const effectiveCategory =
      categoryMode === "auto" ? detected : category;
    const effectiveQuery = canonicalizeQuery(query);
    const effectiveNear = prefsCenter === null ? near : "";

    syncUrl({
      query: effectiveQuery,
      near: effectiveNear,
      category: effectiveCategory,
    });

    const result = await searchLivePlaces({
      query: effectiveQuery,
      near: effectiveNear,
      latitude: prefsCenter?.latitude ?? null,
      longitude: prefsCenter?.longitude ?? null,
      radiusKm: prefs.radiusKm,
      category: effectiveCategory,
      limit: RESULT_LIMIT,
    });

    if (requestId.current !== token) return;

    setLoading(false);
    setSearched(true);

    if (!result.ok) {
      setResults([]);
      setResolved(null);
      setDiagnostics(null);
      setError(result.error);
      return;
    }

    setResults(result.places);
    setResolved(result.resolvedLocation);
    setNotice(result.notice);
    setDiagnostics(result.diagnostics);
  }

  function storedFor(live: Place): Place | undefined {
    const ref = osmRefOfNotes(live.notes);

    if (ref === null) return undefined;

    return places.find((place) => osmRefOfNotes(place.notes) === ref);
  }

  async function adopt(live: Place) {
    setAdoptError(null);
    setAdoptingId(live.id);

    const storedId = await onAdoptLive(live);

    setAdoptingId(null);

    if (storedId === null) {
      setAdoptError(
        `„${live.name}“ konnte nicht übernommen werden – versuche es erneut.`,
      );
    }
  }

  const showFallback =
    searched && !loading && (error !== null || results.length === 0);

  return (
    <section
      id="live-suche"
      aria-label="Orte live suchen"
      className="scroll-mt-4 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
          <Radar size={21} />
        </div>

        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Orte live suchen</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Echte Suche über OpenStreetMap – mit Adressen und Koordinaten
            vom Anbieter. Es werden keine Bewertungen, Preise oder
            Öffnungszeiten erfunden.
          </p>
          <p className="mt-2 text-xs text-slate-500">
            {prefsCenter === null ? (
              <>
                Suche rund um{" "}
                <span className="text-slate-300">
                  {near.trim() === "" ? "– bitte Ort angeben –" : near.trim()}
                </span>{" "}
                · Umkreis {prefs.radiusKm} km (aus den Vorlieben)
              </>
            ) : (
              <>
                Suche rund um deinen gespeicherten Standort · Umkreis{" "}
                {prefs.radiusKm} km (aus den Vorlieben)
              </>
            )}
          </p>
        </div>
      </div>

      <form
        onSubmit={(event) => void runSearch(event)}
        className="mt-5 flex flex-wrap items-center gap-2"
      >
        <div className="relative min-w-40 flex-1">
          <Search
            size={15}
            aria-hidden="true"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            value={query}
            onChange={(change) => setQuery(change.target.value)}
            placeholder="Wonach suchst du? z. B. Café, Museum, Spielplatz"
            aria-label="Live-Suchtext"
            maxLength={200}
            className="w-full rounded-xl border border-white/10 bg-black/20 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
          />
        </div>

        {prefsCenter === null && (
          <input
            value={near}
            onChange={(change) => {
              setNear(change.target.value);
              setNearTouched(true);
            }}
            placeholder="Ort, z. B. Leipzig"
            aria-label="Suchumgebung"
            maxLength={200}
            className="min-w-32 flex-1 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
          />
        )}

        <select
          value={category}
          onChange={(change) => {
            setCategory(change.target.value as PlaceSearchCategory);
            setCategoryMode("manual");
          }}
          aria-label="Kategorie für die Live-Suche"
          className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-xs text-white outline-none focus:border-cyan-300/50"
        >
          <option value="all">Alle Kategorien</option>
          {PLACE_CATEGORIES.map((item: PlaceCategory) => (
            <option key={item} value={item}>
              {CATEGORY_LABELS[item]}
            </option>
          ))}
        </select>

        <button
          type="submit"
          disabled={loading}
          className="rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:opacity-50"
        >
          {loading ? "Sucht …" : "Suchen"}
        </button>
      </form>

      <div className="mt-2 min-h-5 text-xs" aria-live="polite">
        {categoryMode === "auto" ? (
          detected === "all" ? (
            <span className="text-slate-600">
              Auto-Kategorie: Alle Kategorien (Suchtext ist mehrdeutig)
            </span>
          ) : (
            <span className="text-slate-500">
              Auto-Kategorie: {CATEGORY_LABELS[detected]} (aus Suchtext
              erkannt)
            </span>
          )
        ) : (
          <span className="text-slate-500">
            Manuell:{" "}
            {category === "all" ? "Alle Kategorien" : CATEGORY_LABELS[category]}{" "}
            <button
              type="button"
              onClick={() => {
                setCategoryMode("auto");
                setCategory(detected);
              }}
              className="underline decoration-dotted underline-offset-2 transition hover:text-cyan-200"
            >
              Automatisch erkennen
            </button>
          </span>
        )}
      </div>

      <div className="mt-4">
        {!searched && !loading ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
            Starte oben eine Suche – Treffer erscheinen hier mit Adresse,
            Entfernung und Kartenlink.
          </div>
        ) : loading && results.length === 0 ? (
          <p aria-live="polite" className="text-sm text-slate-500">
            Live-Suche läuft …
          </p>
        ) : error !== null ? (
          <div
            role="alert"
            className="rounded-2xl border border-rose-400/25 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"
          >
            {error}
          </div>
        ) : (
          <>
            {resolved !== null && (
              <p role="status" className="text-xs text-slate-500">
                Suchumgebung: {resolved.label}
              </p>
            )}
            {diagnostics !== null && (
              <p className="mt-1 text-[11px] text-slate-600">
                Live ·{" "}
                {diagnostics.provider === "overpass"
                  ? "Overpass-Umkreissuche"
                  : diagnostics.provider === "nominatim"
                    ? "Nominatim-Textsuche"
                    : "keine Anbietersuche"}
                {diagnostics.provider !== "none" &&
                  ` · ${diagnostics.filteredCount} von ${diagnostics.rawCount} Treffern`}
              </p>
            )}
            {notice !== null && results.length > 0 && (
              <p role="status" className="mt-1 text-xs text-slate-500">
                {notice}
              </p>
            )}

            {results.length === 0 ? (
              <div className="mt-2 rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                {notice ??
                  "Keine Treffer – versuche einen allgemeineren Suchtext."}
              </div>
            ) : (
              <ul className="mt-3 space-y-2">
                {results.map((place) => {
                  const stored = storedFor(place);
                  const saved =
                    stored !== undefined && savedIds.includes(stored.id);
                  const distance = distanceOf(place, distanceCenter);
                  const map = mapUrl(place);

                  return (
                    <li
                      key={place.id}
                      className="jarvis-lift rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-slate-200">
                            {place.name}
                          </p>
                          <div className="mt-1.5 flex flex-wrap gap-2">
                            <span className="rounded-full bg-emerald-300/[0.10] px-2 py-1 text-[10px] font-medium text-emerald-200">
                              Live
                            </span>
                            <span className="rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[10px] text-cyan-200">
                              {CATEGORY_LABELS[place.category]}
                            </span>
                            {distance !== null && (
                              <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] tabular-nums text-slate-400">
                                {formatDistanceKm(distance)}
                              </span>
                            )}
                          </div>

                          {place.address !== "" ? (
                            <p className="mt-2 break-words text-xs text-slate-500">
                              {place.address}
                            </p>
                          ) : (
                            <p className="mt-2 text-xs italic text-slate-600">
                              Adresse nicht angegeben
                            </p>
                          )}
                          {place.openingHours !== "" && (
                            <p className="mt-1 break-words text-xs text-slate-500">
                              {place.openingHours} (laut OpenStreetMap,
                              unbestätigt)
                            </p>
                          )}
                          <p className="mt-2 text-[10px] text-slate-600">
                            Live · OpenStreetMap · {OSM_ATTRIBUTION}
                          </p>
                        </div>

                        <div className="flex shrink-0 gap-1">
                          {stored === undefined ? (
                            <button
                              onClick={() => void adopt(place)}
                              disabled={adoptingId === place.id}
                              aria-label={`Übernehmen und merken: ${place.name}`}
                              title="Übernehmen und merken"
                              className="flex items-center gap-1 rounded-lg px-2 py-2 text-xs text-slate-300 transition hover:bg-white/5 hover:text-cyan-200 disabled:opacity-50"
                            >
                              <Plus size={15} />
                              <span className="hidden sm:inline">
                                {adoptingId === place.id
                                  ? "Wird übernommen …"
                                  : "Merken"}
                              </span>
                            </button>
                          ) : (
                            <button
                              onClick={() => onToggleSave(stored.id)}
                              aria-pressed={saved}
                              aria-label={
                                saved
                                  ? `Entfernen: ${place.name}`
                                  : `Merken: ${place.name}`
                              }
                              title={
                                saved
                                  ? "Aus gemerkten Orten entfernen (Eintrag bleibt unter „Orte“)"
                                  : "Merken"
                              }
                              className={`rounded-lg p-2 transition ${
                                saved
                                  ? "text-cyan-300 hover:text-cyan-200"
                                  : "text-slate-500 hover:bg-white/5 hover:text-slate-200"
                              }`}
                            >
                              <Bookmark
                                size={15}
                                fill={saved ? "currentColor" : "none"}
                              />
                            </button>
                          )}
                          {map !== null && (
                            <a
                              href={map}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Karte öffnen: ${place.name}`}
                              title="In OpenStreetMap öffnen"
                              className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                            >
                              <ExternalLink size={15} />
                            </a>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {adoptError !== null && (
          <p role="alert" className="mt-3 text-xs text-rose-300">
            {adoptError}
          </p>
        )}

        {showFallback && (
          <div className="mt-4 rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4">
            <p className="text-xs font-medium text-slate-300">
              {GENERAL_SUGGESTIONS_LABEL}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-slate-600">
              Die Live-Suche hat keine verwertbaren Treffer geliefert –
              diese allgemeinen Ideen ersetzen keine echten Adressen.
            </p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {GENERAL_SUGGESTIONS.map((idea) => (
                <li
                  key={idea.title}
                  className="rounded-xl border border-white/[0.05] px-3 py-2.5"
                >
                  <p className="text-xs font-medium text-slate-200">
                    {idea.title}
                  </p>
                  <p className="mt-1 text-[11px] leading-4 text-slate-500">
                    {idea.hint}
                  </p>
                  <p className="mt-1.5 text-[10px] text-cyan-200/70">
                    {CATEGORY_LABELS[idea.category]}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <p className="mt-4 text-xs leading-5 text-slate-600">
        Quelle: Live-Suche via Nominatim (Text) und Overpass
        (Kategorie-Umkreis) · {OSM_ATTRIBUTION} (ODbL) · Übernommene
        Orte landen mit Quellenangabe unter „Orte“.
      </p>
    </section>
  );
}
