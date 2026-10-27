import { NextResponse } from "next/server";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import type { WeatherCity } from "@/src/lib/weather";

/**
 * GET /api/weather/search?name=
 * Public (no login): Open-Meteo geocoding needs no key. Short-lived
 * cache per normalized query; results drive the city picker.
 */

const CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const cache = new Map<string, { expires: number; cities: WeatherCity[] }>();

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const query = (url.searchParams.get("name") ?? "").trim();

    if (query.length < 2 || query.length > 100) {
      return fail("bad-request", "Bitte gib mindestens 2 Zeichen ein.", 400);
    }

    const key = query.toLowerCase();
    const cached = cache.get(key);

    if (cached !== undefined && cached.expires > Date.now()) {
      return ok(cached.cities);
    }

    const upstream = new URL("https://geocoding-api.open-meteo.com/v1/search");
    upstream.searchParams.set("name", query);
    upstream.searchParams.set("count", "6");
    upstream.searchParams.set("language", "de");
    upstream.searchParams.set("format", "json");

    let res: Response;

    try {
      res = await fetch(upstream, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return fail(
        "upstream-error",
        "Stadtsuche nicht erreichbar. Bitte versuche es später erneut.",
        502,
      );
    }

    if (!res.ok) {
      return fail("upstream-error", "Stadtsuche fehlgeschlagen.", 502);
    }

    const payload = (await res.json().catch(() => null)) as {
      results?: unknown;
    } | null;

    const results = Array.isArray(payload?.results) ? payload.results : [];
    const cities: WeatherCity[] = [];

    for (const entry of results) {
      if (typeof entry !== "object" || entry === null) continue;

      const record = entry as Record<string, unknown>;

      if (
        typeof record.name !== "string" ||
        record.name === "" ||
        typeof record.latitude !== "number" ||
        !Number.isFinite(record.latitude) ||
        typeof record.longitude !== "number" ||
        !Number.isFinite(record.longitude)
      ) {
        continue;
      }

      const parts = [record.admin1, record.country].filter(
        (part): part is string =>
          typeof part === "string" && part !== "" && part !== record.name,
      );

      cities.push({
        name: record.name,
        latitude: record.latitude,
        longitude: record.longitude,
        detail: parts.join(", "),
      });

      if (cities.length >= 6) break;
    }

    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, cities });

    return ok(cities);
  } catch (error) {
    return failFromUnknown("weather/search", error);
  }
}
