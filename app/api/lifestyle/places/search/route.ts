import { NextResponse } from "next/server";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { detectPlaceCategory } from "@/src/lib/lifestyle/intent";
import {
  CATEGORY_LABELS,
  type Place,
} from "@/src/lib/lifestyle/types";
import {
  OSM_USER_AGENT,
  OVERPASS_ENDPOINT,
  PLACE_SEARCH_CACHE_TTL_MS,
  PLACE_SEARCH_MIN_INTERVAL_MS,
  buildNominatimGeocodeUrl,
  buildNominatimUrl,
  buildOverpassQuery,
  isNominatimItem,
  isNominatimList,
  isOverpassResponse,
  isStrictMismatch,
  mapNominatimToPlaces,
  mapOverpassToPlaces,
  nominatimClass,
  parsePlaceSearchParams,
  type PlaceSearchDiagnostics,
  type PlaceSearchParams,
  type PlaceSearchPayload,
  type ResolvedLocation,
  type SearchProvider,
} from "@/src/lib/lifestyle/placesSearch";

/**
 * GET /api/lifestyle/places/search — live discovery over OpenStreetMap
 * (free, no key, no login, no user data).
 *
 * Query: `query` (text), `near` (manual area), `lat`/`lon`
 * (opt-in coordinates), `radiusKm` (1–50), `category`, `limit`.
 * At least one of query/near/coordinates is required, plus a query
 * or an explicit category.
 *
 * Provider split:
 * - free text (`query`) → Nominatim text search (soft viewbox bias);
 * - category browse (empty query + explicit category + center) →
 *   structured Overpass `around` search over category tags;
 * - `near` areas are always geocoded via Nominatim.
 *
 * Fair-use policy: a real User-Agent, serialized upstream calls with
 * a ≥1.1 s gap (one in flight at a time, both providers), a bounded
 * Overpass timeout, and a 10-minute cache, so repeated searches (and
 * the assistant) never hammer the providers.
 *
 * Nothing is ever invented: empty provider answers surface as honest
 * empty states with a `notice`, unreachable upstreams as errors. A
 * 200 with zero results is NOT success — every payload carries
 * `diagnostics` (categories, provider, cache, counts; never query
 * text, coordinates, or secrets) so callers can tell.
 */

const FETCH_TIMEOUT_MS = 8000;
const OVERPASS_FETCH_TIMEOUT_MS = 20000;

type CacheEntry = { expires: number; payload: PlaceSearchPayload };

const cache = new Map<string, CacheEntry>();
let lastUpstreamAt = 0;
let throttleChain: Promise<void> = Promise.resolve();

/** Every validated param feeds the key — no cross-param poisoning. */
function cacheKey(params: PlaceSearchParams): string {
  return JSON.stringify({
    q: params.query.toLowerCase(),
    n: params.near.toLowerCase(),
    lat: params.latitude === null ? null : params.latitude.toFixed(4),
    lon: params.longitude === null ? null : params.longitude.toFixed(4),
    r: params.radiusKm,
    c: params.category,
    l: params.limit,
  });
}

/** Serialize upstream calls with a ≥1.1 s gap (fair-use throttle). */
function throttled<T>(work: () => Promise<T>): Promise<T> {
  const run = throttleChain.then(async () => {
    const wait = PLACE_SEARCH_MIN_INTERVAL_MS - (Date.now() - lastUpstreamAt);

    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    try {
      return await work();
    } finally {
      lastUpstreamAt = Date.now();
    }
  });

  // A rejection must not wedge the chain for later requests.
  throttleChain = run.then(
    () => undefined,
    () => undefined,
  );

  return run;
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": OSM_USER_AGENT,
      Accept: "application/json",
    },
  });

  if (res.status === 429) {
    throw new Error("RATE_LIMITED");
  }

  if (!res.ok) {
    throw new Error(`UPSTREAM_${res.status}`);
  }

  return (await res.json()) as unknown;
}

