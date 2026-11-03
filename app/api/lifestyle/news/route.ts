import { NextResponse } from "next/server";
import { failFromUnknown, ok } from "@/src/lib/api/respond";
import {
  DEFAULT_NEWS_FEEDS,
  NEWS_CACHE_TTL_MS,
  NEWS_MAX_ITEMS_PER_FEED,
  parseRssFeed,
  type NewsFeed,
  type NewsItem,
} from "@/src/lib/lifestyle/news";

/**
 * GET /api/lifestyle/news — free RSS feeds only (no key, no paid API).
 * Public (no login, no user data): fetches server-side so the browser
 * never depends on feed CORS headers. Cached in-memory for 15 minutes.
 * Never fabricates items: unreachable/empty feeds surface per-feed
 * errors and honest empty states.
 */

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

type CacheEntry = { expires: number; payload: NewsPayload };

type FeedResult = {
  feed: NewsFeed;
  items: NewsItem[];
  error: string | null;
};

type NewsPayload = {
  items: NewsItem[];
  feeds: { id: string; label: string; count: number; error: string | null }[];
  fetchedAt: string;
};

const cache = new Map<string, CacheEntry>();

async function fetchFeed(feed: NewsFeed, nowIso: string): Promise<FeedResult> {
  let res: Response;

  try {
    res = await fetch(feed.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "jarvis-lifestyle-news/1 (+local)",
        Accept: "application/rss+xml, application/atom+xml, text/xml",
      },
    });
  } catch {
    return {
      feed,
      items: [],
      error: `"${feed.label}" ist derzeit nicht erreichbar.`,
    };
  }

  if (res.status === 429) {
    return {
      feed,
      items: [],
      error: `"${feed.label}" meldet zu viele Anfragen — später erneut versuchen.`,
    };
  }

  if (!res.ok) {
    return {
      feed,
      items: [],
      error: `"${feed.label}" konnte nicht geladen werden (HTTP ${res.status}).`,
    };
  }

  const xml = await res.text().catch(() => "");

  if (xml === "" || xml.length > MAX_BYTES) {
    return {
      feed,
      items: [],
      error: `"${feed.label}" lieferte keine lesbaren Daten.`,
    };
  }

  return { feed, items: parseRssFeed(xml, feed, nowIso), error: null };
}

export async function GET(): Promise<NextResponse> {
  try {
    const cached = cache.get("news");

    if (cached !== undefined && cached.expires > Date.now()) {
      return ok(cached.payload);
    }

    const nowIso = new Date().toISOString();
    const results = await Promise.all(
      DEFAULT_NEWS_FEEDS.map((feed) => fetchFeed(feed, nowIso)),
    );

    const items = results
      .flatMap((result) =>
        result.items.slice(0, NEWS_MAX_ITEMS_PER_FEED),
      )
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

    const payload: NewsPayload = {
      items,
      feeds: results.map((result) => ({
        id: result.feed.id,
        label: result.feed.label,
        count: result.items.length,
        error: result.error,
      })),
      fetchedAt: nowIso,
    };

    cache.set("news", { expires: Date.now() + NEWS_CACHE_TTL_MS, payload });

    return ok(payload);
  } catch (unknown) {
    return failFromUnknown("lifestyle/news", unknown);
  }
}

export function __clearNewsCacheForTests(): void {
  cache.clear();
}
