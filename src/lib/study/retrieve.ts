/**
 * Keyword retrieval scoring (Phase 4A): ranked term-overlap search
 * over stored chunks. Pure and store-agnostic — the cloud route and
 * the local IndexedDB path share this scorer, so both modes rank
 * identically. Embeddings may replace the scorer later (Phase 4E);
 * the chunk/ref/citation plumbing stays the same.
 */

const STOPWORDS = new Set(
  "der die das den dem des ein eine einer eines einem einen und oder aber denn doch nur auch schon sehr mehr kein keine keinem keinen was wer wie wo wann warum welche welcher welches ist sind war waren wird werden hätte hätten kann kannst können muss müssen soll sollen darf dürfen dies diese dieser dieses dass damit weil wenn als von vom zum zur beim nach über unter zwischen durch für gegen ohne um an am im ins aufs".split(
    " ",
  ),
);

const EXTRA_STOPWORDS = new Set([
  // English (mixed-language materials)
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for",
  "with", "is", "are", "was", "were", "be", "been", "this", "that",
  "these", "those", "it", "its", "as", "at", "by", "from",
  // Russian (queries + materials)
  "и", "в", "на", "что", "это", "как", "для", "или", "но", "не",
  "же", "ли", "бы", "все", "всё", "его", "ее", "её", "они",
  "так", "уже", "еще", "ещё", "можно", "есть", "было", "были",
  "меня", "тебя", "себя", "такой", "такая", "такое", "которые",
  "который", "которая", "между", "через", "при", "без",
]);

function isStopword(term: string): boolean {
  return STOPWORDS.has(term) || EXTRA_STOPWORDS.has(term);
}

/**
 * Lowercased query terms: unicode words of length ≥ 2 without
 * stopwords. Returns [] for stopword-only queries (callers then
 * report "no usable search terms" instead of matching everything).
 */
export function tokenizeQuery(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2 && !isStopword(term));

  return [...new Set(terms)];
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);

  while (at >= 0 && count < 50) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }

  return count;
}

export type ChunkScore = {
  score: number;
  matchedTerms: string[];
};

/**
 * Score = coverage × 10 + capped hit count. Coverage (share of
 * distinct query terms found) dominates, so a chunk matching three
 * terms beats one repeating a single term ten times.
 */
export function scoreText(terms: string[], text: string): ChunkScore {
  if (terms.length === 0) return { score: 0, matchedTerms: [] };

  const lowered = text.toLowerCase();
  const matched: string[] = [];
  let hits = 0;

  for (const term of terms) {
    const count = countOccurrences(lowered, term);

    if (count > 0) {
      matched.push(term);
      hits += Math.min(count, 5);
    }
  }

  if (matched.length === 0) return { score: 0, matchedTerms: [] };

  const score = (matched.length / terms.length) * 10 + Math.min(hits, 20);

  return { score, matchedTerms: matched };
}

export type RankedItem<T> = {
  item: T;
  score: number;
  matchedTerms: string[];
};

/** Filters to score > 0, sorts best-first, caps at `limit`. */
export function rankByTerms<T>(
  items: T[],
  textOf: (item: T) => string,
  query: string,
  limit: number,
): RankedItem<T>[] {
  const terms = tokenizeQuery(query);
  const capped =
    Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 5;

  if (terms.length === 0) return [];

  const ranked: RankedItem<T>[] = [];

  for (const item of items) {
    const { score, matchedTerms } = scoreText(terms, textOf(item));

    if (score > 0) {
      ranked.push({ item, score, matchedTerms });
    }
  }

  ranked.sort((a, b) => b.score - a.score);

  return ranked.slice(0, capped);
}
