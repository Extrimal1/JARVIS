import {
  DEFAULT_NEWS_FEEDS,
  NEWS_CACHE_TTL_MS,
  NEWS_MAX_ITEMS_PER_FEED,
  parseRssFeed,
  type NewsFeed,
  type NewsItem,
} from "@/src/lib/lifestyle/news";

/**
 * RSS news provider (SERVER-ONLY — called from API routes and the
 * briefing dispatch). Free feeds only, no key. Cached in-memory for
 * 15 minutes. Never fabricates items: unreachable/empty feeds yield
 * per-feed errors and honest empty states.
 */

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

export type NewsFeedStatus = {
  id: string;
  label: string;
  count: number;
  error: string | null;
};

export type NewsPayload = {
  items: NewsItem[];
  feeds: NewsFeedStatus[];
  fetchedAt: string;
};

type CacheEntry = { expires: number; payload: NewsPayload };

const cache = new Map<string, CacheEntry>();

async function fetchFeed(
  feed: NewsFeed,
  nowIso: string,
  fetchImpl: typeof fetch,
): Promise<{ items: NewsItem[]; error: string | null }> {
  let res: Response;

  try {
    res = await fetchImpl(feed.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": "jarvis-lifestyle-news/1 (+local)",
        Accept: "application/rss+xml, application/atom+xml, text/xml",
      },
    });
  } catch {
    return {
      items: [],
      error: `"${feed.label}" ist derzeit nicht erreichbar.`,
    };
  }

  if (res.status === 429) {
    return {
      items: [],
      error: `"${feed.label}" meldet zu viele Anfragen — später erneut versuchen.`,
    };
  }

  if (!res.ok) {
    return {
      items: [],
      error: `"${feed.label}" konnte nicht geladen werden (HTTP ${res.status}).`,
    };
  }

  const xml = await res.text().catch(() => "");

  if (xml === "" || xml.length > MAX_BYTES) {
    return {
      items: [],
      error: `"${feed.label}" lieferte keine lesbaren Daten.`,
    };
  }

  return { items: parseRssFeed(xml, feed, nowIso), error: null };
}

export async function getNews(
  fetchImpl: typeof fetch = fetch,
): Promise<NewsPayload> {
  const cached = cache.get("news");

  if (cached !== undefined && cached.expires > Date.now()) {
    return cached.payload;
  }

  const nowIso = new Date().toISOString();
  const results = await Promise.all(
    DEFAULT_NEWS_FEEDS.map(async (feed) => ({
      feed,
      ...(await fetchFeed(feed, nowIso, fetchImpl)),
    })),
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

  return payload;
}

export function __clearNewsCacheForTests(): void {
  cache.clear();
}
