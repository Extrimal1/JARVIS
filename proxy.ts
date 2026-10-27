import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic session gate (Next 16 calls this file `proxy.ts`; behavior
 * matches the former `middleware.ts`). Only active in cloud mode: no
 * session cookie → /login. Real authorization happens in API routes
 * via `authed()` — never trust this redirect alone.
 */

const PUBLIC_PATHS = ["/login", "/manifest.webmanifest", "/favicon.ico"];

// Public data endpoints (no login, no user data): health + weather.
const PUBLIC_API_PREFIXES = ["/api/auth/", "/api/health", "/api/weather/"];

export function proxy(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_CLOUD_ENABLED !== "1") {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  if (
    PUBLIC_PATHS.some(
      (publicPath) =>
        pathname === publicPath || pathname.startsWith(`${publicPath}/`),
    ) ||
    PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.next();
  }

  if (!request.cookies.has("jarvis-at")) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);

    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icons|sw.js).*)"],
};
