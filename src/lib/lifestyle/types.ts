import {
  parseISODateLocal,
  timeToMinutes,
} from "@/src/lib/calendar";

export const PLACE_CATEGORIES = [
  "nature",
  "food",
  "culture",
  "sport",
  "cinema",
  "date",
  "free",
] as const;

export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

/** Events additionally allow the generic "Veranstaltungen" category. */
export type EventCategory = PlaceCategory | "events";

export const CATEGORY_LABELS: Record<PlaceCategory | "events", string> = {
  nature: "Natur & Spaziergänge",
  food: "Cafés & Restaurants",
  culture: "Kultur & Museen",
  sport: "Sport & Aktivitäten",
  cinema: "Kino & Unterhaltung",
  date: "Date-Ideen",
  free: "Kostenlose Aktivitäten",
  events: "Veranstaltungen",
};

export type PlaceSetting = "indoor" | "outdoor" | "both";

export type DataSource = {
  providerId: string;
  label: string;
  /** Null for manual entries (see updatedAt instead). */
  fetchedAt: string | null;
};

export type Place = {
  id: string;
  name: string;
  category: PlaceCategory;
  address: string;
  latitude: number | null;
  longitude: number | null;
  /** Typical cost per person in cents. Null = unknown. 0 = free. */
  costCents: number | null;
  /** Typical duration in minutes. Null = unknown. */
  durationMinutes: number | null;
  setting: PlaceSetting | null;
  /** Free text as entered; never claimed to be verified. */
  openingHours: string;
  notes: string;
  source: DataSource;
  createdAt: string;
  updatedAt: string;
};

export type PlaceEvent = {
  id: string;
  title: string;
  category: EventCategory;
  venue: string;
  address: string;
  /** Local date as YYYY-MM-DD. */
  date: string;
  endDate: string | null;
  /** Start time as HH:MM, "" when unknown. */
  time: string;
  /** Null = unknown, 0 = free entry. */
  priceCents: number | null;
  bookingUrl: string;
  notes: string;
  source: DataSource;
  createdAt: string;
  updatedAt: string;
};

export type OutingCompany = "any" | "solo" | "friends" | "date";
export type SettingPreference = "any" | "indoor" | "outdoor";

export type LifestylePreferences = {
  /** Manually entered city or area, "" when unset. */
  city: string;
  useGeolocation: boolean;
  /** Stored only after explicit opt-in, never silently. */
  latitude: number | null;
  longitude: number | null;
  radiusKm: number;
  maxBudgetCents: number | null;
  categories: PlaceCategory[];
  setting: SettingPreference;
  maxDurationMinutes: number | null;
  company: OutingCompany;
};

export type OutingStop = {
  placeId: string;
  note: string;
};

export type OutingPlan = {
  id: string;
  title: string;
  date: string;
  durationMinutes: number | null;
  budgetCents: number | null;
  categories: PlaceCategory[];
  stops: OutingStop[];
  notes: string;
  createdAt: string;
  updatedAt: string;
};

export const LIFESTYLE_PLACES_KEY = "jarvis-lifestyle-places";
export const LIFESTYLE_EVENTS_KEY = "jarvis-lifestyle-events";
export const LIFESTYLE_PREFS_KEY = "jarvis-lifestyle-prefs";
export const LIFESTYLE_SAVED_KEY = "jarvis-lifestyle-saved";
export const LIFESTYLE_PLANS_KEY = "jarvis-lifestyle-plans";

export const EMPTY_PLACES: Place[] = [];
export const EMPTY_LIFESTYLE_EVENTS: PlaceEvent[] = [];
export const EMPTY_SAVED: string[] = [];
export const EMPTY_PLANS: OutingPlan[] = [];

export const DEFAULT_PREFERENCES: LifestylePreferences = {
  city: "",
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

/** Great-circle distance in kilometres. Pure math, no API involved. */
export function haversineKm(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): number {
  const earthKm = 6371;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(fromLat)) *
      Math.cos(toRadians(toLat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return 2 * earthKm * Math.asin(Math.sqrt(a));
}

export function formatDistanceKm(km: number): string {
  if (!Number.isFinite(km) || km < 0) return "–";
  if (km < 1) return `${Math.round(km * 1000)} m`;

  return `${km.toFixed(1).replace(".", ",")} km`;
}

const DAY_MEDIUM_FORMAT = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeZone: "UTC",
});

/** Local calendar date ("26.10.2026"); raw input when invalid. */
export function formatDayMedium(dateISO: string): string {
  if (parseISODateLocal(dateISO) === null) return dateISO;

  return DAY_MEDIUM_FORMAT.format(new Date(`${dateISO}T12:00:00Z`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0
  );
}

function isLatitude(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -90 &&
    value <= 90
  );
}

