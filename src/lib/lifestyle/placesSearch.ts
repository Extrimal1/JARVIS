import {
  PLACE_CATEGORIES,
  type Place,
  type PlaceCategory,
} from "./types";

/**
 * Live place discovery over OpenStreetMap (free, no key).
 *
 * Pure, client-safe module: request validation, provider query
 * building, provider-to-`Place` mapping, diagnostics types, and the
 * labeled general-suggestion fallback. Provider split:
 * - Nominatim: free-text search and `near`-area geocoding;
 * - Overpass: structured category search around a center point.
 * The actual HTTP calls live server-side in
 * `app/api/lifestyle/places/search/route.ts` (User-Agent, throttling,
 * caching per the provider usage policies); the browser only talks
 * to that route via `./searchClient`.
 *
 * Honesty rules (never invent provider data):
 * - name/address/coordinates come verbatim from the provider;
 * - cost, duration, and setting stay null (unknown);
 * - opening hours are copied ONLY from the provider's
 *   `opening_hours` tag (`extratags` on Nominatim);
 * - ratings, prices, and availability do not exist in this module;
 * - the general-suggestion fallback is always labeled as such and
 *   carries no addresses, coordinates, or opening hours.
 */

export const OSM_PROVIDER_ID = "osm-nominatim";
export const OSM_SOURCE_LABEL = "OpenStreetMap (live)";
export const OSM_ATTRIBUTION = "© OpenStreetMap-Mitwirkende";

/** Nominatim fair-use callers identify themselves; see the API route. */
export const OSM_USER_AGENT = "jarvis-lifestyle-places/1 (+local)";

export const PLACE_SEARCH_DEFAULT_LIMIT = 10;
export const PLACE_SEARCH_MAX_LIMIT = 20;
export const PLACE_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
/** Nominatim usage policy: at most one request per second. */
export const PLACE_SEARCH_MIN_INTERVAL_MS = 1100;

export type PlaceSearchCategory = PlaceCategory | "all";

export type PlaceSearchParams = {
  /** Free text, "" when the search is category/area based. */
  query: string;
  /** Manual area fallback (e.g. prefs.city), "" when unset. */
  near: string;
  latitude: number | null;
  longitude: number | null;
  radiusKm: number;
  category: PlaceSearchCategory;
  limit: number;
};

export type ResolvedLocation = {
  label: string;
  latitude: number;
  longitude: number;
};

/**
 * Which upstream answered a search. `none` means no provider search
 * ran (e.g. the manual area could not be geocoded).
 */
export type SearchProvider = "nominatim" | "overpass" | "none";

/**
 * Diagnostic metadata for every search response. Categories and
 * counts only — never query text, coordinates, URLs, or secrets.
 * `rawCount` is the provider hit count before mapping/filtering,
 * `filteredCount` the returned places (always `places.length`).
 * A 200 with zero results is NOT success: callers must render the
 * honest empty state (`notice`) instead of celebrating.
 */
export type PlaceSearchDiagnostics = {
  requestedCategory: PlaceSearchCategory;
  /** Intent detected from the query text (`all` = broad/ambiguous). */
  detectedCategory: PlaceSearchCategory;
  /** Category routing/labeling actually used. */
  effectiveCategory: PlaceSearchCategory;
  provider: SearchProvider;
  cache: "hit" | "miss";
  rawCount: number;
  filteredCount: number;
};

export type PlaceSearchPayload = {
  places: Place[];
  /** Geocoded `near` text (null when coordinates came from prefs). */
  resolvedLocation: ResolvedLocation | null;
  /** Center the provider search actually used (null = global text). */
  centerUsed: { latitude: number; longitude: number } | null;
  /** Honest hint (e.g. area not found); null when nothing to say. */
  notice: string | null;
  fetchedAt: string;
  diagnostics: PlaceSearchDiagnostics;
};

const QUERY_MAX = 200;

function isLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

function isLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}

function isSearchCategory(value: unknown): value is PlaceSearchCategory {
  return (
    value === "all" ||
    (typeof value === "string" &&
      (PLACE_CATEGORIES as readonly string[]).includes(value))
  );
}

