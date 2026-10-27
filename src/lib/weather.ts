/**
 * Weather domain: Open-Meteo WMO code mapping (German labels), city
 * persistence, and shared response shapes. No API key needed; all
 * provider calls run server-side in `/api/weather/*` with caching.
 */

export type WeatherCity = {
  name: string;
  latitude: number;
  longitude: number;
  /** Optional disambiguation ("Baden-Württemberg, Deutschland"). */
  detail: string;
};

export const WEATHER_CITY_KEY = "jarvis-weather-city";

export const DEFAULT_CITY: WeatherCity = {
  name: "Stuttgart",
  latitude: 48.7758,
  longitude: 9.1829,
  detail: "Baden-Württemberg, Deutschland",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isWeatherCity(value: unknown): value is WeatherCity {
  if (!isRecord(value)) return false;

  return (
    typeof value.name === "string" &&
    value.name !== "" &&
    typeof value.latitude === "number" &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    typeof value.longitude === "number" &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    typeof value.detail === "string"
  );
}

export type ConditionKind =
  | "clear"
  | "partly"
  | "overcast"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "storm";

export type ConditionInfo = {
  kind: ConditionKind;
  label: string;
};

/** WMO weather-code interpretation (Open-Meteo `weather_code`). */
export function describeCode(code: number): ConditionInfo {
  if (code === 0) return { kind: "clear", label: "Klar" };
  if (code === 1) return { kind: "clear", label: "Überwiegend klar" };
  if (code === 2) return { kind: "partly", label: "Wechselhaft" };
  if (code === 3) return { kind: "overcast", label: "Bedeckt" };
  if (code === 45 || code === 48)
    return { kind: "fog", label: "Nebel" };
  if (code >= 51 && code <= 57)
    return { kind: "drizzle", label: "Nieselregen" };
  if (code >= 61 && code <= 67)
    return { kind: "rain", label: "Regen" };
  if (code >= 71 && code <= 77)
    return { kind: "snow", label: "Schnee" };
  if (code >= 80 && code <= 82)
    return { kind: "rain", label: "Regenschauer" };
  if (code === 95) return { kind: "storm", label: "Gewitter" };
  if (code === 96 || code === 99)
    return { kind: "storm", label: "Gewitter mit Hagel" };

  return { kind: "partly", label: "Wechselhaft" };
}

const COMPASS = [
  "N",
  "NNO",
  "NO",
  "ONO",
  "O",
  "OSO",
  "SO",
  "SSO",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

/** Degrees (0-360) → 16-wind compass label. */
export function compassLabel(degrees: number): string {
  if (!Number.isFinite(degrees)) return "";

  const index =
    Math.round(((degrees % 360) + 360) % 360 / 22.5) % COMPASS.length;

  return COMPASS[index];
}

export type WeatherNow = {
  temperature: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  windDirection: number;
  code: number;
  isDay: boolean;
  high: number;
  low: number;
};

export type HourPoint = {
  time: string;
  temperature: number;
  code: number;
};

export type DayPoint = {
  date: string;
  code: number;
  high: number;
  low: number;
};

export type WeatherReport = {
  city: WeatherCity;
  now: WeatherNow;
  hourly: HourPoint[];
  daily: DayPoint[];
  /** ISO timestamp of the successful provider fetch. */
  fetchedAt: string;
};

export function isWeatherReport(value: unknown): value is WeatherReport {
  if (!isRecord(value)) return false;
  if (!isWeatherCity(value.city)) return false;
  if (!isRecord(value.now)) return false;

  const now = value.now as Record<string, unknown>;
  const numbers = [
    "temperature",
    "feelsLike",
    "humidity",
    "windSpeed",
    "windDirection",
    "code",
    "high",
    "low",
  ];

  for (const key of numbers) {
    if (typeof now[key] !== "number" || !Number.isFinite(now[key])) {
      return false;
    }
  }

  if (typeof now.isDay !== "boolean") return false;
  if (!Array.isArray(value.hourly) || !Array.isArray(value.daily)) {
    return false;
  }
  if (typeof value.fetchedAt !== "string") return false;

  return true;
}

/** "14:00" from an ISO local timestamp ("2026-10-27T14:00"). */
export function hourLabel(isoLocal: string): string {
  return isoLocal.length >= 16 ? isoLocal.slice(11, 16) : isoLocal;
}

const DAY_FORMAT = new Intl.DateTimeFormat("de-DE", { weekday: "short" });

/** "Mi" from a YYYY-MM-DD date. */
export function dayLabel(dateISO: string): string {
  const parsed = new Date(`${dateISO}T12:00:00Z`);

  if (Number.isNaN(parsed.getTime())) return dateISO;

  return DAY_FORMAT.format(parsed);
}

const TIME_FORMAT = new Intl.DateTimeFormat("de-DE", {
  hour: "2-digit",
  minute: "2-digit",
});

/** "14:32" from an ISO timestamp (invalid input → ""). */
export function updatedLabel(iso: string): string {
  const parsed = new Date(iso);

  if (Number.isNaN(parsed.getTime())) return "";

  return TIME_FORMAT.format(parsed);
}
