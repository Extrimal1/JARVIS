import {
  haversineKm,
  type DataSource,
  type EventCategory,
  type Place,
  type PlaceCategory,
  type PlaceEvent,
  type SettingPreference,
} from "./types";

export type GeoPoint = { latitude: number; longitude: number };

export type PlaceSearch = {
  query: string;
  categories: PlaceCategory[];
  maxCostCents: number | null;
  setting: SettingPreference;
  freeOnly: boolean;
  center: GeoPoint | null;
  radiusKm: number | null;
};

export interface PlaceProvider {
  readonly id: string;
  readonly label: string;
  readonly setupHint: string;
  isConfigured(): boolean;
  searchPlaces(search: PlaceSearch): Promise<Place[]>;
}

export type EventSearch = {
  query: string;
  categories: EventCategory[];
  fromISO: string | null;
  toISO: string | null;
  maxPriceCents: number | null;
  freeOnly: boolean;
};

export interface EventProvider {
  readonly id: string;
  readonly label: string;
  readonly setupHint: string;
  isConfigured(): boolean;
  searchEvents(search: EventSearch): Promise<PlaceEvent[]>;
}

export const MANUAL_SOURCE: DataSource = {
  providerId: "manual",
  label: "Manuell eingetragen",
  fetchedAt: null,
};

/**
 * Shared matching logic. Unknown values (cost, setting, coordinates)
 * never exclude a place — absence of data must not hide results.
 * Only "free only" requires a known zero cost.
 */
export function filterPlaces(places: Place[], search: PlaceSearch): Place[] {
  const needle = search.query.trim().toLowerCase();

  return places
    .filter((place) => {
      if (
        search.categories.length > 0 &&
        !search.categories.includes(place.category)
      ) {
        return false;
      }

      if (
        needle !== "" &&
        !`${place.name} ${place.address} ${place.notes}`
          .toLowerCase()
          .includes(needle)
      ) {
        return false;
      }

      if (search.freeOnly && place.costCents !== 0) return false;

      if (
        search.maxCostCents !== null &&
        place.costCents !== null &&
        place.costCents > search.maxCostCents
      ) {
        return false;
      }

      if (
        search.setting !== "any" &&
        place.setting !== null &&
        place.setting !== "both" &&
        place.setting !== search.setting
      ) {
        return false;
      }

      if (
        search.center !== null &&
        search.radiusKm !== null &&
        place.latitude !== null &&
        place.longitude !== null &&
        haversineKm(
          search.center.latitude,
          search.center.longitude,
          place.latitude,
          place.longitude,
        ) > search.radiusKm
      ) {
        return false;
      }

      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

export function filterEvents(
  events: PlaceEvent[],
  search: EventSearch,
): PlaceEvent[] {
  const needle = search.query.trim().toLowerCase();

  return events
    .filter((event) => {
      if (
        search.categories.length > 0 &&
        !search.categories.includes(event.category)
      ) {
        return false;
      }

      if (
        needle !== "" &&
        !`${event.title} ${event.venue} ${event.address} ${event.notes}`
          .toLowerCase()
          .includes(needle)
      ) {
        return false;
      }

      const end = event.endDate ?? event.date;

      if (search.fromISO !== null && end < search.fromISO) return false;
      if (search.toISO !== null && event.date > search.toISO) return false;
      if (search.freeOnly && event.priceCents !== 0) return false;

      if (
        search.maxPriceCents !== null &&
        event.priceCents !== null &&
        event.priceCents > search.maxPriceCents
      ) {
        return false;
      }

      return true;
    })
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
    );
}

export function createManualPlaceProvider(
  entries: Place[],
): PlaceProvider {
  return {
    id: "manual",
    label: "Eigene Einträge",
    setupHint:
      "Lege unten eigene Orte an – externe Anbieter sind nicht konfiguriert.",
    isConfigured: () => true,
    searchPlaces: async (search: PlaceSearch) =>
      filterPlaces(entries, search),
  };
}

export function createManualEventProvider(
  entries: PlaceEvent[],
): EventProvider {
  return {
    id: "manual",
    label: "Eigene Einträge",
    setupHint:
      "Lege unten eigene Veranstaltungen an – externe Anbieter sind nicht konfiguriert.",
    isConfigured: () => true,
    searchEvents: async (search: EventSearch) =>
      filterEvents(entries, search),
  };
}

/**
 * Provider registry. Future API providers (places, events) register
 * here; UI code consumes providers only through these interfaces, so
 * wiring a real API later requires no UI rewrite. API keys must live
 * server-side (API route) when that happens — never in client code.
 */
export function getPlaceProviders(localEntries: Place[]): PlaceProvider[] {
  return [createManualPlaceProvider(localEntries)];
}

export function getEventProviders(
  localEntries: PlaceEvent[],
): EventProvider[] {
  return [createManualEventProvider(localEntries)];
}
