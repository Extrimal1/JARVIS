import { NextResponse, type NextRequest } from "next/server";
import { fetchUser, refreshTokens } from "@/src/lib/supabase/auth";
import {
  clearSessionCookies,
  readSessionCookies,
  writeSessionCookies,
} from "@/src/lib/supabase/cookies";
import { supabaseEnv } from "@/src/lib/supabase/supabase";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";

/** GET /api/auth/session → { user } or 401 (transparent refresh included). */

export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = supabaseEnv();

  if (env === null) {
    return fail(
      "cloud-not-configured",
      "Cloud-Backend ist nicht konfiguriert.",
      503,
    );
  }

  try {
    const cookies = readSessionCookies(request);

    if (cookies === null) {
      return fail("unauthorized", "Nicht angemeldet.", 401);
    }

    const user = await fetchUser(env, cookies.access);

    if (user !== null) {
      return ok({ userId: user.id, email: user.email });
    }

    try {
      const renewed = await refreshTokens(env, cookies.refresh);
      const response = ok({
        userId: renewed.userId,
        email: renewed.email,
      });
      writeSessionCookies(response, renewed);

      return response;
    } catch {
      const denied = fail("unauthorized", "Sitzung abgelaufen.", 401);
      clearSessionCookies(denied);

      return denied;
    }
  } catch (error) {
    return failFromUnknown("auth/session", error);
  }
}
