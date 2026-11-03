/**
 * Deterministic command understanding for German and Russian.
 *
 * This is a transparent rule-based parser (same category as the
 * existing rule-based category suggester): no model, no network, no
 * guessing. Anything it cannot resolve precisely becomes a `clarify`
 * plan instead of an invented value.
 *
 * Pure module: resolves relative dates only from `ctx.todayISO`
 * (the user's local day) with DST-immune UTC-noon date math.
 */

import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from "@/src/lib/finance";
import { suggestCategory } from "@/src/lib/finance/categories";
import {
  canonicalizeQuery,
  detectPlaceCategory,
} from "@/src/lib/lifestyle/intent";
import {
  addDaysISO,
  mondayOfISO,
  weekdayOfISO,
  type AssistantLocale,
  type AssistantPlan,
  type CalendarPlanType,
  type ClarifyOption,
  type EventPatch,
  type NluContext,
} from "./actions";

export type ParseResult = {
  plan: AssistantPlan;
  /** Command language (auto-detected, Cyrillic wins). */
  locale: AssistantLocale;
};

type Span = { start: number; end: number };

/** Collect claimed char ranges so the title keeps original casing. */
class Lexer {
  lower: string;
  raw: string;
  private spans: Span[] = [];

  constructor(text: string) {
    this.raw = text.trim().replace(/\s+/g, " ");
    this.lower = this.raw.toLowerCase();
  }

  claim(start: number, end: number): void {
    if (end > start) this.spans.push({ start, end });
  }

  claimMatch(match: RegExpMatchArray): void {
    this.claim(match.index ?? 0, (match.index ?? 0) + match[0].length);
  }

  /** True when any claimed span overlaps [start, start + length). */
  isClaimed(start: number, length: number): boolean {
    const end = start + length;

    return this.spans.some(
      (span) => start < span.end && span.start < end,
    );
  }

  /**
   * First match of `pattern` outside claimed spans (global scan).
   * Needed when an earlier extractor consumed an overlapping phrase
   * ("5.11." as a date must not resurface as time 05:11).
   */
  firstUnclaimed(pattern: RegExp): RegExpMatchArray | null {
    const flags = pattern.flags.includes("g")
      ? pattern.flags
      : `${pattern.flags}g`;
    const global = new RegExp(pattern.source, flags);
    let match: RegExpExecArray | null;

    while ((match = global.exec(this.lower)) !== null) {
      const start = match.index ?? 0;

      if (!this.isClaimed(start, match[0].length)) {
        return match;
      }

      if (match[0].length === 0) break;
    }

    return null;
  }

