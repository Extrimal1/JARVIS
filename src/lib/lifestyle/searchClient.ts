import { isPlaceList, type Place } from "./types";
import {
  isPlaceSearchPayload,
  type PlaceSearchCategory,
  type PlaceSearchDiagnostics,
  type ResolvedLocation,
} from "./placesSearch";

/**
 * Browser client for GET /api/lifestyle/places/search. Shared by the
 * PlaceDiscovery panel and the assistant's async read tool, so UI and
 * model see identical live results. Never throws for domain failures
 * (callers get `{ok:false}` with a displayable German message).
 */

export type LiveSearchInput = {
  query: string;
  near: string;
  latitude: number | null;
  longitude: number | null;
  radiusKm: number;
  category: PlaceSearchCategory;
  limit: number;
};

export type LiveSearchResult =
  | {
      ok: true;
      places: Place[];
      resolvedLocation: ResolvedLocation | null;
      centerUsed: { latitude: number; longitude: number } | null;
      notice: string | null;
      diagnostics: PlaceSearchDiagnostics;
    }
  | { ok: false; error: string };

type FetchLike = (
  input: string,
  init?: { cache?: RequestCache; signal?: AbortSignal },
) => Promise<Response>;

function isEnvelopeBody(value: unknown): value is {
  ok?: boolean;
  data?: unknown;
  error?: { message?: unknown };
} {
  return typeof value === "object" && value !== null;
}

export async function searchLivePlaces(
  input: LiveSearchInput,
  fetcher: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<LiveSearchResult> {
  const params = new URLSearchParams();

  if (input.query.trim() !== "") params.set("query", input.query.trim());
  if (input.near.trim() !== "") params.set("near", input.near.trim());
  if (input.latitude !== null && input.longitude !== null) {
    params.set("lat", String(input.latitude));
    params.set("lon", String(input.longitude));
  }
  params.set("radiusKm", String(input.radiusKm));
  params.set("category", input.category);
  params.set("limit", String(input.limit));

  let res: Response;

  try {
    res = await fetcher(
      `/api/lifestyle/places/search?${params.toString()}`,
      { cache: "no-store", signal },
    );
  } catch {
    return {
      ok: false,
      error:
        "Die Orts-Suche ist nicht erreichbar – prüfe deine Verbindung und versuche es erneut.",
    };
  }

  let body: unknown = null;

  try {
    body = (await res.json()) as unknown;
  } catch {
    return { ok: false, error: "Die Orts-Suche antwortete unverständlich." };
  }

  if (!isEnvelopeBody(body)) {
    return { ok: false, error: "Die Orts-Suche antwortete unverständlich." };
  }

  if (res.ok && body.ok === true && isPlaceSearchPayload(body.data)) {
    return {
      ok: true,
      places: body.data.places.filter((place): place is Place =>
        isPlaceList([place]),
      ),
      resolvedLocation: body.data.resolvedLocation,
      centerUsed: body.data.centerUsed,
      notice: body.data.notice,
      diagnostics: body.data.diagnostics,
    };
  }

  const rawError = (body as { error?: unknown }).error;
  const serverMessage =
    typeof rawError === "object" &&
    rawError !== null &&
    typeof (rawError as { message?: unknown }).message === "string"
      ? ((rawError as { message: string }).message as string)
      : null;

  return {
    ok: false,
    error:
      serverMessage ??
      "Die Orts-Suche ist fehlgeschlagen – versuche es später erneut.",
  };
}
