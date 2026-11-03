import { NextResponse } from "next/server";
import { failFromUnknown, ok } from "@/src/lib/api/respond";
import {
  __clearNewsCacheForTests,
  getNews,
} from "@/src/lib/lifestyle/newsProvider";

/**
 * GET /api/lifestyle/news — free RSS feeds only (no key, no paid API).
 * Public (no login, no user data): fetches server-side so the browser
 * never depends on feed CORS headers. Cached in-memory for 15 minutes.
 * Never fabricates items: unreachable/empty feeds surface per-feed
 * errors and honest empty states.
 */

export async function GET(): Promise<NextResponse> {
  try {
    return ok(await getNews());
  } catch (unknown) {
    return failFromUnknown("lifestyle/news", unknown);
  }
}

export { __clearNewsCacheForTests };
