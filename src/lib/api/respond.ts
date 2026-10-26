import { NextResponse } from "next/server";
import { SupabaseHttpError } from "@/src/lib/supabase/supabase";

/**
 * Typed API responses. Every route returns either `{ ok: true, data }`
 * or `{ ok: false, error: { code, message } }`. Upstream details are
 * logged server-side; clients get safe generic messages.
 */

export type ApiOk<T> = {
  ok: true;
  data: T;
};

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "bad-request"
  | "not-found"
  | "conflict"
  | "payload-too-large"
  | "cloud-not-configured"
  | "worker-unavailable"
  | "upstream-error";

export type ApiFail = {
  ok: false;
  error: { code: ApiErrorCode; message: string };
};

export function ok<T>(data: T, status = 200): NextResponse<ApiOk<T>> {
  return NextResponse.json({ ok: true, data }, { status });
}

export function fail(
  code: ApiErrorCode,
  message: string,
  status: number,
): NextResponse<ApiFail> {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

/** Map unknown failures to safe client responses (details stay server-side). */
export function failFromUnknown(route: string, error: unknown): NextResponse<ApiFail> {
  console.error(`[api:${route}]`, error);

  if (error instanceof SupabaseHttpError) {
    if (error.status === 401 || error.status === 403) {
      return fail("unauthorized", "Sitzung abgelaufen. Bitte melde dich erneut an.", 401);
    }

    if (error.status === 400) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    if (error.status === 404) {
      return fail("not-found", "Nicht gefunden.", 404);
    }

    if (error.status === 409) {
      return fail("conflict", "Konflikt: Der Eintrag existiert bereits oder wurde geändert.", 409);
    }

    if (error.status === 413) {
      return fail("payload-too-large", "Datei zu groß.", 413);
    }
  }

  if (error instanceof Error && error.message === "CLOUD_NOT_CONFIGURED") {
    return fail(
      "cloud-not-configured",
      "Cloud-Backend ist nicht konfiguriert (siehe .env.example).",
      503,
    );
  }

  return fail("upstream-error", "Serverfehler. Bitte versuche es erneut.", 502);
}

/** Parse a JSON body; returns null when missing or malformed. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return null;
  }
}