async function fetchOverpass(query: string): Promise<unknown> {
  const res = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(OVERPASS_FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": OSM_USER_AGENT,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (res.status === 429) {
    throw new Error("RATE_LIMITED");
  }

  if (res.status === 504) {
    throw new Error("OVERPASS_BUSY");
  }

  if (!res.ok) {
    throw new Error(`UPSTREAM_${res.status}`);
  }

  return (await res.json()) as unknown;
}

async function geocodeNear(
  near: string,
): Promise<ResolvedLocation | null> {
  const raw = await fetchJson(
    buildNominatimGeocodeUrl(near),
    FETCH_TIMEOUT_MS,
  );

  if (!Array.isArray(raw) || raw.length === 0) return null;

  const first = raw[0];

  if (!isNominatimItem(first)) return null;

  const latitude = Number(first.lat);
  const longitude = Number(first.lon);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    label: first.display_name.split(",").slice(0, 2).join(",").trim(),
    latitude,
    longitude,
  };
}

function diagnosticsOf(
  params: PlaceSearchParams,
  detected: PlaceSearchDiagnostics["detectedCategory"],
  provider: SearchProvider,
  cacheHit: boolean,
  rawCount: number,
  filteredCount: number,
): PlaceSearchDiagnostics {
  return {
    requestedCategory: params.category,
    detectedCategory: detected,
    effectiveCategory:
      params.category !== "all" ? params.category : detected,
    provider,
    cache: cacheHit ? "hit" : "miss",
    rawCount,
    filteredCount,
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const parsed = parsePlaceSearchParams(
    new URL(request.url).searchParams,
  );

  if (!parsed.ok) {
    return fail("bad-request", parsed.error, 400);
  }

  const params = parsed.params;
  const detected = detectPlaceCategory(params.query);

  try {
    const cached = cache.get(cacheKey(params));

    if (cached !== undefined && cached.expires > Date.now()) {
      return ok({
        ...cached.payload,
        diagnostics: { ...cached.payload.diagnostics, cache: "hit" as const },
      });
    }

    const fetchedAt = new Date().toISOString();
    const hasCoords =
      params.latitude !== null && params.longitude !== null;

    // Manual area fallback: geocode `near` only when no coordinates
    // were given (opt-in prefs stay primary).
    let resolved: ResolvedLocation | null = null;

    if (!hasCoords && params.near !== "") {
      resolved = await throttled(() => geocodeNear(params.near));

      if (resolved === null) {
        const payload: PlaceSearchPayload = {
          places: [],
          resolvedLocation: null,
          centerUsed: null,
          notice: `Der Ort „${params.near}“ wurde nicht gefunden – prüfe die Schreibweise oder gib Koordinaten in den Vorlieben an.`,
          fetchedAt,
          diagnostics: diagnosticsOf(params, detected, "none", false, 0, 0),
        };

        cache.set(cacheKey(params), {
          expires: Date.now() + PLACE_SEARCH_CACHE_TTL_MS,
          payload,
        });

        return ok(payload);
      }
    }

    const centerUsed: PlaceSearchPayload["centerUsed"] =
      params.latitude !== null && params.longitude !== null
        ? { latitude: params.latitude, longitude: params.longitude }
        : resolved === null
          ? null
          : { latitude: resolved.latitude, longitude: resolved.longitude };

    // Category browse without text goes structured (Overpass); free
    // text always goes to Nominatim. The validation guarantees a
    // specific category when the query is empty.
    let places: Place[];
    let rawCount: number;
    let provider: SearchProvider;
    let mismatched = 0;

    if (
      params.query === "" &&
      params.category !== "all" &&
      centerUsed !== null
    ) {
      const category = params.category;
      const raw = await throttled(() =>
        fetchOverpass(
          buildOverpassQuery(category, centerUsed, params.radiusKm),
        ),
      );

      if (!isOverpassResponse(raw)) {
        throw new Error("UPSTREAM_SHAPE");
      }

      rawCount = raw.elements.length;
      provider = "overpass";
      places = mapOverpassToPlaces(raw.elements, {
        category,
        fetchedAt,
      }).slice(0, params.limit);
    } else {
      const raw = await throttled(() =>
        fetchJson(buildNominatimUrl(params, centerUsed), FETCH_TIMEOUT_MS),
      );

      if (!isNominatimList(raw)) {
        throw new Error("UPSTREAM_SHAPE");
      }

      rawCount = raw.length;
      provider = "nominatim";

      const kept = raw.filter((item) => {
        if (
          isStrictMismatch(nominatimClass(item), item.type, params.category)
        ) {
          mismatched += 1;
          return false;
        }

        return true;
      });

      places = mapNominatimToPlaces(kept, {
        category: params.category,
        fetchedAt,
      });
    }

    let notice: string | null = null;

    if (places.length === 0) {
      if (rawCount === 0 && provider === "overpass") {
        const label =
          params.category === "all"
            ? "Orte"
            : CATEGORY_LABELS[params.category];
        notice = `Keine ${label} im Umkreis von ${params.radiusKm} km gefunden – versuche einen größeren Umkreis oder „Alle Kategorien“.`;
      } else if (mismatched > 0 && rawCount === mismatched) {
        notice =
          params.category === "all"
            ? "Keine Treffer – versuche einen allgemeineren Suchtext oder einen größeren Umkreis."
            : `Keine Treffer in der Kategorie „${CATEGORY_LABELS[params.category]}“ – versuche „Alle Kategorien“ oder einen allgemeineren Suchtext.`;
      } else if (rawCount === 0) {
        notice =
          "Keine Treffer – versuche einen allgemeineren Suchtext oder einen größeren Umkreis.";
      } else {
        notice =
          "Die Suche lieferte nur Treffer ohne verwertbaren Namen – versuche einen anderen Suchtext.";
      }
    }

    const payload: PlaceSearchPayload = {
      places,
      resolvedLocation: resolved,
      centerUsed,
      notice,
      fetchedAt,
      diagnostics: diagnosticsOf(
        params,
        detected,
        provider,
        false,
        rawCount,
        places.length,
      ),
    };

    cache.set(cacheKey(params), {
      expires: Date.now() + PLACE_SEARCH_CACHE_TTL_MS,
      payload,
    });

    return ok(payload);
  } catch (unknown) {
    if (unknown instanceof Error && unknown.message === "RATE_LIMITED") {
      return fail(
        "upstream-error",
        "OpenStreetMap meldet zu viele Anfragen – warte kurz und versuche es erneut.",
        502,
      );
    }

    if (unknown instanceof Error && unknown.message === "OVERPASS_BUSY") {
      return fail(
        "upstream-error",
        "Die Umkreissuche ist gerade überlastet – versuche es in einer Minute erneut.",
        502,
      );
    }

    if (unknown instanceof Error && unknown.message === "UPSTREAM_SHAPE") {
      console.error("[api:lifestyle/places/search] unexpected shape");
      return fail(
        "upstream-error",
        "Die Orts-Suche lieferte unerwartete Daten.",
        502,
      );
    }

    if (
      unknown instanceof Error &&
      (unknown.name === "TimeoutError" ||
        unknown.name === "AbortError" ||
        unknown.message.startsWith("UPSTREAM_") ||
        unknown.message === "fetch failed")
    ) {
      console.error("[api:lifestyle/places/search] upstream:", unknown.message);
      return fail(
        "upstream-error",
        "Die Orts-Suche ist derzeit nicht erreichbar – versuche es später erneut.",
        502,
      );
    }

    return failFromUnknown("lifestyle/places/search", unknown);
  }
}

export function __clearPlaceSearchCacheForTests(): void {
  cache.clear();
}

export function __resetPlaceSearchThrottleForTests(): void {
  lastUpstreamAt = 0;
  throttleChain = Promise.resolve();
}
