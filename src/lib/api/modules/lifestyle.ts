import {
  isLifestylePreferences,
  isOutingPlan,
  isOutingPlanList,
  isPlace,
  isPlaceEvent,
  isPlaceEventList,
  isPlaceList,
  type LifestylePreferences,
  type OutingPlan,
  type Place,
  type PlaceEvent,
} from "@/src/lib/lifestyle/types";
import {
  dbDeleteWhere,
  dbGetOne,
  dbList,
  dbUpsert,
  type DbClient,
} from "@/src/lib/supabase/db";
import {
  pickPatch,
  requireId,
  type CheckResult,
  type CrudConfig,
} from "../crud";

// ------------------------------------------------------------------ places

function placeToDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    address: row.address ?? "",
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    costCents: row.cost_cents ?? null,
    durationMinutes: row.duration_minutes ?? null,
    setting: row.setting ?? null,
    openingHours: row.opening_hours ?? "",
    notes: row.notes ?? "",
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function placeToRow(item: Place): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    address: item.address,
    latitude: item.latitude,
    longitude: item.longitude,
    cost_cents: item.costCents,
    duration_minutes: item.durationMinutes,
    setting: item.setting,
    opening_hours: item.openingHours,
    notes: item.notes,
    source: item.source,
  };
}

const PLACE_KEYS = [
  "name",
  "category",
  "address",
  "latitude",
  "longitude",
  "costCents",
  "durationMinutes",
  "setting",
  "openingHours",
  "notes",
  "source",
] as const;

export const placesConfig: CrudConfig = {
  table: "lifestyle_places",
  order: "created_at.asc",
  toDomain: placeToDomain,
  isList: isPlaceList,
  checkCreate: (_db, body) => {
    if (!isPlace(body) || requireId(body) === null) {
      return { message: "Ungültiger Ort." };
    }

    return { row: placeToRow(body) };
  },
  checkUpdate: (_db, patch, existing): CheckResult => {
    const picked = pickPatch(patch, PLACE_KEYS);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isPlace(merged)) {
      return { message: "Ungültige Änderung." };
    }

    const row = placeToRow(merged as unknown as Place);
    delete row.id;

    return { row };
  },
};

// ------------------------------------------------------------------ events

function eventToDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    venue: row.venue ?? "",
    address: row.address ?? "",
    date: row.date,
    endDate: row.end_date ?? null,
    time: row.time ?? "",
    priceCents: row.price_cents ?? null,
    bookingUrl: row.booking_url ?? "",
    notes: row.notes ?? "",
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventToRow(item: PlaceEvent): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    category: item.category,
    venue: item.venue,
    address: item.address,
    date: item.date,
    end_date: item.endDate,
    time: item.time,
    price_cents: item.priceCents,
    booking_url: item.bookingUrl,
    notes: item.notes,
    source: item.source,
  };
}

const EVENT_KEYS = [
  "title",
  "category",
  "venue",
  "address",
  "date",
  "endDate",
  "time",
  "priceCents",
  "bookingUrl",
  "notes",
  "source",
] as const;

export const lifestyleEventsConfig: CrudConfig = {
  table: "lifestyle_events",
  order: "date.asc,created_at.asc",
  toDomain: eventToDomain,
  isList: isPlaceEventList,
  checkCreate: (_db, body) => {
    if (!isPlaceEvent(body) || requireId(body) === null) {
      return { message: "Ungültige Veranstaltung." };
    }

    return { row: eventToRow(body) };
  },
  checkUpdate: (_db, patch, existing): CheckResult => {
    const picked = pickPatch(patch, EVENT_KEYS);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isPlaceEvent(merged)) {
      return { message: "Ungültige Änderung." };
    }

    const row = eventToRow(merged as unknown as PlaceEvent);
    delete row.id;

    return { row };
  },
};

// ------------------------------------------------------------------ plans

function planToDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    durationMinutes: row.duration_minutes ?? null,
    budgetCents: row.budget_cents ?? null,
    categories: row.categories ?? [],
    stops: row.stops ?? [],
    notes: row.notes ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function planToRow(item: OutingPlan): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    date: item.date,
    duration_minutes: item.durationMinutes,
    budget_cents: item.budgetCents,
    categories: item.categories,
    stops: item.stops,
    notes: item.notes,
  };
}

