/**
 * Lifestyle search intent + structured geo regression tests
 * (priority 2: the "Kino stays nature" fix):
 * - intent detection maps DE/EN queries to categories; ambiguous
 *   input stays broad, never a forced `nature`;
 * - strict OSM mapping drops the hidden `nature` catch-all; provider
 *   mapping copies only real fields (no invented ratings, hours,
 *   prices, addresses); guards accept the live `format=jsonv2`
 *   shape (`category` instead of `class`);
 * - Overpass query building and element mapping for the structured
 *   category-`around` search;
 * - the route splits providers (Nominatim text/geocode, Overpass
 *   categories), validates every param, keys the cache by every
 *   param, and always reports diagnostics — a 200 with zero results
 *   is NOT success (honest `notice` required);
 * - the assistant NLU picks categories from German intent and the
 *   heuristic summary uses real results (addresses + map links).
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GET,
  __clearPlaceSearchCacheForTests,
  __resetPlaceSearchThrottleForTests,
} from "@/app/api/lifestyle/places/search/route";
import { looksLikePlaceQuery } from "@/src/lib/assistant/agent";
import type { NluContext } from "@/src/lib/assistant/actions";
import { createHeuristicChat } from "@/src/lib/assistant/heuristicChat";
import { parseCommand } from "@/src/lib/assistant/nlu";
import {
  canonicalizeQuery,
  detectPlaceCategory,
  detectPlaceIntent,
} from "@/src/lib/lifestyle/intent";
import {
  buildOverpassQuery,
  isNominatimItem,
  isNominatimList,
  isOverpassResponse,
  isStrictMismatch,
  mapNominatimToPlaces,
  mapOsmCategory,
  mapOverpassTags,
  mapOverpassToPlaces,
  nominatimClass,
  overpassAddress,
  strictOsmCategory,
  type NominatimItem,
  type OverpassElement,
  type PlaceSearchPayload,
} from "@/src/lib/lifestyle/placesSearch";
import { isPlace } from "@/src/lib/lifestyle/types";

const FETCHED_AT = "2026-11-03T10:00:00.000Z";

const CTX: NluContext = {
  todayISO: "2026-11-03",
  nowTime: "12:00",
  timezone: "Europe/Berlin",
  locale: "de",
};

// ------------------------------------------------------------ intent

describe("detectPlaceCategory", () => {
  it("maps outing intents to categories", () => {
    assert.equal(detectPlaceCategory("Kinoabend in Stuttgart"), "cinema");
    assert.equal(detectPlaceCategory("Kino in Stuttgart"), "cinema");
    assert.equal(detectPlaceCategory("Restaurants in Berlin"), "food");
    assert.equal(detectPlaceCategory("Cafés in Leipzig"), "food");
    assert.equal(detectPlaceCategory("gemütliche Kneipe"), "food");
    assert.equal(detectPlaceCategory("Parks in München"), "nature");
    assert.equal(detectPlaceCategory("Spaziergang im Grünen"), "nature");
    assert.equal(detectPlaceCategory("Fitnessstudio in Berlin"), "sport");
    assert.equal(detectPlaceCategory("Gym in Köln"), "sport");
    assert.equal(detectPlaceCategory("Museum in München"), "culture");
    assert.equal(detectPlaceCategory("Sehenswürdigkeiten"), "culture");
    assert.equal(detectPlaceCategory("kostenloser Eintritt"), "free");
    assert.equal(detectPlaceCategory("romantisches Date"), "date");
  });

  it("stays broad for weekend, what-to-do, and ambiguous input", () => {
    assert.equal(
      detectPlaceCategory("Was machen wir am Wochenende in Leipzig?"),
      "all",
    );
    assert.equal(detectPlaceCategory("Wochenende"), "all");
    assert.equal(detectPlaceCategory("Freizeitideen"), "all");
    assert.equal(detectPlaceCategory("Veranstaltungen heute"), "all");
    assert.equal(detectPlaceCategory("Einkaufen in der Stadt"), "all");
    assert.equal(detectPlaceCategory("Stuttgart"), "all");
    assert.equal(detectPlaceCategory(""), "all");
    assert.equal(detectPlaceCategory("asdfgh qwerty"), "all");
  });

  it("never reads parking, cities, or venues as nature", () => {
    assert.equal(detectPlaceCategory("Parkhaus am Bahnhof"), "all");
    assert.equal(detectPlaceCategory("Parkplatz suchen"), "all");
    assert.equal(detectPlaceCategory("Hotel in Essen"), "all");
    assert.equal(detectPlaceCategory("Hamburg"), "all");
    assert.equal(detectPlaceCategory("Nürnberg"), "all");

    for (const text of [
      "Kino in Stuttgart",
      "Restaurant in Berlin",
      "Café in Leipzig",
      "Museum in München",
      "Fitnessstudio in Köln",
    ]) {
      assert.notEqual(
        detectPlaceCategory(text),
        "nature",
        `${text} must never detect as nature`,
      );
    }
  });

  it("reports the matched keyword", () => {
    assert.equal(detectPlaceIntent("Kinoabend").matched, "kinoabend");
    assert.equal(detectPlaceIntent("Stuttgart").matched, null);
  });
});

describe("canonicalizeQuery", () => {
  it("normalizes plurals and compounds for the provider", () => {
    assert.equal(canonicalizeQuery("Kinoabend in Stuttgart"), "Kino in Stuttgart");
    assert.equal(canonicalizeQuery("Restaurants"), "Restaurant");
    assert.equal(canonicalizeQuery("Cafés"), "Café");
    assert.equal(canonicalizeQuery("Museen"), "Museum");
    assert.equal(canonicalizeQuery("Kino"), "Kino");
  });
});

// ------------------------------------------------- strict OSM mapping

describe("strictOsmCategory", () => {
  it("maps known tags and returns null for unknown ones", () => {
    assert.equal(strictOsmCategory("amenity", "restaurant"), "food");
    assert.equal(strictOsmCategory("amenity", "cinema"), "cinema");
    assert.equal(strictOsmCategory("leisure", "park"), "nature");
    assert.equal(strictOsmCategory("leisure", "pitch"), "sport");
    assert.equal(strictOsmCategory("tourism", "museum"), "culture");
    assert.equal(strictOsmCategory("leisure", "bowling_alley"), null);
    assert.equal(strictOsmCategory("tourism", "hotel"), null);
    assert.equal(strictOsmCategory("amenity", "charging_station"), null);
    assert.equal(strictOsmCategory("place", "city"), null);
  });

  it("falls back without ever forcing nature", () => {
    // The old leisure catch-all returned `nature` here.
    assert.equal(mapOsmCategory("leisure", "bowling_alley", "all"), "culture");
    assert.equal(mapOsmCategory("leisure", "bowling_alley", "sport"), "sport");
    assert.equal(
      mapOsmCategory("amenity", "charging_station", "all"),
      "culture",
    );
    assert.equal(
      mapOsmCategory("amenity", "charging_station", "cinema"),
      "cinema",
    );
  });

  it("flags only provable mismatches, never unknown tags", () => {
    assert.equal(isStrictMismatch("amenity", "restaurant", "cinema"), true);
    assert.equal(isStrictMismatch("amenity", "restaurant", "food"), false);
    assert.equal(isStrictMismatch("amenity", "restaurant", "all"), false);
    assert.equal(isStrictMismatch("place", "city", "cinema"), false);
    assert.equal(isStrictMismatch("tourism", "hotel", "cinema"), false);
  });
});

// ------------------------------------------------------------- Overpass

function overpassElement(
  overrides: Partial<OverpassElement> & { tags?: unknown } = {},
): OverpassElement {
  return {
    type: "node",
    id: 987654,
    lat: 48.7758,
    lon: 9.1829,
    tags: {
      name: "Café König",
      "addr:street": "Königstraße",
      "addr:housenumber": "1",
      "addr:postcode": "70173",
      "addr:city": "Stuttgart",
      amenity: "cafe",
      opening_hours: "Mo-Sa 09:00-20:00",
      website: "https://example.test/koenig",
      phone: "+49 711 123456",
    },
    ...overrides,
  };
}

describe("buildOverpassQuery", () => {
  it("builds a bounded around-query per category", () => {
    const query = buildOverpassQuery(
      "cinema",
      { latitude: 48.7758, longitude: 9.1829 },
      10,
    );

    assert.match(query, /\[out:json\]\[timeout:25\]/);
    assert.match(query, /\["amenity"="cinema"\]/);
    assert.match(query, /around:10000,48\.77580,9\.18290/);
    assert.match(query, /out center tags;/);

    const food = buildOverpassQuery(
      "food",
      { latitude: 51.34, longitude: 12.37 },
      5,
    );

    assert.match(food, /\["amenity"="restaurant"\]/);
    assert.match(food, /\["amenity"="cafe"\]/);
    assert.match(food, /around:5000,/);

    const culture = buildOverpassQuery(
      "culture",
      { latitude: 51.34, longitude: 12.37 },
      5,
    );

    assert.match(culture, /\["historic"\]/);
  });

  it("caps the radius at 50 km", () => {
    const query = buildOverpassQuery(
      "nature",
      { latitude: 51.34, longitude: 12.37 },
      500,
    );

    assert.match(query, /around:50000,/);
  });

  it("validates Overpass shapes defensively", () => {
    assert.equal(isOverpassResponse({ elements: [overpassElement()] }), true);
    assert.equal(isOverpassResponse({ elements: [{ nope: true }] }), false);
    assert.equal(isOverpassResponse([]), false);
    assert.equal(isOverpassResponse({}), false);
  });
});

describe("mapOverpassToPlaces", () => {
  it("copies provider fields verbatim", () => {
    const [place] = mapOverpassToPlaces([overpassElement()], {
      category: "all",
      fetchedAt: FETCHED_AT,
    });

    assert.ok(place !== undefined);
    assert.equal(place?.name, "Café König");
    assert.equal(place?.address, "Königstraße 1, 70173 Stuttgart");
    assert.equal(place?.latitude, 48.7758);
    assert.equal(place?.longitude, 9.1829);
    assert.equal(place?.category, "food");
    assert.equal(place?.openingHours, "Mo-Sa 09:00-20:00");
    assert.match(place?.notes ?? "", /OSM: node\/987654/);
    assert.match(place?.notes ?? "", /example\.test/);
    assert.equal(place?.source.providerId, "osm-overpass");
    assert.equal(place?.id, "osm-node-987654");
    assert.ok(place !== undefined && isPlace(place));
  });

  it("reads way centers and tolerates missing addresses", () => {
    const [place] = mapOverpassToPlaces(
      [
        overpassElement({
          type: "way",
          id: 42,
          lat: undefined,
          lon: undefined,
          center: { lat: 51.34, lon: 12.37 },
          tags: { name: "Stadtpark", leisure: "park" },
        }),
      ],
      { category: "nature", fetchedAt: FETCHED_AT },
    );

    assert.equal(place?.latitude, 51.34);
    assert.equal(place?.longitude, 12.37);
    assert.equal(place?.address, "");
    assert.equal(place?.category, "nature");
  });

  it("never invents missing data", () => {
    const [place] = mapOverpassToPlaces(
      [
        overpassElement({
          lat: undefined,
          lon: undefined,
          center: undefined,
          tags: { name: "X", amenity: "cafe" },
        }),
      ],
      { category: "all", fetchedAt: FETCHED_AT },
    );

    assert.equal(place?.latitude, null);
    assert.equal(place?.longitude, null);
    assert.equal(place?.address, "");
    assert.equal(place?.costCents, null);
    assert.equal(place?.durationMinutes, null);
    assert.equal(place?.setting, null);
    assert.equal(place?.openingHours, "");
    assert.ok(!JSON.stringify(place).toLowerCase().includes("rating"));

    const nameless = mapOverpassToPlaces(
      [overpassElement({ tags: { amenity: "cafe" } })],
      { category: "all", fetchedAt: FETCHED_AT },
    );

    assert.equal(nameless.length, 0);
  });

  it("derives categories from tags without forcing nature", () => {
    assert.equal(mapOverpassTags({ amenity: "cinema" }, "all"), "cinema");
    assert.equal(mapOverpassTags({ leisure: "park" }, "all"), "nature");
    assert.equal(mapOverpassTags({ tourism: "hotel" }, "all"), "culture");
    assert.equal(mapOverpassTags({ highway: "residential" }, "sport"), "sport");
    assert.equal(mapOverpassTags({}, "all"), "culture");
  });
});

describe("overpassAddress", () => {
  it("prefers addr:full, then composes parts", () => {
    assert.equal(
      overpassAddress({ "addr:full": "Irgendwo 1, 12345 Weitweg" }),
      "Irgendwo 1, 12345 Weitweg",
    );
    assert.equal(
      overpassAddress({
        "addr:street": "A",
        "addr:housenumber": "2",
        "addr:city": "B",
      }),
      "A 2, B",
    );
    assert.equal(overpassAddress({}), "");
    assert.equal(overpassAddress(null), "");
  });
});

// ------------------------------------------------------------------ route

type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

const REAL_FETCH = globalThis.fetch;
let calls: FetchCall[] = [];
let upstream: (url: string) => Response = () =>
  new Response("[]", { status: 200 });

function headersOf(init: { headers?: unknown }): Record<string, string> {
  if (init.headers instanceof Headers) {
    return Object.fromEntries(init.headers.entries());
  }

  return { ...(init.headers as Record<string, string>) };
}

function nominatimItem(overrides: Partial<NominatimItem> = {}): NominatimItem {
  return {
    osm_type: "node",
    osm_id: 555,
    lat: "48.7758",
    lon: "9.1829",
    display_name: "Innenstadtkinos, Königstraße 22, 70173 Stuttgart",
    class: "amenity",
    type: "cinema",
    name: "Innenstadtkinos",
    extratags: {},
    ...overrides,
  };
}

function cityItem(): NominatimItem {
  return nominatimItem({
    osm_type: "relation",
    osm_id: 1,
    display_name: "Stuttgart, Baden-Württemberg, Deutschland",
    class: "place",
    type: "city",
    name: "Stuttgart",
    extratags: {},
  });
}

/** Live `format=jsonv2` shape: `category` instead of `class`. */
function nominatimItemJsonv2(
  overrides: Partial<NominatimItem> = {},
): NominatimItem {
  return {
    osm_type: "node",
    osm_id: 555,
    lat: "48.7758",
    lon: "9.1829",
    display_name: "Innenstadtkinos, Königstraße 22, 70173 Stuttgart",
    category: "amenity",
    type: "cinema",
    name: "Innenstadtkinos",
    extratags: {},
    ...overrides,
  };
}