/** Validate raw query params; German messages go straight to the UI. */
export function parsePlaceSearchParams(
  input: URLSearchParams,
): { ok: true; params: PlaceSearchParams } | { ok: false; error: string } {
  const query = (input.get("query") ?? "").trim().slice(0, QUERY_MAX);
  const near = (input.get("near") ?? "").trim().slice(0, QUERY_MAX);
  const latRaw = (input.get("lat") ?? "").trim().replace(",", ".");
  const lonRaw = (input.get("lon") ?? "").trim().replace(",", ".");
  const radiusRaw = (input.get("radiusKm") ?? "").trim();
  const categoryRaw = (input.get("category") ?? "all").trim();
  const limitRaw = (input.get("limit") ?? "").trim();

  let latitude: number | null = null;
  let longitude: number | null = null;

  if (latRaw !== "" || lonRaw !== "") {
    const lat = latRaw === "" ? NaN : Number(latRaw);
    const lon = lonRaw === "" ? NaN : Number(lonRaw);

    if (!isLatitude(lat) || !isLongitude(lon)) {
      return { ok: false, error: "Die Koordinaten sind ungültig." };
    }

    latitude = lat;
    longitude = lon;
  }

  let radiusKm = 10;

  if (radiusRaw !== "") {
    const parsed = Number(radiusRaw);

    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 50) {
      return {
        ok: false,
        error: "Der Umkreis muss zwischen 1 und 50 km liegen.",
      };
    }

    radiusKm = parsed;
  }

  if (!isSearchCategory(categoryRaw)) {
    return { ok: false, error: "Die Kategorie ist ungültig." };
  }

  let limit = PLACE_SEARCH_DEFAULT_LIMIT;

  if (limitRaw !== "") {
    const parsed = Number(limitRaw);

    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > PLACE_SEARCH_MAX_LIMIT
    ) {
      return {
        ok: false,
        error: `Die Trefferzahl muss zwischen 1 und ${PLACE_SEARCH_MAX_LIMIT} liegen.`,
      };
    }

    limit = parsed;
  }

  if (query === "" && latitude === null && near === "") {
    return {
      ok: false,
      error:
        "Bitte gib einen Suchtext oder einen Ort an – ohne Anhaltspunkt kann nicht gesucht werden.",
    };
  }

  if (query === "" && categoryRaw === "all") {
    return {
      ok: false,
      error:
        "Bitte gib einen Suchtext oder eine Kategorie an – sonst ist unklar, wonach gesucht werden soll.",
    };
  }

  return {
    ok: true,
    params: {
      query,
      near,
      latitude,
      longitude,
      radiusKm,
      category: categoryRaw,
      limit,
    },
  };
}

// ------------------------------------------------------------- Nominatim

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";

/** Best-effort German keywords when the search has no query text. */
const CATEGORY_KEYWORDS: Record<PlaceCategory, string> = {
  nature: "Park",
  food: "Restaurant",
  culture: "Museum",
  sport: "Sportanlage",
  cinema: "Kino",
  date: "Café",
  free: "Spielplatz",
};

function viewboxFor(
  latitude: number,
  longitude: number,
  radiusKm: number,
): string {
  const latDelta = radiusKm / 111;
  const lonDelta =
    radiusKm / (111 * Math.max(0.2, Math.cos((latitude * Math.PI) / 180)));
  const left = Math.max(-180, longitude - lonDelta);
  const right = Math.min(180, longitude + lonDelta);
  const top = Math.min(90, latitude + latDelta);
  const bottom = Math.max(-90, latitude - latDelta);

  return `${left.toFixed(5)},${top.toFixed(5)},${right.toFixed(5)},${bottom.toFixed(5)}`;
}

/**
 * Build the provider URL for validated params. `center` is the
 * geocoded `near` area (null when prefs coordinates or no area).
 * Pure and deterministic for tests.
 */