function isLongitude(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -180 &&
    value <= 180
  );
}

function isPlaceCategory(value: unknown): value is PlaceCategory {
  return (
    typeof value === "string" &&
    (PLACE_CATEGORIES as readonly string[]).includes(value)
  );
}

function isEventCategory(value: unknown): value is EventCategory {
  return (
    isPlaceCategory(value) || value === "events"
  );
}

function isDataSource(value: unknown): value is DataSource {
  if (!isRecord(value)) return false;

  return (
    typeof value.providerId === "string" &&
    typeof value.label === "string" &&
    (value.fetchedAt === null || typeof value.fetchedAt === "string")
  );
}

export function isPlace(value: unknown): value is Place {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.name === "string" &&
    isPlaceCategory(value.category) &&
    typeof value.address === "string" &&
    (value.latitude === null || isLatitude(value.latitude)) &&
    (value.longitude === null || isLongitude(value.longitude)) &&
    (value.costCents === null || isNonNegativeInt(value.costCents)) &&
    (value.durationMinutes === null ||
      (typeof value.durationMinutes === "number" &&
        Number.isInteger(value.durationMinutes) &&
        value.durationMinutes > 0)) &&
    (value.setting === null ||
      value.setting === "indoor" ||
      value.setting === "outdoor" ||
      value.setting === "both") &&
    typeof value.openingHours === "string" &&
    typeof value.notes === "string" &&
    isDataSource(value.source) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

export function isPlaceList(value: unknown): value is Place[] {
  return Array.isArray(value) && value.every(isPlace);
}

export function isPlaceEvent(value: unknown): value is PlaceEvent {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.title === "string" &&
    isEventCategory(value.category) &&
    typeof value.venue === "string" &&
    typeof value.address === "string" &&
    typeof value.date === "string" &&
    parseISODateLocal(value.date) !== null &&
    (value.endDate === null ||
      (typeof value.endDate === "string" &&
        parseISODateLocal(value.endDate) !== null)) &&
    typeof value.time === "string" &&
    (value.time === "" || timeToMinutes(value.time) !== null) &&
    (value.priceCents === null || isNonNegativeInt(value.priceCents)) &&
    typeof value.bookingUrl === "string" &&
    (value.bookingUrl === "" || /^https?:\/\/.+/i.test(value.bookingUrl)) &&
    typeof value.notes === "string" &&
    isDataSource(value.source) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

export function isPlaceEventList(value: unknown): value is PlaceEvent[] {
  return Array.isArray(value) && value.every(isPlaceEvent);
}

export function isLifestylePreferences(
  value: unknown,
): value is LifestylePreferences {
  if (!isRecord(value)) return false;

  return (
    typeof value.city === "string" &&
    typeof value.useGeolocation === "boolean" &&
    (value.latitude === null || isLatitude(value.latitude)) &&
    (value.longitude === null || isLongitude(value.longitude)) &&
    typeof value.radiusKm === "number" &&
    Number.isFinite(value.radiusKm) &&
    value.radiusKm > 0 &&
    (value.maxBudgetCents === null ||
      isNonNegativeInt(value.maxBudgetCents)) &&
    Array.isArray(value.categories) &&
    value.categories.every(isPlaceCategory) &&
    (value.setting === "any" ||
      value.setting === "indoor" ||
      value.setting === "outdoor") &&
    (value.maxDurationMinutes === null ||
      (typeof value.maxDurationMinutes === "number" &&
        Number.isInteger(value.maxDurationMinutes) &&
        value.maxDurationMinutes > 0)) &&
    (value.company === "any" ||
      value.company === "solo" ||
      value.company === "friends" ||
      value.company === "date")
  );
}

export function isSavedList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item): item is string => typeof item === "string" && item !== "",
    )
  );
}

function isOutingStop(value: unknown): value is OutingStop {
  if (!isRecord(value)) return false;

  return (
    typeof value.placeId === "string" &&
    value.placeId !== "" &&
    typeof value.note === "string"
  );
}

export function isOutingPlan(value: unknown): value is OutingPlan {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    typeof value.title === "string" &&
    typeof value.date === "string" &&
    parseISODateLocal(value.date) !== null &&
    (value.durationMinutes === null ||
      (typeof value.durationMinutes === "number" &&
        Number.isInteger(value.durationMinutes) &&
        value.durationMinutes > 0)) &&
    (value.budgetCents === null || isNonNegativeInt(value.budgetCents)) &&
    Array.isArray(value.categories) &&
    value.categories.every(isPlaceCategory) &&
    Array.isArray(value.stops) &&
    value.stops.every(isOutingStop) &&
    typeof value.notes === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

export function isOutingPlanList(value: unknown): value is OutingPlan[] {
  return Array.isArray(value) && value.every(isOutingPlan);
}
