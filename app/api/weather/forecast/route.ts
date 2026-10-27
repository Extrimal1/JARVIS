import { NextResponse } from "next/server";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import {
  DEFAULT_CITY,
  type DayPoint,
  type HourPoint,
  type WeatherReport,
} from "@/src/lib/weather";

/**
 * GET /api/weather/forecast?latitude=&longitude=&name=&detail=
 * Public (no login): Open-Meteo data needs no key and carries no user
 * data. Responses are cached in-memory for 10 minutes per ~1km cell so
 * reloads and the 15-minute client refresh never hammer the provider.
 * Never fabricates readings: provider failures surface as errors.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

type CacheEntry = { expires: number; report: WeatherReport };

const cache = new Map<string, CacheEntry>();

function cacheKey(latitude: number, longitude: number): string {
  return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
}

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type OpenMeteoResponse = {
  current?: {
    temperature_2m?: unknown;
    relative_humidity_2m?: unknown;
    apparent_temperature?: unknown;
    is_day?: unknown;
    weather_code?: unknown;
    wind_speed_10m?: unknown;
    wind_direction_10m?: unknown;
    time?: unknown;
  };
  hourly?: {
    time?: unknown;
    temperature_2m?: unknown;
    weather_code?: unknown;
  };
  daily?: {
    time?: unknown;
    weather_code?: unknown;
    temperature_2m_max?: unknown;
    temperature_2m_min?: unknown;
  };
};

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isNum);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string",
  );
}

function shapeReport(
  payload: OpenMeteoResponse,
  city: { name: string; latitude: number; longitude: number; detail: string },
): WeatherReport | null {
  const current = payload.current;
  if (current === undefined) return null;

  const {
    temperature_2m: temp,
    relative_humidity_2m: humidity,
    apparent_temperature: feelsLike,
    is_day: isDay,
    weather_code: code,
    wind_speed_10m: windSpeed,
    wind_direction_10m: windDirection,
    time: nowTime,
  } = current;

  if (
    !isNum(temp) ||
    !isNum(humidity) ||
    !isNum(feelsLike) ||
    (isDay !== 0 && isDay !== 1) ||
    !isNum(code) ||
    !isNum(windSpeed) ||
    !isNum(windDirection) ||
    typeof nowTime !== "string"
  ) {
    return null;
  }

  const dailyTimes = toStringArray(payload.daily?.time);
  const dailyCodes = toNumberArray(payload.daily?.weather_code);
  const dailyMax = toNumberArray(payload.daily?.temperature_2m_max);
  const dailyMin = toNumberArray(payload.daily?.temperature_2m_min);

  if (
    dailyTimes.length === 0 ||
    dailyCodes.length === 0 ||
    dailyMax.length === 0 ||
    dailyMin.length === 0
  ) {
    return null;
  }

  const hourlyTimes = toStringArray(payload.hourly?.time);
  const hourlyTemps = toNumberArray(payload.hourly?.temperature_2m);
  const hourlyCodes = toNumberArray(payload.hourly?.weather_code);

  const hourly: HourPoint[] = [];
  const start = hourlyTimes.findIndex((stamp) => stamp >= nowTime.slice(0, 13));

  for (
    let index = Math.max(0, start);
    index < hourlyTimes.length && hourly.length < 6;
    index += 1
  ) {
    const time = hourlyTimes[index];
    const temperature = hourlyTemps[index];
    const hourCode = hourlyCodes[index];

    if (
      time === undefined ||
      temperature === undefined ||
      hourCode === undefined
    ) {
      continue;
    }

    hourly.push({ time, temperature: Math.round(temperature), code: hourCode });
  }

  const daily: DayPoint[] = [];
  const days = Math.min(
    5,
    dailyTimes.length,
    dailyCodes.length,
    dailyMax.length,
    dailyMin.length,
  );

  for (let index = 0; index < days; index += 1) {
    daily.push({
      date: (dailyTimes[index] ?? "").slice(0, 10),
      code: dailyCodes[index] ?? 3,
      high: Math.round(dailyMax[index] ?? temp),
      low: Math.round(dailyMin[index] ?? temp),
    });
  }

  return {
    city: {
      name: city.name,
      latitude: city.latitude,
      longitude: city.longitude,
      detail: city.detail,
    },
    now: {
      temperature: Math.round(temp),
      feelsLike: Math.round(feelsLike),
      humidity: Math.round(humidity),
      windSpeed: Math.round(windSpeed),
      windDirection: Math.round(windDirection),
      code,
      isDay: isDay === 1,
      high: daily[0]?.high ?? Math.round(temp),
      low: daily[0]?.low ?? Math.round(temp),
    },
    hourly,
    daily,
    fetchedAt: new Date().toISOString(),
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const latitude = Number(url.searchParams.get("latitude"));
    const longitude = Number(url.searchParams.get("longitude"));
    const name = (url.searchParams.get("name") ?? "").slice(0, 120);
    const detail = (url.searchParams.get("detail") ?? "").slice(0, 160);

    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      return fail("bad-request", "Ungültige Koordinaten.", 400);
    }

    const key = cacheKey(latitude, longitude);
    const cached = cache.get(key);

    if (cached !== undefined && cached.expires > Date.now()) {
      return ok({ ...cached.report, fetchedAt: cached.report.fetchedAt });
    }

    const upstream = new URL("https://api.open-meteo.com/v1/forecast");
    upstream.searchParams.set("latitude", String(latitude));
    upstream.searchParams.set("longitude", String(longitude));
    upstream.searchParams.set(
      "current",
      "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,wind_direction_10m",
    );
    upstream.searchParams.set("hourly", "temperature_2m,weather_code");
    upstream.searchParams.set(
      "daily",
      "weather_code,temperature_2m_max,temperature_2m_min",
    );
    upstream.searchParams.set("timezone", "auto");
    upstream.searchParams.set("forecast_days", "6");
    upstream.searchParams.set("temperature_unit", "celsius");
    upstream.searchParams.set("wind_speed_unit", "kmh");
    upstream.searchParams.set("timeformat", "iso8601");

    let res: Response;

    try {
      res = await fetch(upstream, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      return fail(
        "upstream-error",
        "Wetterdienst nicht erreichbar. Bitte versuche es später erneut.",
        502,
      );
    }

    if (res.status === 429) {
      return fail(
        "upstream-error",
        "Zu viele Wetteranfragen. Bitte warte einen Moment.",
        502,
      );
    }

    if (!res.ok) {
      return fail(
        "upstream-error",
        "Wetterdaten konnten nicht geladen werden.",
        502,
      );
    }

    const payload = (await res.json().catch(
      () => null,
    )) as OpenMeteoResponse | null;

    if (payload === null) {
      return fail(
        "upstream-error",
        "Wetterdaten konnten nicht geladen werden.",
        502,
      );
    }

    const report = shapeReport(payload, {
      name: name === "" ? DEFAULT_CITY.name : name,
      latitude,
      longitude,
      detail,
    });

    if (report === null) {
      return fail(
        "upstream-error",
        "Wetterdaten konnten nicht geladen werden.",
        502,
      );
    }

    cache.set(key, { expires: Date.now() + CACHE_TTL_MS, report });

    return ok(report);
  } catch (error) {
    return failFromUnknown("weather/forecast", error);
  }
}
