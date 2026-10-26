import type { NextRequest, NextResponse } from "next/server";
import {
  ACCESS_COOKIE,
  ACCESS_MAX_AGE,
  REFRESH_COOKIE,
  REFRESH_MAX_AGE,
  type SessionTokens,
} from "./auth";

/** httpOnly session cookies; Secure in production, Lax same-site. */

export type SessionCookies = {
  access: string;
  refresh: string;
};

export function readSessionCookies(
  request: NextRequest,
): SessionCookies | null {
  const access = request.cookies.get(ACCESS_COOKIE)?.value ?? "";
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value ?? "";

  if (access === "" || refresh === "") return null;

  return { access, refresh };
}

function cookieBase(): {
  httpOnly: boolean;
  sameSite: "lax";
  path: string;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  };
}

export function writeSessionCookies(
  response: NextResponse,
  tokens: SessionTokens,
): void {
  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, {
    ...cookieBase(),
    maxAge: ACCESS_MAX_AGE,
  });
  response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
    ...cookieBase(),
    maxAge: REFRESH_MAX_AGE,
  });
}

export function clearSessionCookies(response: NextResponse): void {
  response.cookies.set(ACCESS_COOKIE, "", { ...cookieBase(), maxAge: 0 });
  response.cookies.set(REFRESH_COOKIE, "", { ...cookieBase(), maxAge: 0 });
}
