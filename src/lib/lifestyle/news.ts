/**
 * Lifestyle news: free RSS feeds only, no paid APIs. The server route
 * GET /api/lifestyle/news fetches + parses feeds and returns NewsItems;
 * this module holds the shared types, the dependency-free RSS parser
 * (shared by route and tests), and the interest filter.
 */

export type NewsItem = {
  /** Stable id: feed id + item link (or guid) hashed by the server. */
  id: string;
  feedId: string;
  feedLabel: string;
  title: string;
  link: string;
  /** ISO timestamp or "" when the feed provides none. */
  publishedAt: string;
  /** Plain-text excerpt, "" when unavailable. Never invented. */
  excerpt: string;
};

export type NewsFeed = {
  id: string;
  label: string;
  /** Public RSS/Atom URL. */
  url: string;
};

export const NEWS_CACHE_TTL_MS = 15 * 60 * 1000;
export const NEWS_MAX_ITEMS_PER_FEED = 15;
export const NEWS_INTERESTS_KEY = "jarvis-lifestyle-interests";

/**
 * Default feeds: public, free, no key needed. Users can narrow results
 * with interests; feed URLs stay server-side so the browser never
 * depends on feed CORS headers.
 */
export const DEFAULT_NEWS_FEEDS: NewsFeed[] = [
  {
    id: "tagesschau",
    label: "Tagesschau",
    url: "https://www.tagesschau.de/xml/rss2/",
  },
  {
    id: "heise",
    label: "heise online",
    url: "https://www.heise.de/rss/heise-top-atom.xml",
  },
  {
    id: "dlf",
    label: "Deutschlandfunk",
    url: "https://www.deutschlandfunk.de/dlf-nachrichten-100.rss",
  },
];

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function firstTag(block: string, tag: string): string {
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const match = pattern.exec(block);

  return match?.[1] === undefined ? "" : decodeEntities(match[1]);
}

function firstAttr(block: string, tag: string, attr: string): string {
  const pattern = new RegExp(`<${tag}[^>]*?${attr}=["']([^"']+)["']`, "i");
  const match = pattern.exec(block);

  return match?.[1] === undefined ? "" : decodeEntities(match[1]);
}

function toIsoDate(value: string): string {
  if (value === "") return "";

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

/**
 * Parse an RSS 2.0 (<item>) or Atom (<entry>) document into plain items.
 * Unknown markup is skipped; nothing is ever invented for missing
 * fields. Pure and dependency-free.
 */
export function parseRssFeed(
  xml: string,
  feed: Pick<NewsFeed, "id" | "label">,
  nowIso: string,
  maxItems = NEWS_MAX_ITEMS_PER_FEED,
): NewsItem[] {
  const blocks: string[] = [];
  const itemPattern = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match: RegExpExecArray | null;

  while (
    (match = itemPattern.exec(xml)) !== null &&
    blocks.length < Math.max(0, maxItems)
  ) {
    blocks.push(match[1]);
  }

  void nowIso;

  return blocks.flatMap((block, index): NewsItem[] => {
    const title = stripTags(firstTag(block, "title"));
    const guid = stripTags(firstTag(block, "guid"));
    let link = stripTags(firstTag(block, "link"));

    if (link === "") {
      link = firstAttr(block, "link", "href");
    }

    if (title === "" || link === "") return [];

    const publishedAt = toIsoDate(
      firstTag(block, "pubDate") ||
        firstTag(block, "published") ||
        firstTag(block, "updated") ||
        firstTag(block, "dc:date"),
    );
    const excerpt = stripTags(
      firstTag(block, "description") ||
        firstTag(block, "summary") ||
        firstTag(block, "content"),
    ).slice(0, 280);

    return [
      {
        id: `${feed.id}-${index}-${simpleHash(`${feed.id}|${link || guid || title}`)}`,
        feedId: feed.id,
        feedLabel: feed.label,
        title,
        link,
        publishedAt,
        excerpt,
      },
    ];
  });
}

function simpleHash(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

export function isNewsItem(value: unknown): value is NewsItem {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.id === "string" &&
    typeof item.feedId === "string" &&
    typeof item.feedLabel === "string" &&
    typeof item.title === "string" &&
    typeof item.link === "string" &&
    typeof item.publishedAt === "string" &&
    typeof item.excerpt === "string"
  );
}

/**
 * Interest filter: comma-separated keywords, case-insensitive, matched
 * against title + excerpt + feed label. Empty interests return all items.
 */
export function filterNewsByInterests(
  items: NewsItem[],
  interestsRaw: string,
): NewsItem[] {
  const keywords = interestsRaw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");

  if (keywords.length === 0) return items;

  return items.filter((item) => {
    const haystack =
      `${item.title} ${item.excerpt} ${item.feedLabel}`.toLowerCase();

    return keywords.some((keyword) => haystack.includes(keyword));
  });
}

export function parseInterests(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
