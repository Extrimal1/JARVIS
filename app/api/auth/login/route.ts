import { NextResponse, type NextRequest } from "next/server";
import { signInWithPassword } from "@/src/lib/supabase/auth";
import { writeSessionCookies } from "@/src/lib/supabase/cookies";
import {
  SupabaseHttpError,
  supabaseEnv,
} from "@/src/lib/supabase/supabase";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";

/** POST /api/auth/login { email, password } → sets httpOnly session cookies. */

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