  /** Unclaimed remainder (original casing) as clean title material. */
  remaining(): string {
    if (this.lower.length !== this.raw.length) {
      return this.lower;
    }

    const sorted = [...this.spans].sort((a, b) => a.start - b.start);
    const parts: string[] = [];
    let cursor = 0;

    for (const span of sorted) {
      if (span.start > cursor) {
        parts.push(this.raw.slice(cursor, span.start));
      }
      cursor = Math.max(cursor, span.end);
    }

    if (cursor < this.raw.length) {
      parts.push(this.raw.slice(cursor));
    }

    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function minutesToTime(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, total));

  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

// ---------------------------------------------------------------- weekdays

const WEEKDAY_DE: Record<string, number> = {
  montag: 1,
  dienstag: 2,
  mittwoch: 3,
  donnerstag: 4,
  freitag: 5,
  samstag: 6,
  sonntag: 0,
};

const WEEKDAY_RU: Record<string, number> = {
  понедельник: 1,
  вторник: 2,
  среда: 3,
  среду: 3,
  четверг: 4,
  пятница: 5,
  пятницу: 5,
  суббота: 6,
  субботу: 6,
  воскресенье: 0,
};

const MONTH_DE: Record<string, number> = {
  januar: 1,
  februar: 2,
  märz: 3,
  maerz: 3,
  april: 4,
  mai: 5,
  juni: 6,
  juli: 7,
  august: 8,
  september: 9,
  oktober: 10,
  november: 11,
  dezember: 12,
};

const MONTH_RU: Record<string, number> = {
  января: 1,
  январь: 1,
  февраля: 2,
  февраль: 2,
  марта: 3,
  март: 3,
  апреля: 4,
  апрель: 4,
  мая: 5,
  май: 5,
  июня: 6,
  июнь: 6,
  июля: 7,
  июль: 7,
  августа: 8,
  август: 8,
  сентября: 9,
  сентябрь: 9,
  октября: 10,
  октябрь: 10,
  ноября: 11,
  ноябрь: 11,
  декабря: 12,
  декабрь: 12,
};

const NUMBER_WORD_DE: Record<string, number> = {
  eins: 1,
  ein: 1,
  eine: 1,
  einer: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  fünf: 5,
  fuenf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwölf: 12,
  zwoelf: 12,
};

const NUMBER_WORD_RU: Record<string, number> = {
  один: 1,
  одна: 1,
  два: 2,
  две: 2,
  три: 3,
  четыре: 4,
  пять: 5,
  шесть: 6,
  семь: 7,
  восемь: 8,
  девять: 9,
  десять: 10,
  одиннадцать: 11,
  двенадцать: 12,
};

/** Next occurrence of a weekday; a bare same-weekday means today. */
function resolveWeekday(
  todayISO: string,
  target: number,
  nextWeek: boolean,
): string {
  const current = weekdayOfISO(todayISO);
  let delta = (target - current + 7) % 7;

  if (nextWeek) delta += 7;

  return addDaysISO(todayISO, delta);
}

function validDateOrNull(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const probe = new Date(Date.UTC(year, month - 1, day));

  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// ------------------------------------------------------------------ dates

export type ExtractedDate = { date: string };

/**
 * Single-day extraction. `pastBias` (finance) resolves year-less dates
 * to the most recent past occurrence; otherwise to the next upcoming
 * one. Returns null when no date phrase is found.
 */
export function extractDate(
  lexer: Lexer,
  todayISO: string,
  pastBias: boolean,
): ExtractedDate | null {
  const year = Number(todayISO.slice(0, 4));

  // Explicit DD.MM.YYYY / DD.MM.YY.
  const fullMatch = lexer.firstUnclaimed(
    /(?:am\s+|an\s+)?(\d{1,2})\.(\d{1,2})\.(\d{2,4})/,
  );

  if (fullMatch !== null) {
    const day = Number(fullMatch[1]);
    const month = Number(fullMatch[2]);
    let fullYear = Number(fullMatch[3]);

    if (fullYear < 100) fullYear += 2000;

    const resolved = validDateOrNull(fullYear, month, day);

    if (resolved !== null) {
      lexer.claimMatch(fullMatch);

      return { date: resolved };
    }
  }

  // Explicit DD.MM. / DD.MM (year inferred).
  const shortMatch = lexer.firstUnclaimed(
    /(?:am\s+|an\s+)?(\d{1,2})\.(\d{1,2})\.?/,
  );

  if (shortMatch !== null) {
    const day = Number(shortMatch[1]);
    const month = Number(shortMatch[2]);

    // Guard against times ("15.30") and amounts ("24,50" never matches
    // — comma — but "1.234" could): a month part above 12 is no date.
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let candidate = validDateOrNull(year, month, day);

      if (candidate !== null) {
        if (!pastBias && candidate < todayISO) {
          candidate =
            validDateOrNull(year + 1, month, day) ?? candidate;
        } else if (pastBias && candidate > todayISO) {
          candidate =
            validDateOrNull(year - 1, month, day) ?? candidate;
        }

        lexer.claimMatch(shortMatch);

        return { date: candidate };
      }
    }
  }

  // "am 5." / "5. november" / "5 ноября" (+ optional year).
  const namedMatch = lexer.firstUnclaimed(
    /(?:am\s+)?(\d{1,2})\.\s*([a-zäöüßа-яё]+)(?:\s+(\d{4}))?/,
  );

  if (namedMatch !== null) {
    const day = Number(namedMatch[1]);
    const month =
      MONTH_DE[namedMatch[2]] ?? MONTH_RU[namedMatch[2]] ?? null;

    if (month !== null) {
      const namedYear =
        namedMatch[3] === undefined ? year : Number(namedMatch[3]);
      let candidate = validDateOrNull(namedYear, month, day);

      if (candidate !== null) {
        if (namedMatch[3] === undefined) {
          if (!pastBias && candidate < todayISO) {
            candidate =
              validDateOrNull(namedYear + 1, month, day) ?? candidate;
          } else if (pastBias && candidate > todayISO) {
            candidate =
              validDateOrNull(namedYear - 1, month, day) ?? candidate;
          }
        }

        lexer.claimMatch(namedMatch);

        return { date: candidate };
      }
    }
  }

  // Relative days (leading "am/für" claimed too, for clean titles).
  const relative: [RegExp, number][] = [
    [/(?:am\s+|für\s+)?\bheute\b/, 0],
    [/(?:am\s+|für\s+)?\bmorgen\b/, 1],
    [/(?:am\s+|für\s+)?(?:übermorgen|ubermorgen)/, 2],
    [/\bgestern\b/, -1],
    [/\bvorgestern\b/, -2],
    [/сегодня/, 0],
    [/послезавтра/, 2],
    [/завтра/, 1],
    [/позавчера/, -2],
    [/вчера/, -1],
  ];

  for (const [pattern, delta] of relative) {
    const match = lexer.firstUnclaimed(pattern);

    if (match !== null) {
      lexer.claimMatch(match);

      return { date: addDaysISO(todayISO, delta) };
    }
  }

  // Weekdays, with optional "nächsten / в следующий".
  const weekdayMatch = lexer.firstUnclaimed(
    /(?:am\s+|an\s+)?(nächst(?:en|e|es|er))?\s*(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)/,
  );

  if (weekdayMatch !== null) {
    lexer.claimMatch(weekdayMatch);

    return {
      date: resolveWeekday(
        todayISO,
        WEEKDAY_DE[weekdayMatch[2]],
        weekdayMatch[1] !== undefined,
      ),
    };
  }

  const weekdayRuMatch = lexer.firstUnclaimed(
    /(?:в\s+|во\s+)?(следующ(?:ий|ую|ее))?\s*(понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресенье)/,
  );

  if (weekdayRuMatch !== null) {
    lexer.claimMatch(weekdayRuMatch);

    return {
      date: resolveWeekday(
        todayISO,
        WEEKDAY_RU[weekdayRuMatch[2]] ?? 1,
        weekdayRuMatch[1] !== undefined,
      ),
    };
  }

  return null;
}

// ------------------------------------------------------------------ times

export type ExtractedTime =
  | { kind: "time"; start: string }
  | { kind: "ambiguous"; hour: number; minutes: number };

const AFTERNOON_DE = /nachmittags|abends|nachmittag|abend/;
const MORNING_DE = /morgens|vormittags|früh|frueh|morgen früh/;
const NIGHT_DE = /nachts|nacht/;

function applyDaypart(hour: number, lower: string, locale: AssistantLocale): number {
  if (locale === "ru") {
    if (/днём|днем|дня|вечером|вечера/.test(lower)) {
      return hour < 12 ? hour + 12 : hour;
    }

    return hour;
  }

  if (AFTERNOON_DE.test(lower)) {
    return hour < 12 ? hour + 12 : hour;
  }

  if (MORNING_DE.test(lower) || NIGHT_DE.test(lower)) {
    return hour >= 12 ? hour - 12 : hour;
  }

  return hour;
}

function hourToTime(
  hour: number,
  minutes: number,
  lower: string,
  locale: AssistantLocale,
): ExtractedTime {
  const qualified =
    locale === "ru"
      ? /утра|утром|днём|днем|дня|вечером|вечера|ночи|ночью/.test(lower)
      : AFTERNOON_DE.test(lower) ||
        MORNING_DE.test(lower) ||
        NIGHT_DE.test(lower);

  // Bare 0–6 o'clock is genuinely ambiguous (3:00 vs. 15:00):
  // clarify instead of inventing.
  if (!qualified && hour >= 0 && hour <= 6) {
    return { kind: "ambiguous", hour, minutes };
  }

  return {
    kind: "time",
    start: minutesToTime(applyDaypart(hour, lower, locale) * 60 + minutes),
  };
}

const BARE_HOUR_PATTERN =
  /(?:um|von|ab|gegen|в|во|к)\s+(\d{1,2}|eins|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|одиннадцать|двенадцать)(?:\s*(?:uhr|stunden?|h|час(?:а|ов)?))?(?![\wа-яё])/;

const DAYPART_DE = /morgens|vormittags|nachmittags|nachmittag|abends|abend|früh|frueh|nachts|nacht/;
const DAYPART_RU = /утром|утра|днём|днем|дня|вечером|вечера|ночью|ночи/;

const TIME_PREP_BEFORE = /(um|von|ab|gegen|в|во|к)\s+$/;

/** Claim a time preposition ("um"/"в") directly before `at`. */
function claimTimePrefix(lexer: Lexer, lower: string, at: number): void {
  const prefix = TIME_PREP_BEFORE.exec(lower.slice(0, at));

  if (prefix !== null) {
    lexer.claim(at - prefix[0].length, at);
  }
}

export function extractTime(
  lexer: Lexer,
  locale: AssistantLocale,
): ExtractedTime | null {
  const lower = lexer.lower;

  // Dayparts ("nachmittags", "вечером") are time material: claim them
  // so they never leak into titles.
  const daypart = lexer.firstUnclaimed(
    locale === "ru" ? DAYPART_RU : DAYPART_DE,
  );

  if (daypart !== null) {
    lexer.claimMatch(daypart);
  }

  // Explicit HH:MM always wins (also over a bare hour elsewhere, e.g.
  // after an ambiguous-hour clarification appends "15:00").
  const colonMatch = lexer.firstUnclaimed(/(\d{1,2}):(\d{2})(?:\s*uhr)?/);

  if (colonMatch !== null) {
    const hour = Number(colonMatch[1]);
    const minutes = Number(colonMatch[2]);

    if (hour <= 23 && minutes <= 59) {
      const at = colonMatch.index ?? 0;
      lexer.claimMatch(colonMatch);
      claimTimePrefix(lexer, lower, at);

      // A leftover bare hour ("um 3 … 15:00") must not leak into titles.
      const leftover = lexer.firstUnclaimed(BARE_HOUR_PATTERN);

      if (leftover !== null) {
        lexer.claimMatch(leftover);
      }

      return { kind: "time", start: `${pad2(hour)}:${pad2(minutes)}` };
    }
  }

  // "halb 4" / "halb vier" → :30 of the previous hour.
  const halbMatch =
    /halb\s+(\d{1,2}|eins|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf)/.exec(
      lower,
    );

  if (halbMatch !== null) {
    const rawHour = Number.isNaN(Number(halbMatch[1]))
      ? (NUMBER_WORD_DE[halbMatch[1]] ?? 0)
      : Number(halbMatch[1]);

    if (rawHour >= 1 && rawHour <= 12) {
      lexer.claimMatch(halbMatch);

      return hourToTime(rawHour - 1, 30, lower, locale);
    }
  }

  // "viertel nach/vor X".
  const viertelMatch =
    /viertel\s+(nach|vor)\s+(\d{1,2}|eins|zwei|drei|vier|fünf|fuenf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwoelf)/.exec(
      lower,
    );

  if (viertelMatch !== null) {
    const rawHour = Number.isNaN(Number(viertelMatch[2]))
      ? (NUMBER_WORD_DE[viertelMatch[2]] ?? 0)
      : Number(viertelMatch[2]);

    if (rawHour >= 1 && rawHour <= 12) {
      lexer.claimMatch(viertelMatch);

      const hour = viertelMatch[1] === "nach" ? rawHour : rawHour - 1;
      const minutes = viertelMatch[1] === "nach" ? 15 : 45;

      return hourToTime(hour, minutes, lower, locale);
    }
  }

  // "um 15 [Uhr]" / "в 15 [часов]" — digits or number words.
  // ("bis/до" are end markers, handled by extractEnd — never a start.)
  const umMatch = lexer.firstUnclaimed(BARE_HOUR_PATTERN);

  if (umMatch !== null) {
    const token = umMatch[1];
    const hour = Number.isNaN(Number(token))
      ? (NUMBER_WORD_DE[token] ?? NUMBER_WORD_RU[token] ?? -1)
      : Number(token);

    if (hour >= 0 && hour <= 23) {
      lexer.claimMatch(umMatch);

      if (hour === 0) {
        return { kind: "time", start: "00:00" };
      }

      // Two-digit hours above 12 are unambiguous.
      if (hour > 12) {
        return { kind: "time", start: `${pad2(hour)}:00` };
      }

      return hourToTime(hour, 0, lower, locale);
    }
  }

  // "um ein Uhr" (1 o'clock). Ein-words need the Uhr-word —
  // otherwise "um eine Vorlesung" would misread the article.
  const einMatch = lexer.firstUnclaimed(
    /(um|von|ab|gegen)\s+(ein|eine|einem)\s+(uhr|stunden?|h)\b/,
  );

  if (einMatch !== null) {
    lexer.claimMatch(einMatch);

    return hourToTime(1, 0, lower, locale);
  }

  // Dot times ("15.30"); date-like forms were claimed by extractDate.
  const dotMatch = lexer.firstUnclaimed(/(\d{1,2})\.(\d{2})(?:\s*uhr)?/);

  if (dotMatch !== null) {
    const hour = Number(dotMatch[1]);
    const minutes = Number(dotMatch[2]);

    if (hour <= 23 && minutes <= 59) {
      const at = dotMatch.index ?? 0;
      lexer.claimMatch(dotMatch);
      claimTimePrefix(lexer, lower, at);

      return { kind: "time", start: `${pad2(hour)}:${pad2(minutes)}` };
    }
  }

  // Bare "16 Uhr" / "16 часов" (no preposition) — common in moves.
  const bareUhr = lexer.firstUnclaimed(
    /(\d{1,2})\s*(uhr|час(?:а|ов)?)(?![\wа-яё])/,
  );

  if (bareUhr !== null) {
    const hour = Number(bareUhr[1]);

    if (hour <= 23) {
      lexer.claimMatch(bareUhr);

      if (hour === 0) {
        return { kind: "time", start: "00:00" };
      }

      if (hour > 12) {
        return { kind: "time", start: `${pad2(hour)}:00` };
      }

      return hourToTime(hour, 0, lower, locale);
    }
  }

  const middayMatch = lexer.firstUnclaimed(/\bmittags\b|в\s+полдень/);

  if (middayMatch !== null) {
    lexer.claimMatch(middayMatch);

    return { kind: "time", start: "12:00" };
  }

  const midnightMatch = lexer.firstUnclaimed(/\bmitternacht\b|в\s+полночь/);

  if (midnightMatch !== null) {
    lexer.claimMatch(midnightMatch);

    return { kind: "time", start: "00:00" };
  }

  return null;
}

// --------------------------------------------------------------- end/dur

export type ExtractedEnd = { end: string } | { durationMin: number };

/**
 * End/duration phrases. Runs BEFORE extractTime so "bis 15:30" is
 * claimed as an end, never mistaken for a start. The caller validates
 * end > start (single-day events only).
 */
export function extractEnd(lexer: Lexer): ExtractedEnd | null {
  const bisMatch = lexer.firstUnclaimed(
    /(?:bis|до)\s+(\d{1,2})(?:[:.](\d{2}))?(?:\s*uhr)?/,
  );

  if (bisMatch !== null) {
    const hour = Number(bisMatch[1]);
    const minutes = bisMatch[2] === undefined ? 0 : Number(bisMatch[2]);

    if (hour <= 23 && minutes <= 59) {
      lexer.claimMatch(bisMatch);

      return { end: `${pad2(hour)}:${pad2(minutes)}` };
    }
  }

  const lower = lexer.lower;

  const hoursMatch = lexer.firstUnclaimed(
    /(\d+(?:[.,]\d+)?|eineinhalb|anderthalb)\s*(stunden?|std\.?|час(?:а|ов)?)/,
  );

  if (hoursMatch !== null) {
    const token = hoursMatch[1];
    const hours =
      token === "eineinhalb" || token === "anderthalb"
        ? 1.5
        : Number(token.replace(",", "."));

    if (Number.isFinite(hours) && hours > 0 && hours <= 12) {
      const at = hoursMatch.index ?? 0;

      // "в 3 часа" is a time, not a duration — leave it for extractTime.
      if (
        /час/.test(hoursMatch[2]) &&
        TIME_PREP_BEFORE.test(lower.slice(0, at))
      ) {
        // Fall through to the remaining duration branches.
      } else {
        lexer.claimMatch(hoursMatch);

        return { durationMin: Math.round(hours * 60) };
      }
    }
  }

  const oneHour = lexer.firstUnclaimed(
    /einstündig\w*|einstuendig\w*/,
  );

  if (oneHour !== null) {
    lexer.claimMatch(oneHour);

    return { durationMin: 60 };
  }

  const halfHour = lexer.firstUnclaimed(
    /halbstündig\w*|halbstuendig\w*|halbe\s+stunde|полчаса/,
  );

  if (halfHour !== null) {
    lexer.claimMatch(halfHour);

    return { durationMin: 30 };
  }

  const naChas = lexer.firstUnclaimed(/на\s+час(?![а-яё])/);

  if (naChas !== null) {
    lexer.claimMatch(naChas);

    return { durationMin: 60 };
  }

  const minutesMatch =
    /(\d+)\s*(?:minuten?|min\.?|минут(?:ы|у)?)/.exec(lower);

  if (minutesMatch !== null) {
    const minutes = Number(minutesMatch[1]);

    if (minutes > 0 && minutes <= 720) {
      lexer.claimMatch(minutesMatch);

      return { durationMin: minutes };
    }
  }

  return null;
}

// ---------------------------------------------------------------- amounts

export type ExtractedAmount = {
  amountCents: number;
  currency: string;
};

const CURRENCY_WORDS: [RegExp, string][] = [
  [/€|euro|eur\b/, "EUR"],
  [/₽|руб(?:ль|ля|лей)?|rur\b/, "RUB"],
  [/\$|dollar|usd\b/, "USD"],
  [/£|pfund|gbp\b/, "GBP"],
  [/chf\b|franken/, "CHF"],
];

function detectCurrency(lexer: Lexer, locale: AssistantLocale): string {
  for (const [pattern, code] of CURRENCY_WORDS) {
    const match = pattern.exec(lexer.lower);

    if (match !== null) {
      lexer.claimMatch(match);

      return code;
    }
  }

  return locale === "ru" ? "RUB" : "EUR";
}

function parseGermanNumber(token: string): number | null {
  const compact = token.replace(/[\s\u00a0]/g, "");

  // Thousands form "1.234" (exactly 3 decimals, no comma).
  if (/^\d{1,3}(\.\d{3})+$/.test(compact)) {
    const plain = Number(compact.replace(/\./g, ""));

    return Number.isSafeInteger(plain) ? plain * 100 : null;
  }

  // Thousands dots + decimal comma "1.234,56".
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(compact)) {
    return parseGermanDecimal(compact.replace(/\./g, ""));
  }

