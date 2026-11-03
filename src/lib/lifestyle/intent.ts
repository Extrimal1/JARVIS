import type { PlaceCategory } from "./types";

/**
 * Query intent detection for place search (DE/EN/RU keywords).
 *
 * Pure, client-safe module shared by the live-search UI
 * (`PlaceDiscovery`), the manual-entry form (`PlacesPanel`), the
 * search API route (diagnostics), and the assistant NLU — one
 * keyword table, so every surface detects the same intent.
 *
 * Honesty rules:
 * - ambiguous or empty input is ALWAYS broad (`"all"`), never a
 *   guessed category — in particular never a forced `nature`;
 * - `date`/`free` are occasion/price facets, not OSM types, and
 *   only match explicit words (romantisch, kostenlos, …);
 * - weekend / what-to-do / events / shopping / indoor / outdoor
 *   have no app category and stay broad (`"all"`) with the query
 *   text preserved, so the provider search decides;
 * - parking words (`Parkhaus`, `Parkplatz`, `parken`) are stripped
 *   before matching so they never read as `nature` ("Park").
 */

export type DetectedCategory = PlaceCategory | "all";

export type DetectedIntent = {
  category: DetectedCategory;
  /** The keyword that matched, null when the intent is broad. */
  matched: string | null;
};

/**
 * Words stripped before matching: parking nouns (never `nature`),
 * the city of Essen (never food), and compounds whose substring
 * would misfire (`Kindergarten`, `Transport`).
 */
const STRIP_WORDS =
  /parkhaus|parkpl[äa]tz|parken|park-and-ride|park and ride|kindergarten|\btransport\b|\bin\s+essen\b|парков|паркинг/g;

const INTENT_PATTERNS: { category: PlaceCategory; match: RegExp }[] = [
  {
    category: "cinema",
    match: /kinoabend|kinoprogramm|kino|film|movie|кино/,
  },
  {
    category: "food",
    match:
      /restaurant|speiselokal|gasthaus|wirtshaus|trattoria|pizzeria|imbiss|bistro|caf[eé]|kaffee|frühstück|brunch|mittag|abendessen|\bessen\b|kneipe|biergarten|sushi|cocktailbar|beachbar|weinbar|\bbars?\b|\bpubs?\b|ресторан|кафе|(?:^|\s)бар|поесть|еда/,
  },
  {
    category: "culture",
    match:
      /museum|museen|galerie|ausstellung|sehensw[üu]rdig|theater|konzert|staatsoper|opernhaus|\boper\b|kunst|bibliothek|b[üu]cherei|kirche|\bdom\b|schloss|\bburg\b|denkmal|kultur|музей|театр|достопримечател|культур/,
  },
  {
    category: "sport",
    match:
      /fitnessstudio|fitness|\bgym\b|wassersport|\bsport|schwimm|freibad|hallenbad|schwimmbad|joggen|radfahren|fußball|tennis|klettern|yoga|skaten|bolzplatz|спорт|спортзал|бассейн|фитнес/,
  },
  {
    category: "nature",
    match:
      /freizeitpark|tierpark|\bpark|natur|see\b|\bberg|wandern|wanderung|spazier|garten|wald|fluss|ufer|strand|beach|grünanlage|botanisch|aussicht|zoologisch|\bzoo\b|парк|природ|погулять/,
  },
  {
    category: "free",
    match: /gratis|kostenlos|umsonst|eintritt\s+frei|\bfree\b|бесплатно/,
  },
  {
    category: "date",
    match: /romantisch|candle|pärchen|zu\s+zweit|\bdate\b|свидание|романтич/,
  },
];

function normalize(text: string): string {
  return text.toLowerCase().replace(STRIP_WORDS, " ").replace(/\s+/g, " ");
}

/** Detect the place-search intent of free text. Never throws. */
export function detectPlaceIntent(text: string): DetectedIntent {
  const normalized = normalize(text);

  if (normalized.trim() === "") return { category: "all", matched: null };

  for (const { category, match } of INTENT_PATTERNS) {
    const hit = match.exec(normalized);

    if (hit !== null) {
      return { category, matched: hit[0] };
    }
  }

  return { category: "all", matched: null };
}

/** Shorthand when only the category matters. */
export function detectPlaceCategory(text: string): DetectedCategory {
  return detectPlaceIntent(text).category;
}

/**
 * Canonical provider terms for plural/compound intent nouns.
 * Nominatim matches singular venue nouns ("Restaurant") far better
 * than compounds ("Kinoabend") or plurals ("Restaurants"); the
 * replacement keeps word order and never adds new words.
 */
const CANONICAL_TERMS: [RegExp, string][] = [
  [/kinoabend/gi, "Kino"],
  [/kinoprogramm/gi, "Kino"],
  [/\bkinos\b/gi, "Kino"],
  [/\brestaurants\b/gi, "Restaurant"],
  [/\bcaf[eé]s\b/gi, "Café"],
  [/\bbars\b/gi, "Bar"],
  [/\bkneipen\b/gi, "Kneipe"],
  [/\bparks\b/gi, "Park"],
  [/\bmuseums\b/gi, "Museum"],
  [/\bmuseen\b/gi, "Museum"],
  [/\btheaters\b/gi, "Theater"],
  [/\bfitnessstudios\b/gi, "Fitnessstudio"],
  [/\bgyms\b/gi, "Gym"],
];

/** Normalize plural/compound nouns for the provider query. Pure. */
export function canonicalizeQuery(query: string): string {
  let out = query;

  for (const [pattern, replacement] of CANONICAL_TERMS) {
    out = out.replace(pattern, replacement);
  }

  return out.replace(/\s+/g, " ").trim().slice(0, 200);
}