const PLAN_KEYS = [
  "title",
  "date",
  "durationMinutes",
  "budgetCents",
  "categories",
  "stops",
  "notes",
] as const;

export const plansConfig: CrudConfig = {
  table: "lifestyle_plans",
  order: "date.asc,created_at.asc",
  toDomain: planToDomain,
  isList: isOutingPlanList,
  checkCreate: (_db, body) => {
    if (!isOutingPlan(body) || requireId(body) === null) {
      return { message: "Ungültiger Ausflug." };
    }

    return { row: planToRow(body) };
  },
  checkUpdate: (_db, patch, existing): CheckResult => {
    const picked = pickPatch(patch, PLAN_KEYS);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isOutingPlan(merged)) {
      return { message: "Ungültige Änderung." };
    }

    const row = planToRow(merged as unknown as OutingPlan);
    delete row.id;

    return { row };
  },
};

// ------------------------------------------------------------------ saved

export async function listSavedIds(db: DbClient): Promise<string[]> {
  const rows = await dbList<{ place_id: string }>(db, "lifestyle_saved", {
    select: "place_id",
    limit: 2000,
  });

  return rows
    .map((row) => row.place_id)
    .filter((id): id is string => typeof id === "string");
}

export async function savePlaceId(
  db: DbClient,
  body: unknown,
): Promise<{ saved: boolean } | { message: string }> {
  if (typeof body !== "object" || body === null) {
    return { message: "Ungültige Anfrage." };
  }

  const placeId = (body as Record<string, unknown>).placeId;

  if (typeof placeId !== "string" || placeId === "") {
    return { message: "Ungültige Anfrage." };
  }

  const place = await dbGetOne(db, "lifestyle_places", placeId);

  if (place === null) {
    return { message: "Ort nicht gefunden." };
  }

  await dbUpsert(db, "lifestyle_saved", [{ place_id: placeId }]);

  return { saved: true };
}

export async function unsavePlaceId(
  db: DbClient,
  placeId: string,
): Promise<void> {
  await dbDeleteWhere(db, "lifestyle_saved", [
    `place_id=eq.${encodeURIComponent(placeId)}`,
  ]);
}

// ------------------------------------------------------------------ preferences

const DEFAULT_PREFS: LifestylePreferences = {
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

function prefsToDomain(row: Record<string, unknown>): LifestylePreferences {
  return {
    city: typeof row.city === "string" ? row.city : "",
    useGeolocation: row.use_geolocation === true,
    latitude: typeof row.latitude === "number" ? row.latitude : null,
    longitude: typeof row.longitude === "number" ? row.longitude : null,
    radiusKm: typeof row.radius_km === "number" ? row.radius_km : 10,
    maxBudgetCents:
      typeof row.max_budget_cents === "number" ? row.max_budget_cents : null,
    categories: Array.isArray(row.categories)
      ? (row.categories as LifestylePreferences["categories"])
      : [],
    setting:
      row.setting === "indoor" || row.setting === "outdoor"
        ? row.setting
        : "any",
    maxDurationMinutes:
      typeof row.max_duration_minutes === "number"
        ? row.max_duration_minutes
        : null,
    company:
      row.company === "solo" ||
      row.company === "friends" ||
      row.company === "date"
        ? row.company
        : "any",
  };
}

export async function getPreferences(
  db: DbClient,
): Promise<LifestylePreferences> {
  const rows = await dbList<Record<string, unknown>>(
    db,
    "lifestyle_preferences",
    { limit: 1 },
  );
  const first = rows[0];

  if (first === undefined) {
    return DEFAULT_PREFS;
  }

  const prefs = prefsToDomain(first);

  return isLifestylePreferences(prefs) ? prefs : DEFAULT_PREFS;
}

export async function savePreferences(
  db: DbClient,
  body: unknown,
): Promise<LifestylePreferences | { message: string }> {
  if (!isLifestylePreferences(body)) {
    return { message: "Ungültige Vorlieben." };
  }

  await dbUpsert(db, "lifestyle_preferences", [
    {
      city: body.city,
      use_geolocation: body.useGeolocation,
      latitude: body.latitude,
      longitude: body.longitude,
      radius_km: body.radiusKm,
      max_budget_cents: body.maxBudgetCents,
      categories: body.categories,
      setting: body.setting,
      max_duration_minutes: body.maxDurationMinutes,
      company: body.company,
    },
  ]);

  return body;
}