describe("Nominatim jsonv2 shape (live format)", () => {
  it("accepts category-based items, rejects ones with neither field", () => {
    assert.equal(isNominatimItem(nominatimItem()), true);
    assert.equal(isNominatimItem(nominatimItemJsonv2()), true);
    assert.equal(isNominatimList([nominatimItemJsonv2()]), true);
    assert.equal(
      isNominatimItem({
        osm_type: "node",
        osm_id: 555,
        lat: "48.7758",
        lon: "9.1829",
        display_name: "Innenstadtkinos",
        type: "cinema",
      }),
      false,
    );
    assert.equal(
      isNominatimItem({ ...nominatimItemJsonv2(), category: 42 }),
      false,
    );
  });

  it("reads the effective class from either field", () => {
    assert.equal(nominatimClass(nominatimItem()), "amenity");
    assert.equal(nominatimClass(nominatimItemJsonv2()), "amenity");
    assert.equal(
      nominatimClass(nominatimItemJsonv2({ category: "leisure" })),
      "leisure",
    );
  });

  it("maps jsonv2 items to real categories", () => {
    const [place] = mapNominatimToPlaces([nominatimItemJsonv2()], {
      category: "all",
      fetchedAt: FETCHED_AT,
    });

    assert.equal(place?.category, "cinema");
  });

  it("serves live-shaped jsonv2 results through the route", async () => {
    upstream = () => Response.json([nominatimItemJsonv2()]);

    const { status, body } = await getJson(
      "/api/lifestyle/places/search?query=Kino&lat=48.77&lon=9.18",
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const payload = body.data as PlaceSearchPayload;
    assert.equal(payload.places.length, 1);
    assert.equal(payload.places[0]?.category, "cinema");
    assert.equal(payload.diagnostics.provider, "nominatim");
  });

  it("drops jsonv2 mismatches at the route filter", async () => {
    upstream = () =>
      Response.json([
        nominatimItemJsonv2({ category: "amenity", type: "restaurant" }),
      ]);

    const { status, body } = await getJson(
      "/api/lifestyle/places/search?query=Caf%C3%A9&category=cinema&lat=51&lon=12",
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const payload = body.data as PlaceSearchPayload;
    assert.equal(payload.places.length, 0);
    assert.ok((payload.notice ?? "").length > 0);
  });
});

beforeEach(() => {
  calls = [];
  __clearPlaceSearchCacheForTests();
  __resetPlaceSearchThrottleForTests();
  globalThis.fetch = (async (input: unknown, init?: {
    headers?: unknown;
    method?: string;
  }) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: headersOf({ headers: init?.headers }),
    });

    return upstream(url);
  }) as typeof fetch;
  upstream = () => new Response("[]", { status: 200 });
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

async function getJson(path: string): Promise<{
  status: number;
  body: { ok: boolean; data?: unknown; error?: { message: string } };
}> {
  const response = await GET(new Request(`http://localhost${path}`));

  return {
    status: response.status,
    body: (await response.json()) as {
      ok: boolean;
      data?: unknown;
      error?: { message: string };
    },
  };
}

describe("GET /api/lifestyle/places/search (structured)", () => {
  it("routes text queries to Nominatim with diagnostics", async () => {
    upstream = (url) => {
      assert.match(url, /nominatim\.openstreetmap\.org/);

      return Response.json([nominatimItem()]);
    };

    const first = await getJson(
      "/api/lifestyle/places/search?query=Kino&lat=48.77&lon=9.18",
    );

    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);

    const payload = first.body.data as PlaceSearchPayload;
    assert.equal(payload.places.length, 1);
    assert.equal(payload.places[0]?.category, "cinema");
    assert.deepEqual(payload.diagnostics, {
      requestedCategory: "all",
      detectedCategory: "cinema",
      effectiveCategory: "cinema",
      provider: "nominatim",
      cache: "miss",
      rawCount: 1,
      filteredCount: 1,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "GET");

    const second = await getJson(
      "/api/lifestyle/places/search?query=Kino&lat=48.77&lon=9.18",
    );
    const cached = second.body.data as PlaceSearchPayload;

    assert.equal(calls.length, 1);
    assert.equal(cached.diagnostics.cache, "hit");
  });

  it("routes category browse to Overpass via POST", async () => {
    upstream = (url) => {
      assert.match(url, /overpass-api\.de/);

      return Response.json({ elements: [overpassElement()] });
    };

    const { status, body } = await getJson(
      "/api/lifestyle/places/search?category=food&lat=48.77&lon=9.18&radiusKm=5",
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const payload = body.data as PlaceSearchPayload;
    assert.equal(payload.places.length, 1);
    assert.equal(payload.places[0]?.name, "Café König");
    assert.ok(payload.places.every(isPlace));
    assert.equal(payload.diagnostics.provider, "overpass");
    assert.equal(payload.diagnostics.requestedCategory, "food");
    assert.equal(payload.diagnostics.effectiveCategory, "food");
    assert.equal(payload.diagnostics.detectedCategory, "all");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "POST");
    assert.ok((calls[0]?.headers["User-Agent"] ?? "").includes("jarvis"));
  });

  it("resolves Kino in Stuttgart to cinema, never nature", async () => {
    upstream = (url) => {
      if (new URL(url).searchParams.get("limit") === "1") {
        return Response.json([cityItem()]);
      }

      return Response.json([nominatimItem()]);
    };

    const { status, body } = await getJson(
      "/api/lifestyle/places/search?query=Kino&near=Stuttgart",
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const payload = body.data as PlaceSearchPayload;
    assert.equal(payload.places.length, 1);
    assert.equal(payload.places[0]?.category, "cinema");
    assert.equal(payload.diagnostics.detectedCategory, "cinema");
    assert.equal(payload.diagnostics.effectiveCategory, "cinema");
    assert.equal(payload.resolvedLocation?.label, "Stuttgart, Baden-Württemberg");
  });

  it("drops provable category mismatches with an honest notice", async () => {
    upstream = () =>
      Response.json([
        nominatimItem({ class: "amenity", type: "restaurant" }),
      ]);

    const { status, body } = await getJson(
      "/api/lifestyle/places/search?query=Caf%C3%A9&category=cinema&lat=51&lon=12",
    );

    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const payload = body.data as PlaceSearchPayload;
    assert.equal(payload.places.length, 0);
    assert.match(payload.notice ?? "", /Kategorie/);
    assert.equal(payload.diagnostics.rawCount, 1);
    assert.equal(payload.diagnostics.filteredCount, 0);
  });

  it("treats 200-with-zero-results as an honest empty state", async () => {
    upstream = () => new Response("[]", { status: 200 });

    const { status, body } = await getJson(
      "/api/lifestyle/places/search?query=Quartzholz&lat=51&lon=12",
    );

    assert.equal(status, 200);

    const payload = body.data as PlaceSearchPayload;
    assert.equal(payload.places.length, 0);
    assert.ok(
      payload.notice !== null && payload.notice !== "",
      "zero results require an honest notice, not silent success",
    );
    assert.equal(payload.diagnostics.rawCount, 0);
    assert.equal(payload.diagnostics.filteredCount, 0);
  });

  it("reports unknown areas without a provider search", async () => {
    upstream = () => new Response("[]", { status: 200 });

    const { body } = await getJson(
      "/api/lifestyle/places/search?query=Museum&near=Niwoxystadt",
    );
    const payload = body.data as PlaceSearchPayload;

    assert.equal(payload.places.length, 0);
    assert.match(payload.notice ?? "", /Niwoxystadt/);
    assert.equal(payload.diagnostics.provider, "none");
    assert.equal(calls.length, 1);
  });

  it("keys the cache by every param (no cross-category poisoning)", async () => {
    upstream = () => Response.json([nominatimItem()]);

    await getJson(
      "/api/lifestyle/places/search?query=Caf%C3%A9&category=food&lat=51&lon=12",
    );
    __resetPlaceSearchThrottleForTests();
    await getJson(
      "/api/lifestyle/places/search?query=Caf%C3%A9&category=cinema&lat=51&lon=12",
    );

    assert.equal(calls.length, 2);
  });

  it("keeps diagnostics free of personal data", async () => {
    upstream = (url) => {
      if (new URL(url).searchParams.get("limit") === "1") {
        return Response.json([cityItem()]);
      }

      return Response.json([nominatimItem()]);
    };

    const { body } = await getJson(
      "/api/lifestyle/places/search?query=Kino&near=Stuttgart",
    );
    const payload = body.data as PlaceSearchPayload;
    const serialized = JSON.stringify(payload.diagnostics);

    assert.deepEqual(Object.keys(payload.diagnostics).sort(), [
      "cache",
      "detectedCategory",
      "effectiveCategory",
      "filteredCount",
      "provider",
      "rawCount",
      "requestedCategory",
    ]);
    assert.ok(!serialized.includes("Kino"), "no query text may leak");
    assert.ok(!serialized.includes("Stuttgart"), "no area text may leak");
    assert.ok(!serialized.includes("48.77"), "no coordinates may leak");
  });
});

// --------------------------------------------------------------- assistant

describe("assistant lifestyle NLU", () => {
  it("parses Kino in Stuttgart as a cinema search", () => {
    const { plan } = parseCommand("Kino in Stuttgart", CTX);

    assert.equal(plan.type, "lifestyle.placesSearch");

    if (plan.type !== "lifestyle.placesSearch") return;

    assert.equal(plan.near, "Stuttgart");
    assert.equal(plan.query, "Kino");
    assert.ok(
      plan.category === undefined || plan.category === "cinema",
      "cinema or broad, never another category",
    );
    assert.notEqual(plan.category, "nature");
  });

  it("maps outing intents to categories", () => {
    const cases: [string, string][] = [
      ["Kinoabend in Stuttgart", "cinema"],
      ["Kino am Wochenende in Stuttgart", "cinema"],
      ["Restaurants in Berlin", "food"],
      ["Fitnessstudio in Berlin", "sport"],
      ["Museum in München", "culture"],
      ["Parks in München", "nature"],
      ["Wo ist das nächste Restaurant?", "food"],
    ];

    for (const [text, category] of cases) {
      const { plan } = parseCommand(text, CTX);

      assert.equal(plan.type, "lifestyle.placesSearch", text);

      if (plan.type !== "lifestyle.placesSearch") continue;

      assert.equal(plan.category, category, text);
    }
  });

  it("keeps weekend and what-to-do questions broad", () => {
    // Note: "Was machen wir …" and "Was gibt es …" correctly route to
    // the calendar (own schedule first); discovery phrasings below
    // reach the live search with a broad category.
    for (const text of [
      "Ideen fürs Wochenende in Leipzig",
      "Wochenende in Leipzig",
      "Freizeit in Leipzig",
    ]) {
      const { plan } = parseCommand(text, CTX);

      assert.equal(plan.type, "lifestyle.placesSearch", text);

      if (plan.type !== "lifestyle.placesSearch") continue;

      assert.equal(plan.near, "Leipzig", text);
      assert.equal(plan.category, undefined, text);
      assert.ok((plan.query ?? "") !== "", `${text} keeps a query`);
    }
  });

  it("keeps the city of Essen out of the food category", () => {
    const { plan } = parseCommand("Hotel in Essen", CTX);

    assert.equal(plan.type, "lifestyle.placesSearch");

    if (plan.type !== "lifestyle.placesSearch") return;

    assert.equal(plan.near, "Essen");
    assert.equal(plan.category, undefined);
  });

  it("does not route bare city names to place search", () => {
    const { plan } = parseCommand("Stuttgart", CTX);

    assert.notEqual(plan.type, "lifestyle.placesSearch");
  });

  it("detects place queries for the tool challenge", () => {
    assert.equal(looksLikePlaceQuery("Kinoabend in Stuttgart"), true);
    assert.equal(looksLikePlaceQuery("Fitnessstudio gesucht"), true);
    assert.equal(
      looksLikePlaceQuery("Was machen wir am Wochenende?"),
      true,
    );
    assert.equal(looksLikePlaceQuery("Zeige meine Finanzen"), false);
  });
});

describe("assistant places summary", () => {
  const chat = () =>
    createHeuristicChat({
      todayISO: "2026-11-03",
      nowTime: "12:00",
      timezone: "Europe/Berlin",
      locale: "de",
    });

  it("uses real results with addresses and map links", async () => {
    const [place] = mapNominatimToPlaces([nominatimItem()], {
      category: "all",
      fetchedAt: FETCHED_AT,
    });

    const parsed = JSON.parse(
      await chat()([
        { role: "user", content: "Kino in Stuttgart" },
        {
          role: "assistant",
          content: JSON.stringify({
            tool: "lifestyle.placesSearch",
            args: { query: "Kino", near: "Stuttgart" },
          }),
        },
        {
          role: "tool",
          content: JSON.stringify({
            ok: true,
            data: {
              places: [place],
              resolvedLocation: null,
              notice: null,
              diagnostics: {
                requestedCategory: "all",
                detectedCategory: "cinema",
                effectiveCategory: "cinema",
                provider: "nominatim",
                cache: "miss",
                rawCount: 1,
                filteredCount: 1,
              },
            },
          }),
        },
      ]),
    ) as { final: string };

    assert.match(parsed.final, /Innenstadtkinos/);
    assert.match(parsed.final, /Königstraße/);
    assert.match(parsed.final, /openstreetmap\.org/);
    assert.match(parsed.final, /Textsuche/);
  });

  it("keeps empty results honest without invented venues", async () => {
    const parsed = JSON.parse(
      await chat()([
        { role: "user", content: "Kino in Stuttgart" },
        {
          role: "assistant",
          content: JSON.stringify({
            tool: "lifestyle.placesSearch",
            args: { query: "Kino", near: "Stuttgart" },
          }),
        },
        {
          role: "tool",
          content: JSON.stringify({
            ok: true,
            data: {
              places: [],
              resolvedLocation: null,
              notice: "Keine Treffer im Umkreis.",
              diagnostics: {
                requestedCategory: "all",
                detectedCategory: "cinema",
                effectiveCategory: "cinema",
                provider: "nominatim",
                cache: "miss",
                rawCount: 0,
                filteredCount: 0,
              },
            },
          }),
        },
      ]),
    ) as { final: string };

    assert.match(parsed.final, /Keine Treffer im Umkreis/);
    assert.ok(!parsed.final.includes("openstreetmap.org"));
  });
});