export function buildNominatimUrl(
  params: PlaceSearchParams,
  center: { latitude: number; longitude: number } | null,
): string {
  const text =
    params.query !== ""
      ? params.query
      : params.category === "all"
        ? ""
        : CATEGORY_KEYWORDS[params.category];
  const url = new URL(NOMINATIM_BASE);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("extratags", "1");
  url.searchParams.set("namedetails", "0");
  url.searchParams.set("limit", String(params.limit));
  url.searchParams.set("accept-language", "de");
  url.searchParams.set("q", text);

  const boxCenter =
    params.latitude !== null && params.longitude !== null
      ? { latitude: params.latitude, longitude: params.longitude }
      : center;

  if (boxCenter !== null) {
    url.searchParams.set(
      "viewbox",
      viewboxFor(boxCenter.latitude, boxCenter.longitude, params.radiusKm),
    );
    // Soft bias, not a hard fence: relevant hits outside the box
    // still show instead of an honest-but-empty result.
    url.searchParams.set("bounded", "0");
  }

  return url.toString();
}

/** Geocode URL for a manual area string (`near`). */
export function buildNominatimGeocodeUrl(near: string): string {
  const url = new URL(NOMINATIM_BASE);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("extratags", "0");
  url.searchParams.set("namedetails", "0");
  url.searchParams.set("limit", "1");
  url.searchParams.set("accept-language", "de");
  url.searchParams.set("q", near);

  return url.toString();
}

