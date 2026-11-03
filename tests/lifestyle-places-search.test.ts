/**
 * Live place discovery regression tests (issue 3):
 * - request validation (query/near/coords, radius, category, limit);
 * - Nominatim URL building (viewbox bias, category keywords, geocode);
 * - provider mapping copies only real fields — cost, duration, and
 *   setting stay unknown, opening hours come exclusively from
 *   `extratags.opening_hours`, nothing is invented;
 * - the search route respects the Nominatim policy (User-Agent,
 *   throttle, cache), geocodes manual areas, and surfaces
 *   errors/empty results honestly;
 * - the assistant wire (registry -> MODEL_PARAMS -> agent async read
 *   -> heuristic summary) works for places search and saved places.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GET,
  __clearPlaceSearchCacheForTests,
  __resetPlaceSearchThrottleForTests,
} from "@/app/api/lifestyle/places/search/route";
import { MODEL_PARAMS, runAgent } from "@/src/lib/assistant/agent";
import { createHeuristicChat } from "@/src/lib/assistant/heuristicChat";
import {
  ASSISTANT_TOOLS,
  getToolDefinition,
} from "@/src/lib/assistant/registry";
import { EMPTY_FINANCE } from "@/src/lib/finance";
import { EMPTY_STUDY } from "@/src/lib/study";
import {
  GENERAL_SUGGESTIONS,
  GENERAL_SUGGESTIONS_LABEL,
  OSM_PROVIDER_ID,
  OSM_USER_AGENT,
  buildNominatimGeocodeUrl,
  buildNominatimUrl,
  isNominatimList,
  mapNominatimToPlaces,
  mapOsmCategory,
  osmRefLine,
  osmRefOfNotes,
  parsePlaceSearchParams,
  type NominatimItem,
  type PlaceSearchPayload,
} from "@/src/lib/lifestyle/placesSearch";
import { searchLivePlaces } from "@/src/lib/lifestyle/searchClient";
import {
  PLACE_CATEGORIES,
  isPlace,
  type LifestylePreferences,
  type Place,
} from "@/src/lib/lifestyle/types";

const FETCHED_AT = "2026-11-03T10:00:00.000Z";

function params(query: string): URLSearchParams {
  return new URL(`http://localhost/x?${query}`).searchParams;
}

function nominatimItem(overrides: Partial<NominatimItem> = {}): NominatimItem {
  return {
    osm_type: "node",
    osm_id: 123456,
    lat: "51.3397",
    lon: "12.3731",
    display_name: "Café Central, Augustusplatz 1, 04109 Leipzig",
    class: "amenity",
    type: "cafe",
    name: "Café Central",
    extratags: {
      opening_hours: "Mo-Fr 08:00-18:00",
      website: "https://example.test/cafe",
      phone: "+49 341 123456",
    },
    ...overrides,
  };
}

// ------------------------------------------------------------ validation

describe("parsePlaceSearchParams", () => {
  it("applies defaults and trims text", () => {
    const parsed = parsePlaceSearchParams(params("query=%20Caf%C3%A9%20"));

    assert.equal(parsed.ok, true);

    if (!parsed.ok) return;

    assert.equal(parsed.params.query, "Café");
    assert.equal(parsed.params.near, "");
    assert.equal(parsed.params.latitude, null);
    assert.equal(parsed.params.longitude, null);
    assert.equal(parsed.params.radiusKm, 10);
    assert.equal(parsed.params.category, "all");
    assert.equal(parsed.params.limit, 10);
  });

  it("requires a search anchor", () => {
    const parsed = parsePlaceSearchParams(params(""));

    assert.equal(parsed.ok, false);

    if (parsed.ok) return;

    assert.match(parsed.error, /Suchtext oder einen Ort/);
  });

  it("requires query or category even with coordinates", () => {
    const parsed = parsePlaceSearchParams(
      params("lat=51.34&lon=12.37&category=all"),
    );

    assert.equal(parsed.ok, false);

    if (parsed.ok) return;

    assert.match(parsed.error, /Suchtext oder eine Kategorie/);
  });

  it("accepts coordinates with a category and no query", () => {
    const parsed = parsePlaceSearchParams(
      params("lat=51,34&lon=12,37&category=food"),
    );

    assert.equal(parsed.ok, true);

    if (!parsed.ok) return;

    assert.equal(parsed.params.latitude, 51.34);
    assert.equal(parsed.params.longitude, 12.37);
    assert.equal(parsed.params.category, "food");
  });

  it("rejects invalid coordinates", () => {
    assert.equal(
      parsePlaceSearchParams(params("query=x&lat=51.3")).ok,
      false,
    );
    assert.equal(
      parsePlaceSearchParams(params("query=x&lat=999&lon=12")).ok,
      false,
    );
    assert.equal(
      parsePlaceSearchParams(params("query=x&lat=51&lon=abc")).ok,
      false,
    );
  });

  it("rejects invalid radius, category, and limit", () => {
    assert.equal(
      parsePlaceSearchParams(params("query=x&radiusKm=0")).ok,
      false,
    );
    assert.equal(
      parsePlaceSearchParams(params("query=x&radiusKm=51")).ok,
      false,
    );
    assert.equal(
      parsePlaceSearchParams(params("query=x&category=hotel")).ok,
      false,
    );
    assert.equal(parsePlaceSearchParams(params("query=x&limit=0")).ok, false);
    assert.equal(
      parsePlaceSearchParams(params("query=x&limit=21")).ok,
      false,
    );

    for (const category of PLACE_CATEGORIES) {
      assert.equal(
        parsePlaceSearchParams(params(`near=Leipzig&category=${category}`))
          .ok,
        true,
        `category ${category} must validate`,
      );
    }
  });
});

// ---------------------------------------------------------- URL building

describe("buildNominatimUrl", () => {
  it("sends query, limit, and a viewbox for coordinates", () => {
    const parsed = parsePlaceSearchParams(
      params("query=Caf%C3%A9&lat=51.34&lon=12.37&radiusKm=5&limit=7"),
    );

    assert.equal(parsed.ok, true);

    if (!parsed.ok) return;

    const url = new URL(buildNominatimUrl(parsed.params, null));

    assert.equal(url.hostname, "nominatim.openstreetmap.org");
    assert.equal(url.searchParams.get("q"), "Café");
    assert.equal(url.searchParams.get("limit"), "7");
    assert.equal(url.searchParams.get("format"), "jsonv2");
    assert.equal(url.searchParams.get("extratags"), "1");
    assert.equal(url.searchParams.get("bounded"), "0");

    const viewbox = url.searchParams.get("viewbox");
    assert.ok(viewbox !== null && viewbox.split(",").length === 4);
  });

  it("uses category keywords when the query is empty", () => {
    const parsed = parsePlaceSearchParams(
      params("near=Leipzig&category=culture"),
    );

    assert.equal(parsed.ok, true);

    if (!parsed.ok) return;

    const url = new URL(
      buildNominatimUrl(parsed.params, {
        latitude: 51.34,
        longitude: 12.37,
      }),
    );

    assert.equal(url.searchParams.get("q"), "Museum");
    assert.ok(url.searchParams.get("viewbox") !== null);
  });

  it("builds a minimal geocode URL for manual areas", () => {
    const url = new URL(buildNominatimGeocodeUrl("Leipzig"));

    assert.equal(url.searchParams.get("q"), "Leipzig");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(url.searchParams.get("extratags"), "0");
  });
});

// --------------------------------------------------------------- mapping

describe("mapNominatimToPlaces", () => {
  it("copies provider fields verbatim", () => {
    const [place] = mapNominatimToPlaces([nominatimItem()], {
      category: "all",
      fetchedAt: FETCHED_AT,
    });

    assert.ok(place !== undefined);
    assert.equal(place?.name, "Café Central");
    assert.equal(
      place?.address,
      "Café Central, Augustusplatz 1, 04109 Leipzig",
    );
    assert.equal(place?.latitude, 51.3397);
    assert.equal(place?.longitude, 12.3731);
    assert.equal(place?.category, "food");
    assert.equal(place?.openingHours, "Mo-Fr 08:00-18:00");
    assert.match(place?.notes ?? "", /OSM: node\/123456/);
    assert.match(place?.notes ?? "", /example\.test/);
    assert.equal(place?.source.providerId, OSM_PROVIDER_ID);
    assert.equal(place?.source.fetchedAt, FETCHED_AT);
    assert.equal(place?.id, "osm-node-123456");
  });

  it("never invents cost, duration, setting, hours, or ratings", () => {
    const [place] = mapNominatimToPlaces(
      [nominatimItem({ extratags: {} })],
      { category: "all", fetchedAt: FETCHED_AT },
    );

    assert.ok(place !== undefined);
    assert.equal(place?.costCents, null);
    assert.equal(place?.durationMinutes, null);
    assert.equal(place?.setting, null);
    assert.equal(place?.openingHours, "");
    assert.ok(!("rating" in (place as unknown as Record<string, unknown>)));
    assert.ok(
      !JSON.stringify(place).toLowerCase().includes("rating"),
      "no rating text may appear",
    );
  });

  it("falls back to the display name and skips nameless hits", () => {
    const [named] = mapNominatimToPlaces(
      [
        nominatimItem({
          name: "",
          display_name: "Stadtpark, Leipzig",
        }),
      ],
      { category: "nature", fetchedAt: FETCHED_AT },
    );

    assert.equal(named?.name, "Stadtpark");

    const empty = mapNominatimToPlaces(
      [nominatimItem({ name: "", display_name: "   " })],
      { category: "all", fetchedAt: FETCHED_AT },
    );

    assert.equal(empty.length, 0);
  });

  it("nulls unparseable coordinates instead of guessing", () => {
    const [place] = mapNominatimToPlaces(
      [nominatimItem({ lat: "n/a", lon: "n/a" })],
      { category: "all", fetchedAt: FETCHED_AT },
    );

    assert.equal(place?.latitude, null);
    assert.equal(place?.longitude, null);
  });

  it("produces valid Place records (adopt/save compatible)", () => {
    const places = mapNominatimToPlaces(
      [
        nominatimItem(),
        nominatimItem({ osm_type: "way", osm_id: 9, type: "museum" }),
      ],
      { category: "all", fetchedAt: FETCHED_AT },
    );

    assert.equal(places.length, 2);
    assert.ok(places.every(isPlace));
  });
});

describe("mapOsmCategory", () => {
  it("maps common OSM types to app categories", () => {
    assert.equal(mapOsmCategory("amenity", "restaurant", "all"), "food");
    assert.equal(mapOsmCategory("amenity", "cinema", "all"), "cinema");
    assert.equal(mapOsmCategory("tourism", "museum", "all"), "culture");
    assert.equal(mapOsmCategory("leisure", "park", "all"), "nature");
    assert.equal(mapOsmCategory("leisure", "pitch", "all"), "sport");
    assert.equal(mapOsmCategory("natural", "wood", "all"), "nature");
    assert.equal(mapOsmCategory("historic", "castle", "all"), "culture");
    assert.equal(mapOsmCategory("sport", "tennis", "all"), "sport");
  });

  it("falls back to the requested category, else the generic bucket", () => {
    assert.equal(
      mapOsmCategory("amenity", "charging_station", "sport"),
      "sport",
    );
    assert.equal(
      mapOsmCategory("amenity", "charging_station", "all"),
      "culture",
    );
  });
});

describe("osmRefOfNotes", () => {
  it("round-trips the reference line and ignores manual notes", () => {
    const line = osmRefLine("node", 42);

    assert.equal(osmRefOfNotes(`${line}\nWeb: https://x.test`), "node/42");
    assert.equal(osmRefOfNotes("Eigene Notiz ohne Referenz"), null);
    assert.equal(osmRefOfNotes(""), null);
  });
});

describe("general suggestions fallback", () => {
  it("is labeled and carries no invented provider data", () => {
    assert.match(GENERAL_SUGGESTIONS_LABEL, /keine Live-Daten/i);
    assert.ok(GENERAL_SUGGESTIONS.length >= 5);

    for (const idea of GENERAL_SUGGESTIONS) {
      assert.deepEqual(Object.keys(idea).sort(), [
        "category",
        "hint",
        "title",
      ]);
      assert.ok(
        (PLACE_CATEGORIES as readonly string[]).includes(idea.category),
      );
      assert.ok(idea.title.trim() !== "" && idea.hint.trim() !== "");
    }
  });
});

// ------------------------------------------------------------------ route

type FetchCall = { url: string; headers: Record<string, string> };

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

beforeEach(() => {
  calls = [];
  __clearPlaceSearchCacheForTests();
  __resetPlaceSearchThrottleForTests();
  globalThis.fetch = (async (input: unknown, init?: {
    headers?: unknown;
  }) => {
    const url = String(input);
    calls.push({ url, headers: headersOf({ headers: init?.headers }) });

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

describe("GET /api/lifestyle/places/search", () => {
  it("returns mapped live places with a policy User-Agent", () => {
    upstream = (url) => {
      assert.match(url, /nominatim\.openstreetmap\.org/);

      return Response.json([nominatimItem()]);
    };

    return getJson(
      "/api/lifestyle/places/search?query=Caf%C3%A9&lat=51.34&lon=12.37",
    ).then(({ status, body }) => {
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const payload = body.data as PlaceSearchPayload;
      assert.equal(payload.places.length, 1);
      assert.equal(payload.places[0]?.name, "Café Central");
      assert.ok(payload.places.every(isPlace));
      assert.equal(payload.resolvedLocation, null);
      assert.equal(payload.notice, null);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.headers["User-Agent"], OSM_USER_AGENT);
      assert.match(calls[0]?.url ?? "", /viewbox=/);
    });
  });

  it("geocodes a manual area and reports it honestly", () => {
    upstream = (url) => {
      if (new URL(url).searchParams.get("limit") === "1") {
        return Response.json([
          nominatimItem({
            osm_type: "relation",
            osm_id: 1,
            display_name: "Leipzig, Sachsen, Deutschland",
            class: "place",
            type: "city",
            name: "Leipzig",
            extratags: {},
          }),
        ]);
      }

      return Response.json([nominatimItem()]);
    };

    return getJson(
      "/api/lifestyle/places/search?query=Museum&near=Leipzig",
    ).then(({ status, body }) => {
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const payload = body.data as PlaceSearchPayload;
      assert.equal(payload.places.length, 1);
      assert.equal(payload.resolvedLocation?.label, "Leipzig, Sachsen");
      assert.equal(payload.centerUsed?.latitude, 51.3397);
      assert.equal(calls.length, 2);
    });
  });

  it("answers an unknown area with empty results plus notice", () => {
    upstream = () => new Response("[]", { status: 200 });

    return getJson(
      "/api/lifestyle/places/search?query=Museum&near=Niwoxystadt",
    ).then(({ status, body }) => {
      assert.equal(status, 200);
      assert.equal(body.ok, true);

      const payload = body.data as PlaceSearchPayload;
      assert.equal(payload.places.length, 0);
      assert.match(payload.notice ?? "", /Niwoxystadt/);
      // Only the geocode call ran; no blind provider search followed.
      assert.equal(calls.length, 1);
    });
  });

  it("reports rate limits and outages honestly", async () => {
    upstream = () => new Response("slow down", { status: 429 });

    const limited = await getJson(
      "/api/lifestyle/places/search?query=Caf%C3%A9&lat=51&lon=12",
    );

    assert.equal(limited.status, 502);
    assert.match(limited.body.error?.message ?? "", /zu viele Anfragen/);

    __clearPlaceSearchCacheForTests();
    __resetPlaceSearchThrottleForTests();
    globalThis.fetch = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;

    const down = await getJson(
      "/api/lifestyle/places/search?query=Caf%C3%A9&lat=51&lon=12",
    );

    assert.equal(down.status, 502);
    assert.match(down.body.error?.message ?? "", /nicht erreichbar/);
  });

  it("rejects invalid requests and unexpected shapes", async () => {
    const bad = await getJson("/api/lifestyle/places/search");

    assert.equal(bad.status, 400);
    assert.equal(calls.length, 0);

    upstream = () => Response.json({ unexpected: true });

    const shaped = await getJson(
      "/api/lifestyle/places/search?query=Caf%C3%A9&lat=51&lon=12",
    );

    assert.equal(shaped.status, 502);
    assert.match(shaped.body.error?.message ?? "", /unerwartete Daten/);
  });

  it("caches identical searches within the TTL", async () => {
    upstream = () => Response.json([nominatimItem()]);

    const path =
      "/api/lifestyle/places/search?query=Caf%C3%A9&lat=51.34&lon=12.37";
    const first = await getJson(path);
    const second = await getJson(path);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls.length, 1);
  });

  it("validates provider payloads defensively", () => {
    assert.equal(isNominatimList([nominatimItem()]), true);
    assert.equal(isNominatimList([{ nope: true }]), false);
    assert.equal(isNominatimList({}), false);
  });
});

// ------------------------------------------------------------------ client

describe("searchLivePlaces", () => {
  it("sends params and parses the payload", async () => {
    const payload: PlaceSearchPayload = {
      places: mapNominatimToPlaces([nominatimItem()], {
        category: "all",
        fetchedAt: FETCHED_AT,
      }),
      resolvedLocation: null,
      centerUsed: { latitude: 51.34, longitude: 12.37 },
      notice: null,
      fetchedAt: FETCHED_AT,
      diagnostics: {
        requestedCategory: "all",
        detectedCategory: "food",
        effectiveCategory: "food",
        provider: "nominatim",
        cache: "miss",
        rawCount: 1,
        filteredCount: 1,
      },
    };
    let seenUrl = "";

    const result = await searchLivePlaces(
      {
        query: "Café",
        near: "",
        latitude: 51.34,
        longitude: 12.37,
        radiusKm: 10,
        category: "food",
        limit: 10,
      },
      (async (url: string) => {
        seenUrl = url;

        return Response.json({ ok: true, data: payload });
      }) as typeof fetch,
    );

    assert.equal(result.ok, true);

    if (!result.ok) return;

    assert.equal(result.places.length, 1);
    assert.match(seenUrl, /category=food/);
    assert.match(seenUrl, /lat=51\.34/);
  });

  it("drops invalid places and surfaces failures honestly", async () => {
    const payload = {
      places: [
        ...mapNominatimToPlaces([nominatimItem()], {
          category: "all",
          fetchedAt: FETCHED_AT,
        }),
        { broken: true },
      ],
      resolvedLocation: null,
      centerUsed: null,
      notice: null,
      fetchedAt: FETCHED_AT,
      diagnostics: {
        requestedCategory: "all",
        detectedCategory: "all",
        effectiveCategory: "all",
        provider: "nominatim",
        cache: "miss",
        rawCount: 2,
        filteredCount: 1,
      },
    };

    const filtered = await searchLivePlaces(
      {
        query: "x",
        near: "",
        latitude: 51,
        longitude: 12,
        radiusKm: 10,
        category: "all",
        limit: 5,
      },
      (async () =>
        Response.json({ ok: true, data: payload })) as typeof fetch,
    );

    assert.equal(filtered.ok, true);

    if (!filtered.ok) return;

    assert.equal(filtered.places.length, 1);

    const offline = await searchLivePlaces(
      {
        query: "x",
        near: "",
        latitude: 51,
        longitude: 12,
        radiusKm: 10,
        category: "all",
        limit: 5,
      },
      (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    );

    assert.equal(offline.ok, false);

    if (offline.ok) return;

    assert.match(offline.error, /nicht erreichbar/);

    const serverError = await searchLivePlaces(
      {
        query: "x",
        near: "",
        latitude: 51,
        longitude: 12,
        radiusKm: 10,
        category: "all",
        limit: 5,
      },
      (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "upstream-error", message: "Anbieter pausiert." },
          }),
          { status: 502 },
        )) as typeof fetch,
    );

    assert.equal(serverError.ok, false);

    if (serverError.ok) return;

    assert.equal(serverError.error, "Anbieter pausiert.");
  });
});

// --------------------------------------------------------- assistant wire

const PREFS: LifestylePreferences = {
  city: "Leipzig",
  useGeolocation: false,
  latitude: null,
  longitude: null,
  radiusKm: 10,
  maxBudgetCents: null,
  categories: [],
  setting: "any",
  maxDurationMinutes: null,
  company: "any",
};

const LIVE_PLACE: Place = {
  id: "osm-node-123456",
  name: "Café Central",
  category: "food",
  address: "Augustusplatz 1, 04109 Leipzig",
  latitude: 51.3397,
  longitude: 12.3731,
  costCents: null,
  durationMinutes: null,
  setting: null,
  openingHours: "Mo-Fr 08:00-18:00",
  notes: "OSM: node/123456",
  source: {
    providerId: OSM_PROVIDER_ID,
    label: "OpenStreetMap (live)",
    fetchedAt: FETCHED_AT,
  },
  createdAt: FETCHED_AT,
  updatedAt: FETCHED_AT,
};

describe("assistant places wiring", () => {
  it("registers places search and saved-places reads", () => {
    const search = getToolDefinition("lifestyle.placesSearch");
    const saved = getToolDefinition("lifestyle.saved");

    assert.ok(search !== null);
    assert.equal(search?.permission, "read");
    assert.ok(saved !== null);
    assert.equal(saved?.permission, "read");

    for (const tool of ASSISTANT_TOOLS) {
      assert.equal(
        typeof MODEL_PARAMS[tool.id],
        "string",
        `missing MODEL_PARAMS for ${tool.id}`,
      );
    }
  });

  it("runs lifestyle.placesSearch through the agent loop", async () => {
    const seen: Record<string, unknown>[] = [];
    const script = [
      JSON.stringify({
        tool: "lifestyle.placesSearch",
        args: { query: "Café", limit: 3 },
      }),
      JSON.stringify({ final: "Café Central passt." }),
    ];

    const outcome = await runAgent("Finde ein Café.", {
      chat: (async () => script.shift() ?? JSON.stringify({ final: "?" })) as (
        messages: unknown,
      ) => Promise<string>,
      data: {
        events: [],
        finance: EMPTY_FINANCE,
        tasks: [],
        study: EMPTY_STUDY,
        places: [],
        savedIds: [],
        plans: [],
        prefs: PREFS,
        memory: [],
        todayISO: "2026-11-03",
        nowTime: "12:00",
      },
      stores: {
        calendar: {
          create: (async () => ({ ok: false as const, error: "x" })) as never,
          update: (async () => ({ ok: false as const, error: "x" })) as never,
          remove: (async () => ({ ok: false as const, error: "x" })) as never,
        },
        transactions: {
          saveTransaction: (async () => ({
            ok: false as const,
            error: "x",
          })) as never,
          deleteTransaction: (async () => ({
            ok: false as const,
            error: "x",
          })) as never,
        },
      },
      locale: "de",
      asyncReads: {
        "lifestyle.placesSearch": (async (args: Record<string, unknown>) => {
          seen.push(args);

          return {
            ok: true as const,
            data: {
              places: [LIVE_PLACE],
              resolvedLocation: null,
              notice: null,
            },
          };
        }) as never,
      },
    });

    assert.equal(outcome.status, "done");

    if (outcome.status !== "done") return;

    assert.equal(outcome.steps.length, 1);
    assert.equal(outcome.steps[0]?.tool, "lifestyle.placesSearch");
    assert.equal(outcome.steps[0]?.ok, true);
    assert.equal(seen[0]?.query, "Café");
  });

  it("summarizes live results heuristically without inventing data", async () => {
    const chat = createHeuristicChat({
      todayISO: "2026-11-03",
      nowTime: "12:00",
      timezone: "Europe/Berlin",
      locale: "de",
    });

    const withHits = JSON.parse(
      await chat([
        { role: "user", content: "Finde ein Café." },
        {
          role: "assistant",
          content: JSON.stringify({
            tool: "lifestyle.placesSearch",
            args: { query: "Café" },
          }),
        },
        {
          role: "tool",
          content: JSON.stringify({
            ok: true,
            data: {
              places: [LIVE_PLACE],
              resolvedLocation: null,
              notice: null,
            },
          }),
        },
      ]),
    ) as { final: string };

    assert.match(withHits.final, /Café Central/);
    assert.match(withHits.final, /Augustusplatz/);
    assert.match(withHits.final, /OpenStreetMap/);
    assert.ok(!withHits.final.includes("rating"));

    const empty = JSON.parse(
      await chat([
        { role: "user", content: "Finde ein Café." },
        {
          role: "assistant",
          content: JSON.stringify({
            tool: "lifestyle.placesSearch",
            args: { query: "Café" },
          }),
        },
        {
          role: "tool",
          content: JSON.stringify({
            ok: true,
            data: { places: [], resolvedLocation: null, notice: null },
          }),
        },
      ]),
    ) as { final: string };

    assert.match(empty.final, /Keine Orte gefunden/);

    const failed = JSON.parse(
      await chat([
        { role: "user", content: "Finde ein Café." },
        {
          role: "assistant",
          content: JSON.stringify({
            tool: "lifestyle.placesSearch",
            args: { query: "Café" },
          }),
        },
        {
          role: "tool",
          content: JSON.stringify({
            ok: false,
            error: { code: "unavailable", message: "Anbieter pausiert." },
          }),
        },
      ]),
    ) as { final: string };

    assert.match(failed.final, /Anbieter pausiert/);
  });
});
