import { isWeatherCity, type WeatherCity } from "@/src/lib/weather";

/**
 * Morning Briefing schedule: personalized daily delivery time, default
 * 07:30 Europe/Berlin. Pure and dependency-free (shared by routes,
 * dispatch, the settings UI, and tests).
 */

export const BRIEFING_TIME_DEFAULT = "07:30";
export const BRIEFING_TIMEZONE_DEFAULT = "Europe/Berlin";
export const BRIEFING_SETTINGS_KEY = "jarvis-briefing-settings";

export type BriefingSettings = {
  enabled: boolean;
  /** Local delivery time as HH:MM (24h). */
  time: string;
  /** IANA timezone. */
  timezone: string;
  /** Weather city; null = default city (Stuttgart). */
  city: WeatherCity | null;
  /** Comma-separated RSS interest keywords, "" = all. */
  interests: string;
};

export const DEFAULT_BRIEFING_SETTINGS: BriefingSettings = {
  enabled: true,
  time: BRIEFING_TIME_DEFAULT,
  timezone: BRIEFING_TIMEZONE_DEFAULT,
  city: null,
  interests: "",
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isBriefingTime(value: unknown): value is string {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

/** True when `value` is a loadable IANA timezone. */
export function isTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function isBriefingSettings(value: unknown): value is BriefingSettings {
  if (typeof value !== "object" || value === null) return false;

  const settings = value as Record<string, unknown>;

  return (
    typeof settings.enabled === "boolean" &&
    isBriefingTime(settings.time) &&
    isTimezone(settings.timezone) &&
    (settings.city === null || isWeatherCity(settings.city)) &&
    typeof settings.interests === "string"
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function partsInTimezone(
  now: Date,
  timezone: string,
): { date: string; time: string } | null {
  if (!isTimezone(timezone)) return null;

  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);

    const get = (type: string): string =>
      parts.find((part) => part.type === type)?.value ?? "";

    const date = `${get("year")}-${get("month")}-${get("day")}`;
    const time = `${pad2(Number(get("hour")))}:${pad2(Number(get("minute")))}`;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isBriefingTime(time)) {
      return null;
    }

    return { date, time };
  } catch {
    return null;
  }
}

/**
 * Local calendar date (YYYY-MM-DD) in the given timezone.
 * Falls back to UTC when the timezone is invalid (never throws).
 */
export function localDateInTimezone(now: Date, timezone: string): string {
  const parts = partsInTimezone(now, timezone);

  if (parts !== null) return parts.date;

  return `${now.getUTCFullYear()}-${pad2(now.getUTCMonth() + 1)}-${pad2(now.getUTCDate())}`;
}

/**
 * A briefing is due when it is enabled, the local time in the user's
 * timezone has reached the scheduled time, and no briefing was sent
 * yet for that local date. Dispatch runs every few minutes; this
 * keeps delivery to once per day without missing late schedule edits
 * on days nothing was sent yet.
 */
export function isBriefingDue(
  settings: Pick<BriefingSettings, "enabled" | "time" | "timezone">,
  now: Date,
  lastSentLocalDate: string | null,
): boolean {
  if (!settings.enabled) return false;

  const parts = partsInTimezone(now, settings.timezone);

  if (parts === null) return false;
  if (lastSentLocalDate === parts.date) return false;

  return parts.time >= settings.time;
}

/** German one-liner for the settings UI ("Täglich um 07:30 (Europe/Berlin)"). */
export function describeSchedule(
  settings: Pick<BriefingSettings, "enabled" | "time" | "timezone">,
): string {
  if (!settings.enabled) return "Morgen-Briefing ist deaktiviert.";

  return `Täglich um ${settings.time} (${settings.timezone})`;
}