export type NominatimItem = {
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  display_name: string;
  /**
   * OSM object class: `class` in `format=json`, `category` in
   * `format=jsonv2` (what the app requests). At least one is a
   * string on every accepted item; use nominatimClass().
   */
  class?: unknown;
  category?: unknown;
  type: string;
  name?: unknown;
  extratags?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isNominatimItem(value: unknown): value is NominatimItem {
  if (!isRecord(value)) return false;

  return (
    typeof value.osm_type === "string" &&
    typeof value.osm_id === "number" &&
    typeof value.lat === "string" &&
    typeof value.lon === "string" &&
    typeof value.display_name === "string" &&
    (typeof value.class === "string" ||
      typeof value.category === "string") &&
    typeof value.type === "string"
  );
}

/**
 * Effective OSM class across both Nominatim shapes (`class` in
 * `format=json`, `category` in `format=jsonv2`). Empty only for
 * unvalidated input; accepted items always carry one of them.
 */
export function nominatimClass(item: NominatimItem): string {
  if (typeof item.class === "string") return item.class;
  if (typeof item.category === "string") return item.category;

  return "";
}

export function isNominatimList(value: unknown): value is NominatimItem[] {
  return Array.isArray(value) && value.every(isNominatimItem);
}

function extraString(extratags: unknown, key: string): string {
  if (!isRecord(extratags)) return "";

  const value = extratags[key];

  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

/**
 * Strict mapping from OSM class/type to the app's interest taxonomy.
 * Returns null when the tags say nothing about the taxonomy — no
 * guessing, in particular never a forced `nature`.
 */
export function strictOsmCategory(
  osmClass: string,
  osmType: string,
): PlaceCategory | null {
  const cls = osmClass.toLowerCase();
  const type = osmType.toLowerCase();

  if (type === "cinema") return "cinema";
  if (cls === "natural") return "nature";
  if (cls === "historic") return "culture";
  if (cls === "sport") return "sport";

  if (cls === "amenity") {
    if (
      type === "cafe" ||
      type === "restaurant" ||
      type === "fast_food" ||
      type === "ice_cream" ||
      type === "biergarten" ||
      type === "bar" ||
      type === "pub" ||
      type === "food_court"
    ) {
      return "food";
    }

    if (
      type === "theatre" ||
      type === "arts_centre" ||
      type === "library" ||
      type === "place_of_worship" ||
      type === "community_centre"
    ) {
      return "culture";
    }

    if (
      type === "gym" ||
      type === "sports_centre" ||
      type === "swimming_pool" ||
      type === "playground"
    ) {
      return "sport";
    }

    return null;
  }

  if (cls === "leisure") {
    if (
      type === "park" ||
      type === "garden" ||
      type === "nature_reserve" ||
      type === "playground" ||
      type === "picnic_table" ||
      type === "bird_hide"
    ) {
      return "nature";
    }

    if (
      type === "sports_centre" ||
      type === "pitch" ||
      type === "swimming_pool" ||
      type === "swimming_area" ||
      type === "miniature_golf" ||
      type === "golf_course" ||
      type === "stadium" ||
      type === "fitness_centre" ||
      type === "track"
    ) {
      return "sport";
    }

    return null;
  }

  if (cls === "tourism") {
    if (type === "hotel" || type === "guest_house" || type === "hostel") {
      return null;
    }

    return "culture";
  }

  if (cls === "shop" && (type === "books" || type === "gift")) {
    return "culture";
  }

  return null;
}

/**
 * Best-effort mapping from OSM class/type to the app's interest
 * taxonomy. Categories are suggestions for filtering, never factual
 * provider claims; unknown types fall back to the requested category
 * (or the generic sightseeing bucket `culture`).
 */
export function mapOsmCategory(
  osmClass: string,
  osmType: string,
  requested: PlaceSearchCategory,
): PlaceCategory {
  const strict = strictOsmCategory(osmClass, osmType);

  if (strict !== null) return strict;
  if (requested !== "all") return requested;

  return "culture";
}

/**
 * True when a hit is PROVABLY outside the requested category: the
 * OSM tags map strictly to a different taxonomy entry. Unknown tags
 * never exclude (absence of data must not hide results).
 */
export function isStrictMismatch(
  osmClass: string,
  osmType: string,
  requested: PlaceSearchCategory,
): boolean {
  if (requested === "all") return false;

  const strict = strictOsmCategory(osmClass, osmType);

  return strict !== null && strict !== requested;
}

/** First notes line pins the OSM reference for adopt/save matching. */
export function osmRefLine(osmType: string, osmId: number): string {
  return `OSM: ${osmType}/${osmId}`;
}

/** Read the OSM reference back from stored notes (null when absent). */
export function osmRefOfNotes(notes: string): string | null {
  const first = notes.split("\n")[0]?.trim() ?? "";
  const match = /^OSM: ([A-Za-z]+\/\d+)$/.exec(first);

  return match === null ? null : match[1];
}

/**
 * Map provider hits to `Place` records. Only provider-supplied fields
 * are copied; cost/duration/setting stay null (unknown). Opening
 * hours come exclusively from `extratags.opening_hours`.
 */
export function mapNominatimToPlaces(
  items: NominatimItem[],
  input: { category: PlaceSearchCategory; fetchedAt: string },
): Place[] {
  const places: Place[] = [];

  for (const item of items) {
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    const nameRaw =
      typeof item.name === "string" && item.name.trim() !== ""
        ? item.name.trim()
        : item.display_name.split(",")[0]?.trim() ?? "";

    if (nameRaw === "") continue;

    const openingHours = extraString(item.extratags, "opening_hours");
    const website = extraString(item.extratags, "website");
    const phone = extraString(item.extratags, "phone");
    const noteLines = [osmRefLine(item.osm_type, item.osm_id)];

    if (website !== "") noteLines.push(`Web: ${website}`);
    if (phone !== "") noteLines.push(`Tel.: ${phone}`);

    places.push({
      id: `osm-${item.osm_type}-${item.osm_id}`,
      name: nameRaw.slice(0, 120),
      category: mapOsmCategory(
        nominatimClass(item),
        item.type,
        input.category,
      ),
      address: item.display_name.slice(0, 300),
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lon) ? lon : null,
      costCents: null,
      durationMinutes: null,
      setting: null,
      openingHours,
      notes: noteLines.join("\n").slice(0, 500),
      source: {
        providerId: OSM_PROVIDER_ID,
        label: OSM_SOURCE_LABEL,
        fetchedAt: input.fetchedAt,
      },
      createdAt: input.fetchedAt,
      updatedAt: input.fetchedAt,
    });
  }

  return places;
}

// -------------------------------------------------------------- Overpass

export const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
/** Overpass QL timeout: bounded queries, fair-use friendly. */
export const OVERPASS_TIMEOUT_S = 25;
export const OVERPASS_PROVIDER_ID = "osm-overpass";
export const OVERPASS_SOURCE_LABEL = "OpenStreetMap (live, Umkreis)";

/**
 * Structured category tags for the Overpass `around` search
 * ([key, value]; empty value matches any value, e.g. `historic`).
 * `date`/`free` are occasion/price facets without OSM types, so they
 * map to the closest venue sets (evening spots / free venues).
 */
export const CATEGORY_OVERPASS_TAGS: Record<PlaceCategory, [string, string][]> =
  {
    nature: [
      ["leisure", "park"],
      ["leisure", "garden"],
      ["leisure", "nature_reserve"],
      ["leisure", "playground"],
      ["natural", "wood"],
      ["natural", "beach"],
    ],
    food: [
      ["amenity", "restaurant"],
      ["amenity", "cafe"],
      ["amenity", "fast_food"],
      ["amenity", "ice_cream"],
      ["amenity", "biergarten"],
      ["amenity", "bar"],
      ["amenity", "pub"],
      ["amenity", "food_court"],
    ],
    culture: [
      ["tourism", "museum"],
      ["tourism", "gallery"],
      ["tourism", "attraction"],
      ["tourism", "artwork"],
      ["tourism", "viewpoint"],
      ["amenity", "theatre"],
      ["amenity", "arts_centre"],
      ["amenity", "library"],
      ["amenity", "place_of_worship"],
      ["amenity", "community_centre"],
      ["historic", ""],
    ],
    sport: [
      ["leisure", "sports_centre"],
      ["leisure", "pitch"],
      ["leisure", "swimming_pool"],
      ["leisure", "stadium"],
      ["leisure", "fitness_centre"],
      ["leisure", "miniature_golf"],
      ["leisure", "golf_course"],
      ["leisure", "track"],
      ["amenity", "gym"],
      ["amenity", "swimming_pool"],
      ["amenity", "sports_centre"],
    ],
    cinema: [["amenity", "cinema"]],
    date: [
      ["amenity", "cafe"],
      ["amenity", "restaurant"],
      ["amenity", "cinema"],
      ["amenity", "bar"],
    ],
    free: [
      ["leisure", "playground"],
      ["leisure", "park"],
      ["leisure", "garden"],
      ["amenity", "library"],
    ],
  };

function overpassTagFilter(key: string, value: string): string {
  const safeKey = key.replace(/["\\]/g, "");
  const safeValue = value.replace(/["\\]/g, "");

  if (safeValue === "") return `["${safeKey}"]`;

  return `["${safeKey}"="${safeValue}"]`;
}

/**
 * Build a bounded Overpass QL query: tagged venues around a center.
 * Pure and deterministic for tests. Radius is capped at 50 km.
 */
export function buildOverpassQuery(
  category: PlaceCategory,
  center: { latitude: number; longitude: number },
  radiusKm: number,
): string {
  const meters = Math.round(Math.min(Math.max(radiusKm, 1), 50) * 1000);
  const lat = center.latitude.toFixed(5);
  const lon = center.longitude.toFixed(5);
  const clauses = CATEGORY_OVERPASS_TAGS[category]
    .map(
      ([key, value]) =>
        `  nwr${overpassTagFilter(key, value)}(around:${meters},${lat},${lon});`,
    )
    .join("\n");

  return (
    `[out:json][timeout:${OVERPASS_TIMEOUT_S}];\n(\n${clauses}\n);\nout center tags;`
  );
}

export type OverpassElement = {
  type: string;
  id: number;
  lat?: unknown;
  lon?: unknown;
  center?: unknown;
  tags?: unknown;
};

export function isOverpassElement(value: unknown): value is OverpassElement {
  if (!isRecord(value)) return false;

  return (
    typeof value.type === "string" &&
    typeof value.id === "number" &&
    (value.lat === undefined || typeof value.lat === "number") &&
    (value.lon === undefined || typeof value.lon === "number")
  );
}

export function isOverpassResponse(
  value: unknown,
): value is { elements: OverpassElement[] } {
  if (!isRecord(value)) return false;

  return (
    Array.isArray(value.elements) &&
    value.elements.every(isOverpassElement)
  );
}

function overpassTag(tags: unknown, key: string): string {
  if (!isRecord(tags)) return "";

  const value = tags[key];

  return typeof value === "string" ? value.trim() : "";
}

/**
 * Derive (class, type) from Overpass tags using the first taxonomy
 * key in priority order, then map strictly. Pure for tests.
 */
export function mapOverpassTags(
  tags: unknown,
  requested: PlaceSearchCategory,
): PlaceCategory {
  if (isRecord(tags)) {
    for (const key of [
      "amenity",
      "leisure",
      "tourism",
      "natural",
      "historic",
      "sport",
      "shop",
    ]) {
      const value = tags[key];

      if (typeof value === "string" && value.trim() !== "") {
        return mapOsmCategory(key, value, requested);
      }
    }
  }

  if (requested !== "all") return requested;

  return "culture";
}

/** Compose a display address from `addr:*` tags ("" when absent). */
export function overpassAddress(tags: unknown): string {
  const full = overpassTag(tags, "addr:full");

  if (full !== "") return full.slice(0, 300);

  const street = overpassTag(tags, "addr:street");
  const house = overpassTag(tags, "addr:housenumber");
  const postcode = overpassTag(tags, "addr:postcode");
  const city =
    overpassTag(tags, "addr:city") ||
    overpassTag(tags, "addr:town") ||
    overpassTag(tags, "addr:village") ||
    overpassTag(tags, "addr:suburb");

  const lineOne =
    street === "" ? house : house === "" ? street : `${street} ${house}`;
  const lineTwo =
    postcode === ""
      ? city
      : city === ""
        ? postcode
        : `${postcode} ${city}`;

  if (lineOne === "") return lineTwo.slice(0, 300);
  if (lineTwo === "") return lineOne.slice(0, 300);

  return `${lineOne}, ${lineTwo}`.slice(0, 300);
}

function overpassCoords(element: OverpassElement): {
  latitude: number | null;
  longitude: number | null;
} {
  if (
    typeof element.lat === "number" &&
    typeof element.lon === "number" &&
    Number.isFinite(element.lat) &&
    Number.isFinite(element.lon)
  ) {
    return { latitude: element.lat, longitude: element.lon };
  }

  if (isRecord(element.center)) {
    const lat = element.center.lat;
    const lon = element.center.lon;

    if (
      typeof lat === "number" &&
      typeof lon === "number" &&
      Number.isFinite(lat) &&
      Number.isFinite(lon)
    ) {
      return { latitude: lat, longitude: lon };
    }
  }

  return { latitude: null, longitude: null };
}

/**
 * Map Overpass elements to `Place` records. Only provider-supplied
 * fields are copied; nameless elements are skipped, missing
 * coordinates become null, cost/duration/setting stay unknown.
 */
export function mapOverpassToPlaces(
  elements: OverpassElement[],
  input: { category: PlaceSearchCategory; fetchedAt: string },
): Place[] {
  const places: Place[] = [];

  for (const element of elements) {
    const name = overpassTag(element.tags, "name");

    if (name === "") continue;

    const { latitude, longitude } = overpassCoords(element);
    const openingHours = overpassTag(element.tags, "opening_hours").slice(
      0,
      200,
    );
    const website = overpassTag(element.tags, "website").slice(0, 200);
    const phone = overpassTag(element.tags, "phone").slice(0, 200);
    const noteLines = [osmRefLine(element.type, element.id)];

    if (website !== "") noteLines.push(`Web: ${website}`);
    if (phone !== "") noteLines.push(`Tel.: ${phone}`);

    places.push({
      id: `osm-${element.type}-${element.id}`,
      name: name.slice(0, 120),
      category: mapOverpassTags(element.tags, input.category),
      address: overpassAddress(element.tags),
      latitude,
      longitude,
      costCents: null,
      durationMinutes: null,
      setting: null,
      openingHours,
      notes: noteLines.join("\n").slice(0, 500),
      source: {
        providerId: OVERPASS_PROVIDER_ID,
        label: OVERPASS_SOURCE_LABEL,
        fetchedAt: input.fetchedAt,
      },
      createdAt: input.fetchedAt,
      updatedAt: input.fetchedAt,
    });
  }

  return places;
}

// ------------------------------------------------------- general fallback

export const GENERAL_SUGGESTIONS_LABEL =
  "Allgemeine Ideen (keine Live-Daten)";

export type GeneralSuggestion = {
  title: string;
  category: PlaceCategory;
  hint: string;
};

/**
 * Labeled fallback when live search is unavailable or empty: generic
 * activity ideas with honest hints. Deliberately no names of real
 * businesses, no addresses, no coordinates, no opening hours.
 */
export const GENERAL_SUGGESTIONS: GeneralSuggestion[] = [
  {
    title: "Spaziergang im nächstgelegenen Park",
    category: "nature",
    hint: "Kostenlos, draußen – prüfe vorher das Wetter.",
  },
  {
    title: "Café oder Restaurant in deiner Nähe ausprobieren",
    category: "food",
    hint: "Öffnungszeiten und Preise vorher beim Anbieter prüfen.",
  },
  {
    title: "Museum oder Ausstellung besuchen",
    category: "culture",
    hint: "Viele Häuser haben einen kostenlosen Tag im Monat.",
  },
  {
    title: "Runde Joggen oder Radfahren",
    category: "sport",
    hint: "Kostenlos – wähle eine Strecke in deiner Nähe.",
  },
  {
    title: "Kinoabend",
    category: "cinema",
    hint: "Programm und Preise stehen auf der Kino-Website.",
  },
  {
    title: "Picknick zu zweit",
    category: "date",
    hint: "Decke und Snacks einpacken, ruhigen Platz suchen.",
  },
  {
    title: "In der Stadtbücherei stöbern",
    category: "free",
    hint: "Kostenlos – Ausweis für die Anmeldung mitbringen.",
  },
  {
    title: "Tageswanderung in der Umgebung",
    category: "nature",
    hint: "Route vorher planen, Wasser und Schuhe einpacken.",
  },
];

// ---------------------------------------------------------------- guards

function isResolvedLocation(value: unknown): value is ResolvedLocation {
  if (!isRecord(value)) return false;

  return (
    typeof value.label === "string" &&
    typeof value.latitude === "number" &&
    typeof value.longitude === "number"
  );
}

function isCenter(value: unknown): value is {
  latitude: number;
  longitude: number;
} {
  if (!isRecord(value)) return false;

  return (
    typeof value.latitude === "number" &&
    typeof value.longitude === "number"
  );
}

function isSearchProvider(value: unknown): value is SearchProvider {
  return value === "nominatim" || value === "overpass" || value === "none";
}

export function isPlaceSearchDiagnostics(
  value: unknown,
): value is PlaceSearchDiagnostics {
  if (!isRecord(value)) return false;

  return (
    isSearchCategory(value.requestedCategory) &&
    isSearchCategory(value.detectedCategory) &&
    isSearchCategory(value.effectiveCategory) &&
    isSearchProvider(value.provider) &&
    (value.cache === "hit" || value.cache === "miss") &&
    typeof value.rawCount === "number" &&
    Number.isInteger(value.rawCount) &&
    value.rawCount >= 0 &&
    typeof value.filteredCount === "number" &&
    Number.isInteger(value.filteredCount) &&
    value.filteredCount >= 0
  );
}

export function isPlaceSearchPayload(
  value: unknown,
): value is PlaceSearchPayload {
  if (!isRecord(value)) return false;

  return (
    Array.isArray(value.places) &&
    (value.resolvedLocation === null ||
      isResolvedLocation(value.resolvedLocation)) &&
    (value.centerUsed === null || isCenter(value.centerUsed)) &&
    (value.notice === null || typeof value.notice === "string") &&
    typeof value.fetchedAt === "string" &&
    isPlaceSearchDiagnostics(value.diagnostics)
  );
}