  return parseGermanDecimal(compact);
}

/** Reuse the finance input semantics ("12,34" / "12.34", > 0). */
function parseGermanDecimal(token: string): number | null {
  const normalized = token.trim().replace(/\s/g, "").replace(",", ".");

  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;

  const cents = Math.round(Number(normalized) * 100);

  if (!Number.isSafeInteger(cents) || cents <= 0) return null;

  return cents;
}

export function extractAmount(
  lexer: Lexer,
  locale: AssistantLocale,
): ExtractedAmount | null {
  const lower = lexer.lower;

  // Spoken euros + cents: "24 Euro 50".
  const spokenMatch = /(\d+)\s*euro\s+(\d{1,2})\b/.exec(lower);

  if (spokenMatch !== null) {
    const cents = Number(spokenMatch[1]) * 100 + Number(spokenMatch[2]);

    if (Number.isSafeInteger(cents) && cents > 0) {
      lexer.claimMatch(spokenMatch);

      return { amountCents: cents, currency: "EUR" };
    }
  }

  // Rubles + kopeks: "500 рублей 50 копеек" / bare kopeks.
  // Alternation (never all-optional) so the first match is real.
  const rubMatch = lexer.firstUnclaimed(
    /(?:(\d+(?:[.,]\d{1,2})?)\s*(?:руб(?:ль|ля|лей)?|₽)(?:\s*(\d{1,2})\s*коп(?:еек|ейки|ейка)?)?|(\d{1,2})\s*коп(?:еек|ейки|ейка)?)/,
  );

  if (rubMatch !== null) {
    const rubles =
      rubMatch[1] === undefined
        ? 0
        : Number(rubMatch[1].replace(",", "."));
    const kopeks = Number(rubMatch[2] ?? rubMatch[3] ?? 0);
    const cents = Math.round(rubles * 100) + kopeks;

    if (Number.isSafeInteger(cents) && cents > 0) {
      lexer.claimMatch(rubMatch);

      return { amountCents: cents, currency: "RUB" };
    }
  }

  // Plain number near a currency word/symbol: "24,50 Euro", "€24",
  // "$5", "1.234,56 Euro". Thousands alternative first.
  const currencyNearby = lexer.firstUnclaimed(
    /(€|\$|₽|£)\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(€|\$|₽|£|euro|eur\b|rubel|rur\b|dollar|usd\b|pfund|gbp\b|chf\b|franken)/,
  );

  if (currencyNearby !== null) {
    const token = currencyNearby[2] ?? currencyNearby[3] ?? "";
    const cents = parseGermanNumber(token);

    if (cents !== null) {
      lexer.claimMatch(currencyNearby);
      const symbol = currencyNearby[1] ?? currencyNearby[4] ?? "";

      if (symbol === "€" || /euro|eur/.test(symbol)) {
        return { amountCents: cents, currency: "EUR" };
      }

      if (symbol === "₽" || /rubel|rur/.test(symbol)) {
        return { amountCents: cents, currency: "RUB" };
      }

      if (symbol === "$" || /dollar|usd/.test(symbol)) {
        return { amountCents: cents, currency: "USD" };
      }

      if (symbol === "£" || /pfund|gbp/.test(symbol)) {
        return { amountCents: cents, currency: "GBP" };
      }

      if (/chf|franken/.test(symbol)) {
        return { amountCents: cents, currency: "CHF" };
      }

      return { amountCents: cents, currency: detectCurrency(lexer, locale) };
    }
  }

  // Bare number with a finance verb nearby ("habe 24 bei Lidl
  // bezahlt"). Date-like ("5.11"), time-like ("15:30") and day-like
  // ("am 5.", "5. November") numbers are rejected — inventing an
  // amount from a date would be a material error.
  if (FINANCE_VERB.test(lower)) {
    const bareMatch = lexer.firstUnclaimed(
      /(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/,
    );

    if (bareMatch !== null) {
      const token = bareMatch[1];
      const at = bareMatch.index ?? 0;
      const before = lower.slice(Math.max(0, at - 4), at);
      const after = lower.slice(at + bareMatch[0].length, at + bareMatch[0].length + 12);
      const dottedDate = /^(\d{1,2})\.(\d{1,2})$/.exec(token);
      const dateLike =
        dottedDate !== null &&
        Number(dottedDate[2]) >= 1 &&
        Number(dottedDate[2]) <= 12;
      const timeLike = lower[at - 1] === ":" || lower[at + bareMatch[0].length] === ":";
      const afterIsMonthName =
        /^\s*[a-zäöüßа-яё]+/.test(after) &&
        /(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/.test(
          after,
        );
      const dayLike = /\bam\s*$/.test(before) || afterIsMonthName;

      if (!dateLike && !timeLike && !dayLike) {
        const cents = parseGermanNumber(token);

        if (cents !== null) {
          lexer.claimMatch(bareMatch);

          return {
            amountCents: cents,
            currency: detectCurrency(lexer, locale),
          };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------- signals

const FINANCE_VERB =
  /ausgeg|ausgab|bezahlt|bezahle|bezahlen|gekauft|kaufe|kaufen|kostet|kosten|einnahm|einkomm|erhalten|bekomm|gehalt|überwiesen|eingenommen|gutgeschrieben|потратил|потратила|потрачено|заплатил|купил|купила|покупка|расход|стоит|стоил|получил|получила|зарплат|доход|перевели|пришл/;

const INCOME_SIGNAL =
  /einnahm|einkomm|erhalten|bekomm|gehalt|überwiesen\s+bekomm|eingenommen|gutgeschrieben|получил|получила|зарплат|доход|перевели|пришл/;

const EXPENSE_SIGNAL =
  /ausgeg|bezahlt|bezahle|bezahlen|gekauft|kaufe|kaufen|kostet|kosten|ausgabe|потратил|потратила|потрачено|заплатил|купил|купила|покупка|расход\b|расходы|стоит|стоил/;

const CAL_CREATE_VERB =
  /plane|plan |erstelle|erstellen|trag(?:e|st)?\s+ein|mach(?:e|st)?|setze|lege?\s+an|vereinbar|hinzu|neuer?\s+termin|anlegen|создай|создать|добавь|добавить|запланируй|запланировать|новая?\s+встреча/;

const CAL_DELETE_VERB =
  /lösche|löschen|gelöscht|stornier|absag|sag(?:e|st)?\s+ab|entferne|удали|удалить|отмени|отменить/;

const CAL_UPDATE_VERB =
  /verschiebe|verschieben|verlege|verlegen|ändere|ändern|updat|korrigier|pass(?:e|st)?\s+an|перенеси|перенести|перемести|переместить|измени|изменить|поменяй|поменять/;

const CAL_LIST_SIGNAL =
  /\?|was\s+habe|habe\s+ich|wann\s+(ist|habe|findet)|welche\s+termine|zeig(?:e|st)?|liste|termine\b|kalender|что\s+у\s+меня|когда\s+у\s+меня|какие\s+встречи|покажи|расписание/;

/** Strong question signals; a bare "Termine" alone still allows create. */
const STRONG_LIST_SIGNAL =
  /\?|was\s+habe|habe\s+ich|wann\s+(ist|habe|findet)|welche\s+termine|zeig(?:e|st)?|liste|что\s+у\s+меня|когда\s+у\s+меня|какие\s+встречи|покажи|расписание/;

const FIN_LIST_SIGNAL =
  /(zeig\w*|liste\w*|letzte\w*)\b[\s\wäöüß]{0,30}?\b(buchungen|buchung|ausgaben|einnahmen|transaktionen)\b|buchungen\s+an|(покажи|последние|мои)\b[\s\wа-яё]{0,30}?\b(операции|операция|расходы|траты|покупки)\b/;

const FIN_SUMMARY_SIGNAL =
  /wie\s*viel|bilanz|übersicht|zusammenfassung|ausgaben\s+im|einnahmen\s+im|сколько|итоги|баланс/;

// ------------------------------------------------------------------ titles

const TITLE_FILLER_START =
  /^(?:bitte|mal|denn|also|einfach|für mich|mir|einen|einem|einer|eine|ein|eines|der|die|das|den|dem|einen neuen|eine neue|ein neues)\s+/;

const TITLE_FILLER_END = /\s+(?:bitte|mal|danke|für mich)$/;

function cleanTitle(raw: string): string {
  let title = raw
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();

  for (let round = 0; round < 3; round += 1) {
    const next = title
      .replace(TITLE_FILLER_START, "")
      .replace(TITLE_FILLER_END, "")
      .trim();

    if (next === title) break;

    title = next;
  }

  // Object form → nominative for Russian titles ("встречу" →
  // "Встреча"). Lookahead instead of \b (Cyrillic-safe).
  title = title.replace(/^встречу(?![а-яё])/i, "Встреча");

  return title.replace(/^[,.:;!?\-–—„“"']+|[,.:;!?\-–—„“"']+$/g, "").trim();
}

function splitLocation(
  title: string,
  locale: AssistantLocale,
): { title: string; location: string } {
  if (locale === "ru") {
    // Capitalized places only — "с Максом" is no location.
    const match = /^(.*?)(?:^|\s)(?:в|во)\s+([А-ЯЁ][^,;]*?)$/.exec(title);

    if (match !== null && match[1].trim() !== "") {
      return { title: match[1].trim(), location: match[2].trim() };
    }

    return { title, location: "" };
  }

  const match = /^(.*?)(?:^|\s)(?:im|in|bei)\s+([A-ZÄÖÜ][^,;]*?)$/.exec(title);

  if (match !== null && match[1].trim() !== "") {
    return { title: match[1].trim(), location: match[2].trim() };
  }

  return { title, location: "" };
}

function detectEventType(text: string): CalendarPlanType {
  if (/prüfung|pruefung|klausur|examen|экзамен/.test(text)) return "exam";
  if (/vorlesung|seminar|übung|uebung|lecture|лекци|семинар/.test(text)) {
    return "lecture";
  }

  return "personal";
}

/** Strip trigger verb + article + event noun to isolate a reference. */
function cleanRef(raw: string, locale: AssistantLocale): string {
  let ref = raw.replace(/\s+/g, " ").trim();

  const verbs =
    locale === "ru"
      ? /^(?:пожалуйста\s+)?(?:удали|удалить|отмени|отменить|перенеси|перенести|перемести|переместить|измени|изменить|поменяй|поменять)\s+/i
      : /^(?:bitte\s+)?(?:lösche|löschen|stornier\w*|absagen|sag(?:e|st)?\s+ab|entferne\w*|verschiebe\w*|verlege\w*|ändere\w*|updat\w*|korrigier\w*)\s+/i;

  ref = ref.replace(verbs, "");

  // Cyrillic suffixes need [а-яё]: plain \w stops before them.
  ref = ref.replace(
    locale === "ru"
      ? /^(?:мой|мою|моё|мои|этот|эту|это)?\s*(?:встреч[а-яё\w]*|совещан[а-яё\w]*|событи[а-яё\w]*|лекци[а-яё\w]*|экзамен[а-яё\w]*|семинар[а-яё\w]*)\s*/i
      : /^(?:den|die|das|der|dem|einen|eine|einem|einer|meinen|meine|meinem)?\s*(?:termin\w*|treffen|meeting\w*|besprechung\w*|vorlesung\w*|prüfung\w*|pruefung\w*|klausur\w*|seminar\w*|übung\w*|uebung\w*)\s*/i,
    "",
  );

  return cleanTitle(ref);
}

// -------------------------------------------------------------- categories

const CATEGORY_SYNONYMS: [RegExp, string][] = [
  [/lebensmittel|essen|trinken|supermarkt|einkauf|продукты|еда\b/, "Lebensmittel"],
  [/miete|nebenkosten|strom|heizung|internet|аренда|квартир/, "Miete"],
  [/transport|tanken|benzin|diesel|bahn|bus|taxi|parken|flug|транспорт|такси|бензин|проезд/, "Transport"],
  [/freizeit|kino|restaurant|cafe|café|kaffee|konzert|theater|развлечен|кино|ресторан|кафе/, "Freizeit"],
  [/studium|uni\b|universität|schule|buch|skript|уч[её]ба|универ|книг/, "Studium"],
  [/gesundheit|apotheke|arzt|zahnarzt|аптек|врач|здоровь/, "Gesundheit"],
  [/abo\b|abos|mitgliedschaft|netflix|spotify|подписк/, "Abos"],
  [/umbuchung|übertrag/, "Umbuchung"],
  [/gehalt|lohn|зарплат/, "Gehalt"],
  [/stipendium|bafög|bafoeg|стипенди/, "Stipendium"],
  [/nebenjob|minijob|werkstudent|honorar|подработк/, "Nebenjob"],
  [/erstattung|rückerstattung/, "Erstattung"],
];

function mapCategory(
  raw: string,
  type: "income" | "expense",
): string | null {
  const allowed = (type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES) as readonly string[];
  const normalized = raw.trim().toLowerCase();

  for (const name of allowed) {
    if (name.toLowerCase() === normalized) return name;
  }

  for (const [pattern, name] of CATEGORY_SYNONYMS) {
    if (
      pattern.test(normalized) &&
      (allowed as readonly string[]).includes(name)
    ) {
      return name;
    }
  }

  return null;
}

const MERCHANT_SKIP_DE =
  /^(mir|dir|uns|euch|ihm|ihr|ihnen|sich|dem|der|den|einem|einer)\b/;

function extractMerchant(
  lexer: Lexer,
  locale: AssistantLocale,
): string | null {
  // Match on the raw text (case-insensitive) so "Lidl" keeps its
  // casing; indices align 1:1 with the lowercased scan for DE/RU.
  const raw = lexer.raw;

  if (lexer.lower.length !== raw.length) return null;

  if (locale === "ru") {
    // "в <Ort>" after the amount — never a time ("в 15:00") or month.
    const match =
      /в\s+([а-яёА-ЯЁ][а-яёА-ЯЁa-zA-Z0-9&'\-. ]{1,40}?)(?=\s+(?:за|на|сегодня|вчера|позавчера)|[,.]|$)/i.exec(
        raw,
      );

    if (match?.index === undefined) return null;

    const name = cleanTitle(match[1]);

    if (name === "" || /^\d/.test(name)) return null;

    const firstWord = name.split(" ")[0].toLowerCase();

    if (MONTH_RU[firstWord] !== undefined) return null;

    lexer.claim(match.index, match.index + match[0].length);

    return name;
  }

  const match =
    /\b(?:bei|im|in)\s+([a-zäöüßA-ZÄÖÜ0-9][a-zäöüßA-ZÄÖÜ0-9&'\-. ]{0,40}?)(?=\s+(?:für|heute|gestern|vorgestern|am\s|ausgegeben|bezahlt|gekauft|kostete|€|euro|eur\b)|[,.]|$)/i.exec(
      raw,
    );

  if (match?.index === undefined) return null;

  const name = cleanTitle(match[1]);

  // Pronouns/locations ("bei mir zu Hause") are not merchants.
  if (name === "" || MERCHANT_SKIP_DE.test(name.toLowerCase())) {
    return null;
  }

  lexer.claim(match.index, match.index + match[0].length);

  return name;
}

// ---------------------------------------------------------------- messages

const CLARIFY = {
  date: {
    de: {
      question: "Für welchen Tag soll ich den Termin eintragen?",
      options: [
        { label: "Heute", text: "heute" },
        { label: "Morgen", text: "morgen" },
      ],
    },
    ru: {
      question: "На какой день запланировать встречу?",
      options: [
        { label: "Сегодня", text: "сегодня" },
        { label: "Завтра", text: "завтра" },
      ],
    },
  },
  time: {
    de: {
      question: "Um wie viel Uhr beginnt der Termin?",
      options: [
        { label: "9:00 Uhr", text: "um 9:00" },
        { label: "15:00 Uhr", text: "um 15:00" },
      ],
    },
    ru: {
      question: "Во сколько начало встречи?",
      options: [
        { label: "9:00", text: "в 9:00" },
        { label: "15:00", text: "в 15:00" },
      ],
    },
  },
  title: {
    de: { question: "Wie soll der Termin heißen?", options: [] },
    ru: { question: "Как назвать встречу?", options: [] },
  },
  amount: {
    de: {
      question: "Wie hoch ist der Betrag? Zum Beispiel „24,50 Euro“.",
      options: [],
    },
    ru: {
      question: "Какая сумма? Например, «500 рублей».",
      options: [],
    },
  },
  direction: {
    de: {
      question: "Ist das eine Ausgabe oder eine Einnahme?",
      options: [
        { label: "Ausgabe", text: "Ausgabe" },
        { label: "Einnahme", text: "Einnahme erhalten" },
      ],
    },
    ru: {
      question: "Это расход или доход?",
      options: [
        { label: "Расход", text: "потратил" },
        { label: "Доход", text: "получил" },
      ],
    },
  },
  ref: {
    de: {
      question: "Welchen Termin meinst du? Nenne mir den Titel.",
      options: [],
    },
    ru: {
      question: "Какую встречу ты имеешь в виду? Назови название.",
      options: [],
    },
  },
  note: {
    de: { question: "Was soll ich mir merken?", options: [] },
    ru: { question: "Что запомнить?", options: [] },
  },
  task: {
    de: { question: "Wie lautet die Aufgabe?", options: [] },
    ru: { question: "Какая задача?", options: [] },
  },
  query: {
    de: {
      question: "Wonach soll ich in deinen Unterlagen suchen?",
      options: [],
    },
    ru: { question: "Что найти в твоих материалах?", options: [] },
  },
} satisfies Record<
  string,
  Record<AssistantLocale, { question: string; options: ClarifyOption[] }>
>;

function clarify(
  key: keyof typeof CLARIFY,
  locale: AssistantLocale,
): AssistantPlan {
  const entry = CLARIFY[key][locale];

  return { type: "clarify", question: entry.question, options: entry.options };
}

function ambiguousHour(hour: number, minutes: number): AssistantPlan {
  const early = `${pad2(hour)}:${pad2(minutes)}`;
  const late = `${pad2(hour + 12)}:${pad2(minutes)}`;

  return {
    type: "clarify",
    question: `Meintest du ${early} oder ${late} Uhr?`,
    options: [
      { label: `${early} Uhr`, text: early },
      { label: `${late} Uhr`, text: late },
    ],
  };
}

function ambiguousHourRu(hour: number, minutes: number): AssistantPlan {
  const early = `${pad2(hour)}:${pad2(minutes)}`;
  const late = `${pad2(hour + 12)}:${pad2(minutes)}`;

  return {
    type: "clarify",
    question: `Во сколько: ${early} или ${late}?`,
    options: [
      { label: early, text: early },
      { label: late, text: late },
    ],
  };
}

const UNSUPPORTED = {
  de: "Das habe ich leider nicht verstanden. Versuche zum Beispiel: „Plane morgen um 15:30 ein Treffen mit Max“ oder „24,50 Euro bei Lidl für Lebensmittel ausgegeben“.",
  ru: "К сожалению, я не понял. Попробуй, например: «Создай встречу завтра в 15:30 с Максом» или «Потратил 500 рублей в Пятёрочке на продукты».",
} satisfies Record<AssistantLocale, string>;

// ------------------------------------------------------------------- parse

function detectLocale(text: string, fallback: AssistantLocale): AssistantLocale {
  return /[а-яё]/i.test(text) ? "ru" : fallback;
}

function tryFinanceCreate(
  lexer: Lexer,
  ctx: NluContext,
  locale: AssistantLocale,
): AssistantPlan | null {
  const lower = lexer.lower;

  const hasAmountFirst = /(\d+(?:[.,]\d{1,2})?)\s*(€|\$|₽|£|euro|eur\b|rubel|rur\b|руб|dollar|usd\b|pfund|gbp\b|chf\b|franken)/.test(
    lower,
  );
  const hasMerchant =
    locale === "ru" ? /\sв\s+[а-яё]/i.test(lower) : /\b(?:bei|im|in)\s+[a-zäöüß]/i.test(lower);

  // Finance needs a verb or a stated amount. A bare "bei/im/in"
  // phrase alone ("Treffen im Büro") is not finance.
  if (!FINANCE_VERB.test(lower) && !hasAmountFirst) {
    return null;
  }

  // Summary/list questions with a verb but no stated amount ("Wie viel
  // habe ich ausgegeben?") belong to the summary parser, not create.
  if (!hasAmountFirst && (FIN_SUMMARY_SIGNAL.test(lower) || FIN_LIST_SIGNAL.test(lower))) {
    return null;
  }

  const amount = extractAmount(lexer, locale);

  if (amount === null) {
    // "Ausgabe bei Lidl" without a number: ask for the amount rather
    // than inventing one — but only when finance is clearly intended.
    if (FINANCE_VERB.test(lower)) {
      return clarify("amount", locale);
    }

    return null;
  }

  const income = INCOME_SIGNAL.test(lower) && !EXPENSE_SIGNAL.test(lower);
  const expense = EXPENSE_SIGNAL.test(lower) && !INCOME_SIGNAL.test(lower);

  if (!income && !expense) {
    // Amount + merchant reads as an expense ("24 € bei Lidl"); a bare
    // amount stays ambiguous.
    if (!hasMerchant) {
      return clarify("direction", locale);
    }
  }

  const type: "income" | "expense" = income ? "income" : "expense";
  const merchant = extractMerchant(lexer, locale);
  const date = extractDate(lexer, ctx.todayISO, true);

  // Explicit "für <Kategorie>" / "на <категорию>" (first mappable).
  // No \b before Cyrillic: \b only sees ASCII word characters.
  let category: string | null = null;
  const forPattern =
    locale === "ru"
      ? /(?:^|\s)на\s+([а-яё]+)/g
      : /\bfür\s+([a-zäöüß]+)/g;
  let forMatch: RegExpExecArray | null;

  while ((forMatch = forPattern.exec(lower)) !== null) {
    const mapped = mapCategory(forMatch[1], type);

    if (mapped !== null && !lexer.isClaimed(forMatch.index, forMatch[0].length)) {
      lexer.claimMatch(forMatch);
      category = mapped;
      break;
    }

    if (forMatch[0].length === 0) break;
  }

  if (category === null) {
    const suggestion = suggestCategory(
      `${merchant ?? ""} ${lexer.remaining()}`.trim(),
      type,
    );

    category = suggestion.category;
  }

  const title = merchant ?? category;

  return {
    type: "finance.create",
    transaction: {
      title: title.slice(0, 200),
      amountCents: amount.amountCents,
      type,
      category,
      date: date?.date ?? ctx.todayISO,
      currency: amount.currency,
      note: "",
    },
  };
}

function tryCalendarDelete(
  lexer: Lexer,
  locale: AssistantLocale,
): AssistantPlan | null {
  if (!CAL_DELETE_VERB.test(lexer.lower)) return null;

  const ref = cleanRef(lexer.remaining(), locale);

  if (ref === "") {
    return clarify("ref", locale);
  }

  return { type: "calendar.delete", ref: { titleQuery: ref.slice(0, 200) } };
}

function tryCalendarUpdate(
  lexer: Lexer,
  ctx: NluContext,
  locale: AssistantLocale,
): AssistantPlan | null {
  if (!CAL_UPDATE_VERB.test(lexer.lower)) return null;

  // Split "… auf <neuer Zeitpunkt>": the tail carries date/time.
  const aufMatch = /\sauf\s+(.+)$/.exec(lexer.lower);

  if (aufMatch === null) {
    return clarify("date", locale);
  }

  const refLexer = new Lexer(lexer.raw.slice(0, aufMatch.index));
  const newLexer = new Lexer(aufMatch[1]);

  const ref = cleanRef(refLexer.remaining(), locale);

  if (ref === "") {
    return clarify("ref", locale);
  }

  const patch: EventPatch = {};
  const date = extractDate(newLexer, ctx.todayISO, false);

  if (date !== null) {
    patch.date = date.date;
  }

  const endRaw = extractEnd(newLexer);
  const time = extractTime(newLexer, locale);

  if (time !== null && time.kind === "ambiguous") {
    return locale === "ru"
      ? ambiguousHourRu(time.hour, time.minutes)
      : ambiguousHour(time.hour, time.minutes);
  }

  if (time !== null && time.kind === "time") {
    patch.start = time.start;

    if (endRaw !== null) {
      if ("end" in endRaw) {
        if (endRaw.end > time.start) {
          patch.end = endRaw.end;
        }
      } else {
        const [hours, minutes] = time.start.split(":").map(Number);
        patch.end = minutesToTime(
          hours * 60 + minutes + endRaw.durationMin,
        );
      }
    }
  }

  if (Object.keys(patch).length === 0) {
    return clarify("date", locale);
  }

  return {
    type: "calendar.update",
    ref: { titleQuery: ref.slice(0, 200) },
    patch,
  };
}

function tryCalendarCreate(
  lexer: Lexer,
  ctx: NluContext,
  locale: AssistantLocale,
): AssistantPlan | null {
  const lower = lexer.lower;
  const triggered = CAL_CREATE_VERB.test(lower);

  if (!triggered) {
    // No trigger verb: only treat as a booking when a date, a time and
    // a title are all present — and it is not a question or a
    // finance/budget statement.
    if (STRONG_LIST_SIGNAL.test(lower)) return null;
    if (FINANCE_VERB.test(lower) || FIN_SUMMARY_SIGNAL.test(lower)) {
      return null;
    }
  }

  const date = extractDate(lexer, ctx.todayISO, false);
  const endRaw = extractEnd(lexer);
  const time = extractTime(lexer, locale);

  if (!triggered && (date === null || time === null)) {
    return null;
  }

  if (date === null) {
    return clarify("date", locale);
  }

  if (time === null) {
    return clarify("time", locale);
  }

  if (time.kind === "ambiguous") {
    return locale === "ru"
      ? ambiguousHourRu(time.hour, time.minutes)
      : ambiguousHour(time.hour, time.minutes);
  }

  const [hours, minutes] = time.start.split(":").map(Number);
  const startMin = hours * 60 + minutes;
  let endTime = minutesToTime(startMin + 60);

  if (endRaw !== null) {
    if ("end" in endRaw) {
      if (endRaw.end > time.start) {
        endTime = endRaw.end;
      }
    } else {
      endTime = minutesToTime(startMin + endRaw.durationMin);
    }
  }

  // Claim the trigger verb so it does not leak into the title.
  const triggerMatch =
    /(plane|plan|erstelle\w*|trag(?:e|st)?\s+ein|mach(?:e|st)?\s+|setze|lege?\s+an|vereinbar\w*|hinzu\w*|anlegen|neuer?\s+termin|создай|создать|добавь|добавить|запланируй\w*|новая?\s+встреча)/.exec(
      lower,
    );

  if (triggerMatch !== null) {
    lexer.claimMatch(triggerMatch);
  }

  const rawTitle = cleanTitle(lexer.remaining());

  if (rawTitle === "") {
    return clarify("title", locale);
  }

  const { title, location } = splitLocation(rawTitle, locale);

  if (title === "") {
    return clarify("title", locale);
  }

  return {
    type: "calendar.create",
    event: {
      title: title.slice(0, 200),
      date: date.date,
      start: time.start,
      end: endTime,
      type: detectEventType(lower),
      description: "",
      location: location.slice(0, 200),
    },
  };
}

function tryCalendarList(
  lexer: Lexer,
  ctx: NluContext,
  locale: AssistantLocale,
): AssistantPlan | null {
  const lower = lexer.lower;

  if (!CAL_LIST_SIGNAL.test(lower)) return null;
  if (!/termin|treffen|meeting|kalender|vorlesung|prüfung|woche|heute|morgen|tag|встреч|совещан|расписание|сегодня|завтра|недел|день/.test(lower)) {
    return null;
  }

  // Week ranges.
  if (/nächste\s+woche|naechste\s+woche|следующ(?:ая|ую)\s+недел/.test(lower)) {
    const monday = addDaysISO(mondayOfISO(ctx.todayISO), 7);

    return {
      type: "calendar.list",
      from: monday,
      to: addDaysISO(monday, 6),
      label: locale === "ru" ? "следующая неделя" : "nächste Woche",
    };
  }

  if (/diese\s+woche|diesen\s+woche|эта\s+недел|на\s+этой\s+неделе/.test(lower)) {
    const monday = mondayOfISO(ctx.todayISO);

    return {
      type: "calendar.list",
      from: monday,
      to: addDaysISO(monday, 6),
      label: locale === "ru" ? "эта неделя" : "diese Woche",
    };
  }

  if (/wochenende|выходн/.test(lower)) {
    const monday = mondayOfISO(ctx.todayISO);

    return {
      type: "calendar.list",
      from: addDaysISO(monday, 5),
      to: addDaysISO(monday, 6),
      label: locale === "ru" ? "выходные" : "Wochenende",
    };
  }

  const date = extractDate(lexer, ctx.todayISO, false);

  if (date !== null) {
    return {
      type: "calendar.list",
      from: date.date,
      to: date.date,
      label: date.date,
    };
  }

  return {
    type: "calendar.list",
    from: ctx.todayISO,
    to: addDaysISO(ctx.todayISO, 7),
    label: locale === "ru" ? "ближайшие 7 дней" : "nächste 7 Tage",
  };
}

function tryFinanceList(
  lexer: Lexer,
  locale: AssistantLocale,
): AssistantPlan | null {
  void locale;

  if (!FIN_LIST_SIGNAL.test(lexer.lower)) return null;

  const countMatch = /(?:letzte\w*|last)\s+(\d{1,2})/.exec(lexer.lower);
  const countRuMatch = /последние\s+(\d{1,2})/.exec(lexer.lower);
  const count = countMatch?.[1] ?? countRuMatch?.[1];
  const limit =
    count === undefined
      ? 10
      : Math.max(1, Math.min(25, Number(count)));

  return { type: "finance.list", limit };
}

function tryFinanceSummary(
  lexer: Lexer,
  ctx: NluContext,
  locale: AssistantLocale,
): AssistantPlan | null {
  const lower = lexer.lower;

  if (!FIN_SUMMARY_SIGNAL.test(lower)) return null;
  if (
    !/ausgab|ausgeg|einnahm|bilanz|übersicht|kosten|расход|трат|доход|баланс|итог/.test(
      lower,
    )
  ) {
    return null;
  }

  const year = Number(ctx.todayISO.slice(0, 4));
  const month = Number(ctx.todayISO.slice(5, 7));

  // Relative months/weeks.
  if (/diesen\s+monat|dieses\s+monat|diesen\s+monat|im\s+laufenden\s+monat|в\s+этом\s+месяце|за\s+этот\s+месяц/.test(lower)) {
    const monthKey = `${year}-${pad2(month)}`;

    return {
      type: "finance.summary",
      monthKey,
      from: null,
      to: null,
      category: null,
      label: locale === "ru" ? "этот месяц" : "dieser Monat",
    };
  }

  if (/letzten\s+monat|letzte\s+monat|в\s+прошлом\s+месяце|за\s+прошлый\s+месяц/.test(lower)) {
    const first = new Date(Date.UTC(year, month - 2, 1));
    const monthKey = `${first.getUTCFullYear()}-${pad2(first.getUTCMonth() + 1)}`;

    return {
      type: "finance.summary",
      monthKey,
      from: null,
      to: null,
      category: null,
      label: locale === "ru" ? "прошлый месяц" : "letzter Monat",
    };
  }

  if (/diese\s+woche|на\s+этой\s+неделе|за\s+эту\s+неделю/.test(lower)) {
    const monday = mondayOfISO(ctx.todayISO);

    return {
      type: "finance.summary",
      monthKey: null,
      from: monday,
      to: addDaysISO(monday, 6),
      category: null,
      label: locale === "ru" ? "эта неделя" : "diese Woche",
    };
  }

  if (/letzte\s+woche|на\s+прошлой\s+неделе|за\s+прошлую\s+неделю/.test(lower)) {
    const monday = addDaysISO(mondayOfISO(ctx.todayISO), -7);

    return {
      type: "finance.summary",
      monthKey: null,
      from: monday,
      to: addDaysISO(monday, 6),
      category: null,
      label: locale === "ru" ? "прошлая неделя" : "letzte Woche",
    };
  }

  // Named month ("im Mai", "за май"): most recent past occurrence.
  const namedMonth =
    /(?:im|in|für|за|в)\s+([a-zäöüßа-яё]+)/.exec(lower);

  if (namedMonth !== null) {
    const target = MONTH_DE[namedMonth[1]] ?? MONTH_RU[namedMonth[1]] ?? null;

    if (target !== null) {
      const resolvedYear = target > month ? year - 1 : year;
      const monthKey = `${resolvedYear}-${pad2(target)}`;

      return {
        type: "finance.summary",
        monthKey,
        from: null,
        to: null,
        category: null,
        label: namedMonth[1],
      };
    }
  }

  // Category-scoped current month ("für Lebensmittel").
  const forPattern =
    locale === "ru"
      ? /(?:^|\s)на\s+([а-яё]+)/g
      : /\bfür\s+([a-zäöüß]+)/g;
  let forMatch: RegExpExecArray | null;

  while ((forMatch = forPattern.exec(lower)) !== null) {
    const mapped =
      mapCategory(forMatch[1], "expense") ?? mapCategory(forMatch[1], "income");

    if (mapped !== null) {
      const monthKey = `${year}-${pad2(month)}`;

      return {
        type: "finance.summary",
        monthKey: null,
        from: `${monthKey}-01`,
        to: endOfMonth(monthKey),
        category: mapped,
        label: `${mapped} · ${locale === "ru" ? "этот месяц" : "dieser Monat"}`,
      };
    }

    if (forMatch[0].length === 0) break;
  }

  // Default: current month.
  const monthKey = `${year}-${pad2(month)}`;

  return {
    type: "finance.summary",
    monthKey,
    from: null,
    to: null,
    category: null,
    label: locale === "ru" ? "этот месяц" : "dieser Monat",
  };
}

function endOfMonth(monthKey: string): string {
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0));

  return last.toISOString().slice(0, 10);
}

// ------------------------------------------------- memory + task writes

const MEMORY_CREATE_SIGNAL =
  /merk(e)?\s+dir|speicher(e)?(\s+dir)?|notier(e)?|behalt(e)?(\s+dir)?|запомни|сохрани/;

const MEMORY_QUESTION_GUARD =
  /^(was|welche|wen|hast\s+du)|hast\s+du|^(что|какие|кого)/;

function memoryCategoryOf(lower: string): string {
  if (/studium|lern|uni\b|prüfung|klausur|уч[её]б|экзамен/.test(lower)) {
    return "study";
  }

  if (/geld|finanz|ausgab|budget|финанс|денег|бюджет/.test(lower)) {
    return "finance";
  }

  if (/freizeit|urlaub|reise|hobby|отдых|путешеств|хобби/.test(lower)) {
    return "lifestyle";
  }

  if (/ziel|vorsatz|wunsch|план|цель|желание/.test(lower)) return "goals";
  if (/mag|liebe|vorliebe|präferenz|нравится|люблю/.test(lower)) {
    return "preferences";
  }

  return "assistant";
}

function tryMemoryCreate(
  lexer: Lexer,
  locale: AssistantLocale,
): AssistantPlan | null {
  const lower = lexer.lower;

  if (!MEMORY_CREATE_SIGNAL.test(lower)) return null;
  if (MEMORY_QUESTION_GUARD.test(lower)) return null;

  const trigger = /(merk(e)?\s+dir|speicher(e)?(\s+dir)?|notier(e)?|behalt(e)?(\s+dir)?|запомни|сохрани)\s*/.exec(lower);

  if (trigger !== null) lexer.claimMatch(trigger);

  const content = lexer
    .remaining()
    .replace(/^[,.:;\-–—„“"'\s]+/, "")
    .trim();

  if (content === "") return clarify("note", locale);

  const firstSentence = content.split(/[.!?;]/)[0].trim();
  const title = (firstSentence === "" ? content : firstSentence).slice(0, 120);

  if (title === "") return clarify("note", locale);

  return {
    type: "memory.create",
    entry: {
      category: memoryCategoryOf(lower),
      title,
      content: content.slice(0, 2000),
    },
  };
}

const TASK_NOUN = /aufgabe|todo|задач/;

const TASK_CREATE_SIGNAL =
  /erstell|neu(e|er|es)?\s|mach\w*\s|füg\w*\s+(hinzu|an)|hinzufüg|hinzu|anleg|trag\w*\s+ein|erinner\w*\s+mich|todo\s*:|aufgabe\s*:|создай|создать|добавь|добавить|нов(ая|ую|ой)|напомни/;

function tryTasksCreate(
  lexer: Lexer,
  locale: AssistantLocale,
): AssistantPlan | null {
  const lower = lexer.lower;

  if (!TASK_NOUN.test(lower) && !/erinner\w*\s+mich|напомни/.test(lower)) {
    return null;
  }

  if (!TASK_CREATE_SIGNAL.test(lower)) return null;

  const priority: "Niedrig" | "Mittel" | "Hoch" =
    /dringend|wichtig|priorit(ä|a)t\s+hoch|hochprior|sofort|срочн|важн/.test(lower)
      ? "Hoch"
      : /niedrig|unwichtig|später|low|не\s*важн|низк/.test(lower)
        ? "Niedrig"
        : "Mittel";

  const timeMatch = /um\s+(\d{1,2}):(\d{2})/.exec(lower);

  if (timeMatch !== null) lexer.claimMatch(timeMatch);

  // Priority words describe the task; they must not leak into its title.
  const priorityMatch =
    /(dringend|wichtig|priorit(ä|a)t\s+hoch|hochprior|sofort|niedrig|unwichtig|später|low|срочн|важн|не\s*важн|низк)/g;
  let priorityHit: RegExpExecArray | null;

  while ((priorityHit = priorityMatch.exec(lower)) !== null) {
    lexer.claimMatch(priorityHit);

    if (priorityHit[0].length === 0) break;
  }

  const trigger =
    /(erstell\w*|neue?\s+aufgabe|neue?\s+todo|neues?\s+todo|mach\w*|füg\w*\s+(hinzu|an)|hinzufüg\w*|hinzu|anleg\w*|trag\w*\s+ein|erinner\w*\s+mich|aufgabe|todo|создай|создать|добавь|добавить|нов(ая|ую|ой)\s+(задача|задачу)|задача|задачу|напомни)\s*/g;
  let triggerMatch: RegExpExecArray | null;

  while ((triggerMatch = trigger.exec(lower)) !== null) {
    lexer.claimMatch(triggerMatch);

    if (triggerMatch[0].length === 0) break;
  }

  const title = cleanTitle(lexer.remaining()).replace(/^:\s*/, "");

  if (title === "") return clarify("task", locale);

  return {
    type: "tasks.create",
    task: {
      title: title.slice(0, 200),
      time: timeMatch !== null ? `${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}` : "Keine Frist",
      priority,
    },
  };
}

// ------------------------------------------------------------ read intents

const BRIEFING_SIGNAL =
  /tagesbriefing|tagesübersicht|tagesuebersicht|tageszusammenfassung|tagesüberblick|was steht (heute |)an|mein tag|tagesstart|дайджест|что (у меня )?сегодня|мой день|что запланировано/;

function tryBriefing(lexer: Lexer): AssistantPlan | null {
  if (!BRIEFING_SIGNAL.test(lexer.lower)) return null;

  return { type: "briefing.today" };
}

const TASKS_OPEN_SIGNAL =
  /offen\w*\s+(aufgaben|todos)|meine\s+(aufgaben|todos)|aufgabenliste|aufgabenübersicht|alle\s+aufgaben|zeige.*aufgaben|aufgaben\s+(zeigen|anzeigen|auflisten)|was.*aufgaben|habe\s+ich.*aufgaben|открытые\s+задачи|мои\s+задачи|список\s+задач|какие\s+задачи|покажи.*задачи/;

function tryTasksOpen(lexer: Lexer): AssistantPlan | null {
  if (!TASKS_OPEN_SIGNAL.test(lexer.lower)) return null;

  return { type: "tasks.open" };
}

const STUDY_NOUN =
  /prüfung|klausur|examen|studium|lern|thema|themen|fach\b|fächer|vorlesung|uni\b|frist|abgabe|deadline|экзамен|уч[её]б|тем[аы]|предмет|лекци|дедлайн/;

function tryStudyRead(
  lexer: Lexer,
  locale: AssistantLocale,
): AssistantPlan | null {
  void locale;
  const lower = lexer.lower;

  if (!STUDY_NOUN.test(lower)) return null;

  if (/fortschritt|lernstand|прогресс|успеваем/.test(lower)) {
    return { type: "study.progress" };
  }

  if (
    /offene.*themen|themen.*offen|anstehend|открытые\s+темы|ближайшие\s+экзамены/.test(lower)
  ) {
    const daysMatch = /(\d{1,2})\s*(tagen|дн)/.exec(lower);
    const withinDays =
      daysMatch === null
        ? undefined
        : Math.max(0, Math.min(90, Number(daysMatch[1])));

    return withinDays === undefined
      ? { type: "study.attention" }
      : { type: "study.attention", withinDays };
  }

  if (/prüfung|klausur|frist|examen|экзамен|дедлайн|срок/.test(lower)) {
    return { type: "study.deadlines" };
  }

  // Bare study nouns answer only to list signals ("Themen" alone is
  // not a question).
  if (
    /\?|zeig|liste|was\s|welche|übersicht|покажи|какие|что\s|список/.test(lower)
  ) {
    return { type: "study.progress" };
  }

  return null;
}

/**
 * Shared intent detection (see `@/src/lib/lifestyle/intent`): the
 * assistant detects the same categories as the live-search UI.
 * Broad/ambiguous input yields no category arg (the search stays
 * broad) — never a forced `nature`.
 */
function placeCategoryOf(lower: string): string | undefined {
  const detected = detectPlaceCategory(lower);

  return detected === "all" ? undefined : detected;
}

function tryLifestyleRead(
  lexer: Lexer,
  locale: AssistantLocale,
): AssistantPlan | null {
  const lower = lexer.lower;

  if (
    /gemerkt\w*\s+(orte|plätze)|gespeichert\w*\s+(orte|plätze)|meine\s+(orte|plätze)|сохран[её]нные\s+места|мои\s+места/.test(lower)
  ) {
    return { type: "lifestyle.saved" };
  }

  if (/ausflüge?|ausflugspläne?|поездки|путешествия/.test(lower)) {
    return { type: "lifestyle.upcomingPlans" };
  }

  if (/vorlieben|präferenzen|предпочтения/.test(lower)) {
    return { type: "lifestyle.preferences" };
  }

  const placeNoun =
    /restaurant|caf[eé]|kinoabend|kino|film|museum|theater|konzert|park|spazier|wander|ausflug|ausflüg|freizeit|wochenende|hotel|pension|sehenswürdig|kneipe|fitness|\bgyms?\b|veranstaltung|\bevents?\b|einkauf|shopping|strand|\bbar\b|orte|plätze?|мест|ресторан|кафе|кино|музей|театр|парк|отел|достопримечател|фитнес|спортзал|поесть|погулять|куда\s+сходить|выходн|мероприяти/.test(lower);

  if (!placeNoun) return null;

  const searchVerb =
    /such|finde|empfehl|zeig|gibt es|gib mir|wo\b|in der nähe|in meiner nähe|buch|reservier|wochenende|weekend|ideen?|vorschl[äa]ge?|unternehmen|was\s+(kann|gibt|tun|machen)|was\s+ist\s+los|geht\s+was|\bheute\b|\bmorgen\b|(?:^|\s)(?:in|bei|nahe)\s+[a-zäöüß]|найди|где|посоветуй|покажи|сегодня|завтра|выходн|\?/.test(lower);

  if (!searchVerb) return null;

  const raw = lexer.raw;
  let near: string | undefined;

  if (locale === "ru") {
    // (^|\s), not \b: \b only sees ASCII word characters.
    const nearMatch = /(?:^|\s)(?:в|во|около)\s+([А-ЯЁ][\wа-яё\-]{1,40})/.exec(raw);

    if (nearMatch !== null) {
      near = nearMatch[1];
      lexer.claim(nearMatch.index, nearMatch.index + nearMatch[0].length);
    }
  } else {
    const nearMatch = /\b(?:in|bei|nahe)\s+([A-ZÄÖÜ][\wäöüß\-]{1,40})/.exec(raw);

    if (nearMatch !== null) {
      near = nearMatch[1];
      lexer.claim(nearMatch.index, nearMatch.index + nearMatch[0].length);
    }
  }

  const limitMatch = /(\d{1,2})\s*(treffer|vorschläge|optionen|ergebnisse|вариант|мест)/.exec(lower);
  const limit =
    limitMatch === null
      ? undefined
      : Math.max(1, Math.min(10, Number(limitMatch[1])));

  if (limitMatch !== null) lexer.claimMatch(limitMatch);

  const trigger =
    /(such\w*|finde\w*|empfehl\w*|zeig\w*|gibt es|gib mir|in meiner nähe|in der nähe|buch\w*|reservier\w*|was machen wir|was kann man|was gibt es|was ist los|geht was|wo ist|nächst\w*|\bheute\b|\bmorgen\b|orte|plätze?|найди|где|посоветуй|покажи|ближайш\w*|сегодня|завтра|мест[а-яё]*)\s*/g;
  let triggerMatch: RegExpExecArray | null;

  while ((triggerMatch = trigger.exec(lower)) !== null) {
    lexer.claimMatch(triggerMatch);

    if (triggerMatch[0].length === 0) break;
  }

  // Drop scaffolding words only when real content remains ("Kino am
  // Wochenende" → "Kino"; a bare "Wochenende" stays the query; glue
  // leftovers like "fürs" fall back to the original words).
  let query = cleanTitle(lexer.remaining()).slice(0, 200);
  const content = query
    .replace(
      /\b(wochenende|weekend|freizeit|ausflug|ausflüge|ideen?|vorschl[äa]ge?|unternehmen)\b/gi,
      " ",
    )
    // (^|\s), not \b: \b only sees ASCII word characters.
    .replace(/(^|\s)(выходн[а-яё]*|мероприяти[а-яё]*)(?=\s|$|[?!.,])/gi, "$1 ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(am|im|in|bei|nahe)\s+|\s+(am|im|in|bei|nahe)$/gi, "")
    .trim();
  const contentSansGlue = content
    .replace(
      /\b(fürs|für|mit|zum|zur|vom|von|beim|am|im|in|bei|nahe|und|oder|der|die|das|den|dem|des)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (contentSansGlue !== "") query = content;

  query = canonicalizeQuery(query);
  const category = placeCategoryOf(lower);
  const args: {
    query?: string;
    near?: string;
    category?: string;
    limit?: number;
  } = {};

  if (query !== "") args.query = query;
  if (near !== undefined) args.near = near;
  if (category !== undefined) args.category = category;
  if (limit !== undefined) args.limit = limit;

  return { type: "lifestyle.placesSearch", ...args };
}

const MEMORY_READ_SIGNAL =
  /was\s+weißt\s+du|was\s+hast\s+du\s+gespeichert|erinnerungen|notizen|was\s+ist\s+gespeichert|merkliste|zeige.*erinnerung|что\s+ты\s+(помнишь|знаешь)|напоминания|заметки/;

function tryMemoryRead(lexer: Lexer): AssistantPlan | null {
  if (!MEMORY_READ_SIGNAL.test(lexer.lower)) return null;

  return { type: "memory.approved" };
}

const STUDY_DOCS_SIGNAL =
  /welche\s+dokumente|dokumentenliste|dokumente\s+(zeigen|auflisten|anzeigen|liste)|alle\s+dokumente|hochgeladene|какие\s+документы|список\s+документ|мои\s+документы|загруженные/;

const STUDY_RETRIEVE_SIGNAL =
  /suche\s+in\s+(den\s+)?unterlagen|durchsuche|was\s+steht\s+in|finde\s+in|in\s+den\s+unterlagen|найди\s+в|поиск\s+по\s+документ|что\s+говорится\s+в/;

function tryStudyDocs(
  lexer: Lexer,
  locale: AssistantLocale,
): AssistantPlan | null {
  const lower = lexer.lower;

  if (STUDY_DOCS_SIGNAL.test(lower)) {
    return { type: "study.documents" };
  }

  if (!STUDY_RETRIEVE_SIGNAL.test(lower)) return null;

  const trigger =
    /(suche\s+in\s+(den\s+)?unterlagen|durchsuche\w*|was\s+steht\s+in|finde\s+in|in\s+den\s+unterlagen|найди\s+в|поиск\s+по\s+документ\w*|что\s+говорится\s+в)\s*/.exec(lower);

  if (trigger !== null) lexer.claimMatch(trigger);

  const query = cleanTitle(lexer.remaining())
    .replace(/^(nach|zu|über|ueber|für|von|про|о)\s+/i, "")
    .slice(0, 500);

  if (query === "") return clarify("query", locale);

  return { type: "study.retrieve", query };
}

function tryLecture(lexer: Lexer): AssistantPlan | null {
  const lower = lexer.lower;

  if (!/aufnahme|aufzeichnung|mitschnitt|vorlesungsaufzeichnung|запис/.test(lower)) {
    return null;
  }

  // Recording actions are not listing the library.
  if (/aufnehmen|nimm.*auf|starte|start|запиши/.test(lower)) return null;

  return { type: "lecture.overview" };
}

/**
 * Parse one command into a validated plan. Never throws for
 * unparseable input — that becomes `clarify` or `unsupported`.
 */
const GREETING_PREFIX =
  /^(?:guten\s+(?:morgen|tag|abend|nacht)|hallo|hi|hey|servus|moin|привет|добрый\s+(?:день|вечер)|доброе\s+утро)[,!\s]+/i;

export function parseCommand(text: string, ctx: NluContext): ParseResult {
  const source = text
    .trim()
    .replace(/\s+/g, " ")
    .replace(GREETING_PREFIX, "")
    .slice(0, 2000);

  if (source === "") {
    return {
      plan: {
        type: "unsupported",
        message:
          ctx.locale === "ru"
            ? "Пустая команда. Попробуй: «Создай встречу завтра в 15:30»."
            : "Leere Anfrage. Versuche zum Beispiel: „Plane morgen um 15:30 ein Treffen mit Max“.",
      },
      locale: ctx.locale,
    };
  }

  const locale = detectLocale(source, ctx.locale);

  const plan =
    tryMemoryCreate(new Lexer(source), locale) ??
    tryTasksCreate(new Lexer(source), locale) ??
    tryFinanceCreate(new Lexer(source), ctx, locale) ??
    tryCalendarDelete(new Lexer(source), locale) ??
    tryCalendarUpdate(new Lexer(source), ctx, locale) ??
    tryCalendarCreate(new Lexer(source), ctx, locale) ??
    tryBriefing(new Lexer(source)) ??
    tryCalendarList(new Lexer(source), ctx, locale) ??
    tryTasksOpen(new Lexer(source)) ??
    tryStudyRead(new Lexer(source), locale) ??
    tryFinanceList(new Lexer(source), locale) ??
    tryFinanceSummary(new Lexer(source), ctx, locale) ??
    tryLifestyleRead(new Lexer(source), locale) ??
    tryMemoryRead(new Lexer(source)) ??
    tryStudyDocs(new Lexer(source), locale) ??
    tryLecture(new Lexer(source));

  if (plan !== null) {
    return { plan, locale };
  }

  return { plan: { type: "unsupported", message: UNSUPPORTED[locale] }, locale };
}
