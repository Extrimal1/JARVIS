import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic session gate (Next 16 calls this file `proxy.ts`; behavior
 * matches the former `middleware.ts`). Only active in cloud mode: no
 * session cookie → /login. Real authorization happens in API routes
 * via `authed()` — never trust this redirect alone.
 */

const PUBLIC_PATHS = ["/login", "/manifest.webmanifest", "/favicon.ico"];

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
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/api/health")
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
