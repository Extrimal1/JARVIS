import { parseISODateLocal } from "@/src/lib/calendar";
import type { TransactionType } from "@/src/lib/finance";

export type ParsedTransaction = {
  tempId: string;
  /** YYYY-MM-DD, "" when no valid date was found (must be fixed in review). */
  date: string;
  description: string;
  amountCents: number;
  currency: string;
  type: TransactionType;
  /** True only for explicit signs, S/H markers, or accounting parens. */
  typeExplicit: boolean;
  needsReview: boolean;
  reviewReasons: string[];
};

export type StatementPeriod = {
  from: string;
  to: string;
  openingCents: number | null;
  closingCents: number | null;
};

export type ParsedStatement = {
  transactions: ParsedTransaction[];
  period: StatementPeriod | null;
  /** 1-based line numbers that looked like transactions but were skipped. */
  skippedLines: number[];
  warnings: string[];
};

const SKIP_PATTERNS = [
  /saldo/i,
  /kontostand/i,
  /summe/i,
  /\bgesamt\b/i,
  /\btotal\b/i,
  /übertrag/i,
  /kreditrahmen/i,
  /\blimit\b/i,
  /verfügbar/i,
  /verfuegbar/i,
  /seite\s*\d+/i,
  /\bblz\b/i,
  /\bbic\b/i,
  /kontoauszug/i,
  /auszug\s*(nr|nummer)?\.?\s*\d*/i,
  /buchungstag/i,
  /buchungstext/i,
  /umsatzübersicht/i,
  /umsatzuebersicht/i,
  /valuta\s+betrag/i,
];

const DATE_RES = [
  /(\d{1,2})\.(\d{1,2})\.(\d{4})/,
  /(\d{1,2})\.(\d{1,2})\.(\d{2})(?!\d)/,
  /(\d{4})-(\d{2})-(\d{2})/,
];

const IBAN_PATTERN = /\bDE\d{2}[\d\s]{16,24}\b/gi;

const TRANSFER_WORDS = [
  "umbuchung",
  "übertrag",
  "eigenübertrag",
  "tagesgeld",
  "festgeld",
  "sparkonto",
];

const REFUND_WORDS = [
  "rückerstattung",
  "rueckerstattung",
  "refund",
  "gutschrift",
  "storno",
  "retoure",
  "erstattung",
];

