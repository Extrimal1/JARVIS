import type { TransactionType } from "@/src/lib/finance";

/**
 * Transparent rule-based categorization (no AI). Each rule is a list of
 * lowercase keywords matched against the normalized description; the
 * first matching rule wins. User corrections (persisted per pattern)
 * always win over rules and are matched the same way.
 *
 * A future AI module can implement the same `suggestCategory` shape in a
 * separate file without touching these rules.
 */

export type CategoryCorrection = {
  /** Lowercase normalized substring pattern. */
  pattern: string;
  category: string;
  type: TransactionType;
};

type CategoryRule = {
  category: string;
  keywords: string[];
};

const EXPENSE_RULES: CategoryRule[] = [
  {
    category: "Miete",
    keywords: [
      "miete",
      "nebenkosten",
      "hausverwaltung",
      "wohnungsbau",
      "kaution",
      "strom",
      "gas",
      "wasser",
      "stadtwerke",
      "heizung",
      "rundfunk",
      "gez",
      "internet",
      "telekom",
      "vodafone",
      "o2",
      "1&1",
    ],
  },
  {
    category: "Lebensmittel",
    keywords: [
      "aldi",
      "lidl",
      "rewe",
      "edeka",
      "penny",
      "netto",
      "kaufland",
      "tegut",
      "dm",
      "rossmann",
      "bäcker",
      "baecker",
      "metzger",
      "supermarkt",
      "lebensmittel",
    ],
  },
  {
    category: "Transport",
    keywords: [
      "deutsche bahn",
      "db ",
      "tankstelle",
      "shell",
      "aral",
      "esso",
      "benzin",
      "diesel",
      "parken",
      "parkhaus",
      "mvv",
      "bvg",
      "hvv",
      "vgn",
      "bus",
      "bahn",
      "flug",
      "lufthansa",
      "ryanair",
      "taxi",
      "uber",
      "bolt",
      "kfz",
      "versicherung",
      "werkstatt",
    ],
  },
  {
    category: "Freizeit",
    keywords: [
      "kino",
      "cinestar",
      "cinemaxx",
      "uci",
      "restaurant",
      "pizza",
      "döner",
      "doener",
      "burger",
      "cafe",
      "café",
      "kaffee",
      "starbucks",
      "bar",
      "kneipe",
      "theater",
      "museum",
      "konzert",
      "ticket",
      "eventim",
      "schwimmbad",
      "fitness",
      "mcfit",
      "bowling",
      "minigolf",
      "zoo",
      "netflix",
      "spotify",
      "disney",
      "prime",
      "steam",
    ],
  },
  {
    category: "Studium",
    keywords: [
      "uni",
      "universität",
      "universitaet",
      "hochschule",
      "semesterbeitrag",
      "studiengebühr",
      "studiengebuehr",
      "bibliothek",
      "buchhandlung",
      "thalia",
      "hugendubel",
      "lehrbuch",
      "skript",
      "copy",
      "kopie",
      "druck",
    ],
  },
  {
    category: "Gesundheit",
    keywords: [
      "apotheke",
      "arzt",
      "zahnarzt",
      "praxis",
      "klinik",
      "krankenhaus",
      "krankenkasse",
      "aok",
      "tk ",
      "barmer",
      "dak",
      "optiker",
      "fielmann",
      "docmorris",
    ],
  },
  {
    category: "Abos",
    keywords: [
      "abo",
      "mitgliedschaft",
      "beitrag",
      "icloud",
      "google one",
      "microsoft",
      "adobe",
      "audible",
      "gym",
      "verein",
      "zeitung",
      "spiegel",
      "zeit ",
    ],
  },
];

const INCOME_RULES: CategoryRule[] = [
  {
    category: "Gehalt",
    keywords: [
      "gehalt",
      "lohn",
      "arbeitgeber",
      "bezüge",
      "bezuege",
      "entgelt",
      "vergütung",
      "verguetung",
    ],
  },
  {
    category: "Stipendium",
    keywords: ["stipendium", "bafög", "bafoeg", "förderung", "foerderung"],
  },
  {
    category: "Nebenjob",
    keywords: [
      "minijob",
      "werkstudent",
      "aushilfe",
      "honorar",
      "freelance",
      "nebenjob",
    ],
  },
];

const TRANSFER_KEYWORDS = [
  "umbuchung",
  "übertrag",
  "eigenübertrag",
  "tagesgeld",
  "festgeld",
  "sparkonto",
];

const FEE_KEYWORDS = [
  "kontoführung",
  "kontofuehrung",
  "kontogebühr",
  "kontogebuehr",
  "gebühr",
  "gebuehr",
  "zinsen",
  "sollzins",
  "überziehung",
];

export function normalizeDescription(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ä]/g, "a")
    .replace(/[ö]/g, "o")
    .replace(/[ü]/g, "u")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9äöüß& ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesKeyword(haystack: string, keyword: string): boolean {
  const needle = normalizeDescription(keyword);

  if (needle === "") return false;

  return haystack.includes(needle);
}

export function suggestCategory(
  description: string,
  type: TransactionType,
  corrections: CategoryCorrection[] = [],
): { category: string; reason: string } {
  const normalized = normalizeDescription(description);

  for (const correction of corrections) {
    if (
      correction.type === type &&
      correction.pattern !== "" &&
      normalized.includes(correction.pattern)
    ) {
      return {
        category: correction.category,
        reason: "Aus deiner früheren Korrektur übernommen",
      };
    }
  }

  if (TRANSFER_KEYWORDS.some((word) => matchesKeyword(normalized, word))) {
    return { category: "Umbuchung", reason: "Enthält Umbuchungs-Stichwort" };
  }

  if (FEE_KEYWORDS.some((word) => matchesKeyword(normalized, word))) {
    return { category: "Sonstiges", reason: "Bankgebühr erkannt" };
  }

  const rules = type === "income" ? INCOME_RULES : EXPENSE_RULES;

  for (const rule of rules) {
    const hit = rule.keywords.find((word) =>
      matchesKeyword(normalized, word),
    );

    if (hit !== undefined) {
      return { category: rule.category, reason: `Stichwort „${hit}“` };
    }
  }

  return { category: "Sonstiges", reason: "Keine Regel getroffen" };
}

/**
 * Builds a correction pattern from a description: the first two
 * significant words, so future similar descriptions match again.
 */
export function correctionPatternFor(description: string): string {
  const words = normalizeDescription(description)
    .split(" ")
    .filter((word) => word.length > 2);

  return words.slice(0, 2).join(" ");
}
