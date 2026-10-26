import {
  formatDistanceKm,
  haversineKm,
  type LifestylePreferences,
  type Place,
} from "./types";

export type ScoredPlace = {
  place: Place;
  score: number;
  /** At least one human-readable reason, derived from actual data. */
  reasons: string[];
  distanceKm: number | null;
};

/**
 * Transparent rule-based recommendations — no AI. Hard exclusions apply
 * to non-selected categories, over-budget known costs, and places
 * outside the search radius. Everything else earns scored bonuses,
 * each with a reason the UI displays verbatim.
 */
export function recommendPlaces(
  places: Place[],
  prefs: LifestylePreferences,
  limit = 5,
): ScoredPlace[] {
  const center =
    prefs.useGeolocation &&
    prefs.latitude !== null &&
    prefs.longitude !== null
      ? { latitude: prefs.latitude, longitude: prefs.longitude }
      : null;

  const scored: ScoredPlace[] = [];

  for (const place of places) {
    if (
      prefs.categories.length > 0 &&
      !prefs.categories.includes(place.category)
    ) {
      continue;
    }

    if (
      prefs.maxBudgetCents !== null &&
      place.costCents !== null &&
      place.costCents > prefs.maxBudgetCents
    ) {
      continue;
    }

    let distanceKm: number | null = null;

    if (
      center !== null &&
      place.latitude !== null &&
      place.longitude !== null
    ) {
      distanceKm = haversineKm(
        center.latitude,
        center.longitude,
        place.latitude,
        place.longitude,
      );

      if (distanceKm > prefs.radiusKm) {
        continue;
      }
    }

    let score = 0;
    const reasons: string[] = [];

    if (prefs.maxBudgetCents !== null) {
      if (place.costCents === 0 && prefs.maxBudgetCents === 0) {
        score += 3;
        reasons.push("Kostenlos – passt zu deinem 0-€-Budget");
      } else if (place.costCents !== null) {
        score += 1;
        reasons.push("Liegt in deinem Budget");
      } else {
        reasons.push("Preis unbekannt");
      }
    } else if (place.costCents === 0) {
      score += 1;
      reasons.push("Kostenlos");
    }

    if (prefs.setting !== "any") {
      if (place.setting === null) {
        reasons.push("Drinnen oder draußen unbekannt");
      } else if (
        place.setting === "both" ||
        place.setting === prefs.setting
      ) {
        score += 2;
        reasons.push(
          prefs.setting === "outdoor"
            ? "Draußen wie gewünscht"
            : "Drinnen wie gewünscht",
        );
      } else {
        score -= 2;
        reasons.push("Passt nicht zu deiner Indoor/Outdoor-Auswahl");
      }
    }

    if (
      prefs.maxDurationMinutes !== null &&
      place.durationMinutes !== null
    ) {
      if (place.durationMinutes <= prefs.maxDurationMinutes) {
        score += 1;
        reasons.push("Passt in dein Zeitfenster");
      } else {
        score -= 1;
        reasons.push("Dauert länger als dein Zeitfenster");
      }
    }

    if (prefs.company === "date" && place.category === "date") {
      score += 2;
      reasons.push("Date-Idee für zu zweit");
    }

    if (distanceKm !== null) {
      reasons.push(`${formatDistanceKm(distanceKm)} entfernt`);

      if (distanceKm <= 2) {
        score += 1;
      }
    }

    if (reasons.length === 0) {
      reasons.push("Entspricht deinen Filtern");
    }

    scored.push({ place, score, reasons, distanceKm });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, Math.max(0, limit));
}
