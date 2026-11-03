import { NextResponse, type NextRequest } from "next/server";
import { signInWithPassword } from "@/src/lib/supabase/auth";
import { writeSessionCookies } from "@/src/lib/supabase/cookies";
import {
  SupabaseHttpError,
  supabaseEnv,
} from "@/src/lib/supabase/supabase";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  checkRateLimit,
  LOGIN_RATE_LIMIT,
  type RateLimitStore,
} from "@/src/lib/api/rateLimit";

/** POST /api/auth/login { email, password } → sets httpOnly session cookies. */

const LOGIN_ATTEMPTS: RateLimitStore = new Map();

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");

  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();

    if (first !== undefined && first !== "") return first;
  }

  return "unknown";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = supabaseEnv();

  if (env === null) {
    return fail(
      "cloud-not-configured",
      "Cloud-Backend ist nicht konfiguriert (siehe .env.example).",
      503,
    );
  }

  try {
    const body = await readJson(request);

    if (typeof body !== "object" || body === null) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    const { email, password } = body as Record<string, unknown>;

    if (typeof email !== "string" || typeof password !== "string") {
      return fail("bad-request", "E-Mail und Passwort erforderlich.", 400);
    }

    // Per-IP+account sliding window: failed AND successful attempts
    // count, so credential stuffing cannot probe freely. The key
    // uses the normalized email to stop case-variant evasion.
    const allowed = checkRateLimit(
      LOGIN_ATTEMPTS,
      `${clientIp(request)}:${email.trim().toLowerCase()}`,
      LOGIN_RATE_LIMIT,
      Date.now(),
    );

    if (!allowed) {
      return fail(
        "rate-limited",
        "Zu viele Anmeldeversuche. Bitte warte einige Minuten und versuche es erneut.",
        429,
      );
    }

    try {
      const session = await signInWithPassword(env, email, password);
      const response = ok({ userId: session.userId, email: session.email });
      writeSessionCookies(response, session);

      return response;
    } catch (error) {
      if (
        error instanceof SupabaseHttpError &&
        (error.status === 400 || error.status === 401)
      ) {
        return fail(
          "unauthorized",
          "E-Mail oder Passwort ist falsch.",
          401,
        );
      }

      throw error;
    }
  } catch (error) {
    return failFromUnknown("auth/login", error);
  }
}
