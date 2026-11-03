import {
  DEFAULT_CITY,
  type DayPoint,
  type HourPoint,
  type WeatherCity,
  type WeatherReport,
} from "@/src/lib/weather";

/**
 * Open-Meteo provider (SERVER-ONLY — called from API routes and the
 * briefing dispatch). No API key needed. Responses are cached
 * in-memory for 10 minutes per ~1km cell. Never fabricates readings:
 * provider failures throw a typed WeatherProviderError.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

type CacheEntry = { expires: number; report: WeatherReport };

const cache = new Map<string, CacheEntry>();

export type WeatherProviderErrorKind =
  | "network"
  | "rate-limited"
  | "bad-response"
  | "bad-payload";

export class WeatherProviderError extends Error {
  kind: WeatherProviderErrorKind;

  constructor(kind: WeatherProviderErrorKind, message: string) {
    super(message);
    this.name = "WeatherProviderError";
    this.kind = kind;
  }
}

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

export type WeatherQuery = {
  latitude: number;
  longitude: number;
  name?: string;
  detail?: string;
};

export async function getWeatherReport(
  query: WeatherQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<WeatherReport> {
  const key = cacheKey(query.latitude, query.longitude);
  const cached = cache.get(key);

  if (cached !== undefined && cached.expires > Date.now()) {
    return { ...cached.report };
  }

  const upstream = new URL("https://api.open-meteo.com/v1/forecast");
  upstream.searchParams.set("latitude", String(query.latitude));
  upstream.searchParams.set("longitude", String(query.longitude));
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
    res = await fetchImpl(upstream, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new WeatherProviderError(
      "network",
      "Wetterdienst nicht erreichbar. Bitte versuche es später erneut.",
    );
  }

  if (res.status === 429) {
    throw new WeatherProviderError(
      "rate-limited",
      "Zu viele Wetteranfragen. Bitte warte einen Moment.",
    );
  }

  if (!res.ok) {
    throw new WeatherProviderError(
      "bad-response",
      "Wetterdaten konnten nicht geladen werden.",
    );
  }

  const payload = (await res.json().catch(
    () => null,
  )) as OpenMeteoResponse | null;

  if (payload === null) {
    throw new WeatherProviderError(
      "bad-payload",
      "Wetterdaten konnten nicht geladen werden.",
    );
  }

  const report = shapeReport(payload, {
    name: query.name === undefined || query.name === "" ? DEFAULT_CITY.name : query.name,
    latitude: query.latitude,
    longitude: query.longitude,
    detail: query.detail ?? "",
  });

  if (report === null) {
    throw new WeatherProviderError(
      "bad-payload",
      "Wetterdaten konnten nicht geladen werden.",
    );
  }

  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, report });

  return report;
}

export function weatherForCity(
  city: WeatherCity,
  fetchImpl?: typeof fetch,
): Promise<WeatherReport> {
  return getWeatherReport(
    {
      latitude: city.latitude,
      longitude: city.longitude,
      name: city.name,
      detail: city.detail,
    },
    fetchImpl,
  );
}