function toISODate(day: number, month: number, year: number): string | null {
  const fullYear = year < 100 ? (year >= 70 ? 1900 + year : 2000 + year) : year;
  const iso = `${fullYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return parseISODateLocal(iso) === null ? null : iso;
}

function findDate(text: string): { iso: string; token: string } | null {
  for (const pattern of DATE_RES) {
    const match = pattern.exec(text);
    if (!match) continue;

    let iso: string | null = null;

    if (pattern === DATE_RES[2]) {
      const candidate = `${match[1]}-${match[2]}-${match[3]}`;
      iso = parseISODateLocal(candidate) === null ? null : candidate;
    } else {
      iso = toISODate(Number(match[1]), Number(match[2]), Number(match[3]));
    }

    if (iso !== null) {
      return { iso, token: match[0] };
    }
  }

  return null;
}

type FoundAmount = {
  cents: number;
  token: string;
  /** Explicit +/- sign, S/H marker, or accounting parens. */
  sign: 1 | -1 | null;
  marker: "sign" | "code" | "parens" | null;
};

function germanToCents(intPart: string, decimals: string): number | null {
  const plain = intPart.replace(/\./g, "");
  if (!/^\d+$/.test(plain)) return null;

  const cents = Number(plain) * 100 + Number(decimals);

  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * Finds the transaction amount on a date-stripped line. Prefers amounts
 * with explicit sign information; falls back to the first plain amount.
 */
function findAmount(text: string): FoundAmount | null {
  const plain: FoundAmount[] = [];
  // Group 1: sign, 2: integer part, 3: decimals, 4: S/H code.
  const pattern =
    /([+\-−])?\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:[,.](\d{2}))?\s*(EUR|€|USD|\$|GBP|£|CHF)?\s*([SH])?(?![\d,])/g;
  let match = pattern.exec(text);

  while (match !== null) {
    const [, sign, intPart, decimals, , code] = match;

    // Skip bare integers without decimals, currency, sign, or code:
    // years, page numbers, and references are not amounts.
    if (
      decimals === undefined &&
      sign === undefined &&
      code === undefined &&
      !/(EUR|€|USD|\$|GBP|£|CHF)/.test(match[0])
    ) {
      match = pattern.exec(text);
      continue;
    }

    const cents = germanToCents(intPart, decimals ?? "00");

    if (cents === null || cents <= 0) {
      match = pattern.exec(text);
      continue;
    }

    // A dot-decimal like "26.10" without comma is ambiguous with dates;
    // dates were stripped before, but stay conservative anyway.
    if (
      decimals !== undefined &&
      match[0].includes(".") &&
      !match[0].includes(",") &&
      !/(EUR|€|USD|\$|GBP|£|CHF)/.test(match[0]) &&
      !/(\$|£|USD|GBP|CHF)/.test(text) &&
      sign === undefined &&
      code === undefined
    ) {
      match = pattern.exec(text);
      continue;
    }

    const entry: FoundAmount = {
      cents,
      token: match[0],
      sign: sign === "+" ? 1 : sign === undefined ? null : -1,
      marker:
        sign === undefined && code === undefined
          ? null
          : code !== undefined
            ? "code"
            : "sign",
    };

    if (code === "S") entry.sign = -1;
    if (code === "H") entry.sign = 1;

    plain.push(entry);
    match = pattern.exec(text);
  }

  // Accounting parens: (1.234,56) counts as an explicit negative.
  const paren = /\(([^()]*)\)/g;
  let parenMatch = paren.exec(text);

  while (parenMatch !== null) {
    const inner = findAmountInner(parenMatch[1]);

    if (inner !== null) {
      return { ...inner, sign: -1, marker: "parens" };
    }

    parenMatch = paren.exec(text);
  }

  const explicit = plain.find((item) => item.sign !== null);
  if (explicit) return explicit;

  return plain[0] ?? null;
}

function findAmountInner(text: string): FoundAmount | null {
  const pattern =
    /(\d{1,3}(?:\.\d{3})*|\d+)(?:[,.](\d{2}))?\s*(EUR|€|USD|\$|GBP|£|CHF)?/;
  const match = pattern.exec(text);
  if (!match) return null;

  const cents = germanToCents(match[1], match[2] ?? "00");
  if (cents === null || cents <= 0) return null;

  return { cents, token: match[0], sign: null, marker: null };
}

function detectCurrency(text: string): string {
  const upper = text.toUpperCase();

  if (/\$/.test(text) || upper.includes("USD")) return "USD";
  if (/£/.test(text) || upper.includes("GBP")) return "GBP";
  if (upper.includes("CHF")) return "CHF";

  return "EUR";
}

function containsWord(haystack: string, words: string[]): boolean {
  const padded = ` ${haystack.toLowerCase()} `;

  return words.some((word) => padded.includes(` ${word} `));
}

function maskIbans(text: string): string {
  return text
    .replace(IBAN_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isBalanceLine(text: string): boolean {
  return SKIP_PATTERNS.some((pattern) => pattern.test(text));
}

function extractBalanceAmount(text: string): number | null {
  const found = findAmount(text);

  return found === null ? null : found.cents;
}

/**
 * Parses statement text lines (top-down, as emitted by the extractor)
 * into candidate transactions. Never invents data: anything unclear
 * is flagged with review reasons for the user to confirm.
 */
export function parseStatement(inputLines: string[]): ParsedStatement {
  const transactions: ParsedTransaction[] = [];
  const skippedLines: number[] = [];
  const warnings: string[] = [];
  const balanceAmounts: { line: number; cents: number }[] = [];
  let continuations = 0;
  let counter = 0;

  inputLines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = maskIbans(rawLine).replace(/\s+/g, " ").trim();

    if (line === "") return;

    if (isBalanceLine(line)) {
      // Only genuine balance lines feed opening/closing; limits and totals
      // are skipped without being mistaken for balances either.
      if (/saldo|kontostand/i.test(line)) {
        const cents = extractBalanceAmount(line);

        if (cents !== null) {
          balanceAmounts.push({ line: lineNumber, cents });
        }
      }

      return;
    }

    const foundDate = findDate(line);
    const withoutDate =
      foundDate === null ? line : line.replace(foundDate.token, " ");
    const foundAmount = findAmount(withoutDate);

    if (foundDate === null || foundAmount === null) {
      // Possible description continuation of the previous transaction.
      const previous = transactions[transactions.length - 1];

      if (
        foundDate === null &&
        foundAmount === null &&
        previous !== undefined &&
        continuations < 3 &&
        line.length >= 3 &&
        line.length <= 160 &&
        !/\d{4,}/.test(line)
      ) {
        previous.description = `${previous.description} ${line}`
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);
        continuations += 1;
        return;
      }

      skippedLines.push(lineNumber);
      return;
    }

    continuations = 0;
    counter += 1;

    let description = withoutDate
      .replace(foundAmount.token, " ")
      .replace(/\s+/g, " ")
      .trim();
    description = maskIbans(description);

    const reviewReasons: string[] = [];
    let type: ParsedTransaction["type"] = "expense";
    let typeExplicit = false;

    if (foundAmount.sign === 1) {
      type = "income";
      typeExplicit = true;
    } else if (foundAmount.sign === -1) {
      type = "expense";
      typeExplicit = true;
    } else if (containsWord(description, REFUND_WORDS)) {
      type = "income";
      reviewReasons.push("Als Erstattung erkannt – Typ bitte prüfen");
    } else {
      reviewReasons.push("Ein-/Ausgabe nicht erkennbar – bitte prüfen");
    }

    if (containsWord(description, TRANSFER_WORDS)) {
      reviewReasons.push("Sieht wie eine Umbuchung aus");
    }

    if (!typeExplicit && foundAmount.marker === null) {
      // counted once: the generic reason above already covers it
    }

    const currency = detectCurrency(withoutDate);

    if (currency !== "EUR") {
      reviewReasons.push(`Fremdwährung (${currency}) – Betrag prüfen`);
    }

    if (description === "") {
      description = "(keine Beschreibung)";
      reviewReasons.push("Keine Beschreibung gefunden");
    }

    // A second, different amount on the same line usually means a
    // balance column leaked in: flag it instead of guessing.
    const rest = withoutDate.replace(foundAmount.token, " ");
    const second = findAmount(rest);

    if (second !== null && second.cents !== foundAmount.cents) {
      reviewReasons.push("Mehrere Beträge in einer Zeile – bitte prüfen");
    }

    transactions.push({
      tempId: `row-${counter}`,
      date: foundDate.iso,
      description: description.slice(0, 300),
      amountCents: foundAmount.cents,
      currency,
      type,
      typeExplicit,
      needsReview: reviewReasons.length > 0,
      reviewReasons,
    });
  });

  if (transactions.length === 0) {
    warnings.push(
      "Keine einzige Buchung erkannt. Das PDF enthält vermutlich kein lesbares Umsatzformat.",
    );
  }

  const dates = transactions.map((item) => item.date).sort();
  const period =
    dates.length === 0
      ? null
      : {
          from: dates[0],
          to: dates[dates.length - 1],
          openingCents:
            balanceAmounts.length > 0 ? balanceAmounts[0].cents : null,
          closingCents:
            balanceAmounts.length > 0
              ? balanceAmounts[balanceAmounts.length - 1].cents
              : null,
        };

  return { transactions, period, skippedLines, warnings };
}
