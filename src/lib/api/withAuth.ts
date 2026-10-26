import { NextResponse, type NextRequest } from "next/server";
import {
  fetchUser,
  refreshTokens,
  type AuthUser,
} from "@/src/lib/supabase/auth";
import {
  clearSessionCookies,
  readSessionCookies,
  writeSessionCookies,
} from "@/src/lib/supabase/cookies";
import { supabaseEnv } from "@/src/lib/supabase/supabase";
import { fail, failFromUnknown } from "./respond";

/**
 * Route guard: validates the session cookie (transparent refresh when
 * the access token expired), then runs the handler with the auth
 * context. Returns 401 without a session, 503 without backend config.
 */

export type AuthContext = AuthUser & {
  accessToken: string;
  userId: string;
};

type RouteParams = { params: Promise<Record<string, string>> };

export function authed(
  handler: (
    request: NextRequest,
    auth: AuthContext,
    route: RouteParams,
  ) => Promise<NextResponse>,
): (request: NextRequest, route: RouteParams) => Promise<NextResponse> {
  return async (request: NextRequest, route: RouteParams) => {
    const env = supabaseEnv();

    if (env === null) {
      return fail(
        "cloud-not-configured",
        "Cloud-Backend ist nicht konfiguriert (siehe .env.example).",
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
        return handler(
          request,
          { ...user, accessToken: cookies.access, userId: user.id },
          route,
        );
      }

      try {
        const renewed = await refreshTokens(env, cookies.refresh);
        const response = await handler(
          request,
          {
            id: renewed.userId,
            email: renewed.email,
            accessToken: renewed.accessToken,
            userId: renewed.userId,
          },
          route,
        );
        writeSessionCookies(response, renewed);

        return response;
      } catch {
        const denied = fail(
          "unauthorized",
          "Sitzung abgelaufen. Bitte melde dich erneut an.",
          401,
        );
        clearSessionCookies(denied);

        return denied;
      }
    } catch (error) {
      return failFromUnknown("auth", error);
    }
  };
}
