/**
 * Coverage-aware question generation: page/slide grouping, spread
 * window selection, coverage math, adaptive targets, and exact +
 * near-duplicate filtering.
 *
 * Pure and deterministic (no I/O, no randomness): the same chunks
 * plus the same covered labels always select the same window, so
 * both the cloud service and the local client path share it and
 * every behavior below is unit-testable.
 */

import { formatSourceRefs, type SourceRef } from "./extract";
import { filterNewQuestions } from "./questions";
import type { QuizQuestion } from "@/src/lib/quiz";

/** Groups per generation window (one batch covers few sections). */
export const DEFAULT_MAX_GROUPS = 4;
/** Window budget fallback when the caller passes no budget. */
export const DEFAULT_BUDGET_CHARS = 4000;
/** Groups thinner than this are skipped unless nothing else exists. */
export const DEFAULT_MIN_GROUP_CHARS = 120;
/** Widest label range ever expanded (pathological input guard). */
export const MAX_RANGE_WIDTH = 10_000;
/** Token-set Jaccard at or above this counts as a duplicate. */
export const NEAR_DUP_THRESHOLD = 0.85;

/** Minimal chunk shape both persistence paths can supply. */
export type CoverableChunk = {
  index: number;
  text: string;
  refs: SourceRef[];
};

/** One parsed label span, e.g. "Folien 5–24". */
export type ParsedCoverageUnit = {
  kind: "page" | "slide" | "paragraph" | "lines";
  from: number;
  to: number;
};

const LABEL_PATTERN =
  /^(Seite|Seiten|Folie|Folien|Absatz|Absätze|Zeile|Zeilen)\s+(\d+)(?:\s*[–—-]\s*(\d+))?$/;

function labelKind(word: string): ParsedCoverageUnit["kind"] | null {
  switch (word) {
    case "Seite":
    case "Seiten":
      return "page";
    case "Folie":
    case "Folien":
      return "slide";
    case "Absatz":
    case "Absätze":
      return "paragraph";
    case "Zeile":
    case "Zeilen":
      return "lines";
    default:
      return null;
  }
}

/**
 * Inverse of `formatSourceRefs`: stored question labels back to
 * unit spans. Unknown parts are ignored (coverage is derived and
 * must never break generation), ranges are width-capped.
 */
export function parseRefLabels(labels: string[]): ParsedCoverageUnit[] {
  const units: ParsedCoverageUnit[] = [];

  for (const label of labels) {
    for (const part of label.split(",")) {
      const match = LABEL_PATTERN.exec(part.trim());

      if (match === null) continue;

      const kind = labelKind(match[1] ?? "");

      if (kind === null) continue;

      const first = Number.parseInt(match[2] ?? "", 10);
      const second =
        match[3] === undefined ? first : Number.parseInt(match[3], 10);

      if (
        !Number.isInteger(first) ||
        !Number.isInteger(second) ||
        first < 1 ||
        second < 1
      ) {
        continue;
      }

      const from = Math.min(first, second);
      const to = Math.min(Math.max(first, second), from + MAX_RANGE_WIDTH);

      units.push({ kind, from, to });
    }
  }

  return units;
}

/** Consecutive chunks covering the same unit (usually one page). */
export type ChunkGroup = {
  key: string;
  label: string;
  units: ParsedCoverageUnit[];
  chunkIndices: number[];
  chars: number;
};

function refToUnit(ref: SourceRef): ParsedCoverageUnit {
  switch (ref.kind) {
    case "page":
      return { kind: "page", from: ref.page, to: ref.page };
    case "slide":
      return { kind: "slide", from: ref.slide, to: ref.slide };
    case "paragraph":
      return { kind: "paragraph", from: ref.paragraph, to: ref.paragraph };
    case "lines":
      return { kind: "lines", from: ref.start, to: ref.end };
  }
}

function chunkKey(refs: SourceRef[]): string | null {
  const first = refs[0];

  if (first === undefined) return null;

  const unit = refToUnit(first);

  return unit.kind === "lines"
    ? `lines:${unit.from}-${unit.to}`
    : `${unit.kind}:${unit.from}`;
}

function pushUnit(units: ParsedCoverageUnit[], unit: ParsedCoverageUnit): void {
  const last = units[units.length - 1];

  if (
    last !== undefined &&
    last.kind === unit.kind &&
    unit.from <= last.to + 1 &&
    unit.from >= last.from
  ) {
    last.to = Math.max(last.to, unit.to);

    return;
  }

  units.push({ ...unit });
}

/**
 * Ordered chunk groups: consecutive chunks starting at the same
 * unit merge (dense pages), sparse multi-slide chunks keep their
 * range label, chunks without refs stay selectable singletons.
 */
/** Merged units back to a display label ("Seite 1", "Folien 1–3"). */
function unitsLabel(units: ParsedCoverageUnit[]): string {
  const refs: SourceRef[] = [];

  for (const unit of units) {
    if (unit.kind === "lines") {
      refs.push({ kind: "lines", start: unit.from, end: unit.to });
      continue;
    }

    for (let n = unit.from; n <= unit.to; n += 1) {
      if (unit.kind === "page") refs.push({ kind: "page", page: n });
      if (unit.kind === "slide") refs.push({ kind: "slide", slide: n });
      if (unit.kind === "paragraph") {
        refs.push({ kind: "paragraph", paragraph: n });
      }
    }
  }

  return formatSourceRefs(refs);
}

export function groupChunksByUnit(chunks: CoverableChunk[]): ChunkGroup[] {
  const groups: ChunkGroup[] = [];

  for (const chunk of chunks) {
    const key = chunkKey(chunk.refs);
    const current = groups[groups.length - 1];

    if (key !== null && current !== undefined && current.key === key) {
      current.chunkIndices.push(chunk.index);
      current.chars += chunk.text.length;

      for (const ref of chunk.refs) pushUnit(current.units, refToUnit(ref));

      current.label = unitsLabel(current.units);

      continue;
    }

    const units: ParsedCoverageUnit[] = [];

    for (const ref of chunk.refs) pushUnit(units, refToUnit(ref));

    groups.push({
      key: key ?? `chunk:${chunk.index}`,
      label: key === null ? `Textabschnitt ${chunk.index + 1}` : unitsLabel(units),
      units,
      chunkIndices: [chunk.index],
      chars: chunk.text.length,
    });
  }

  return groups;
}

export function spansOverlap(
  unit: ParsedCoverageUnit,
  cited: ParsedCoverageUnit,
): boolean {
  return (
    unit.kind === cited.kind &&
    unit.from <= cited.to &&
    cited.from <= unit.to
  );
}

/**
 * Parallel to `groups`: true when any stored label overlaps any
 * group unit (exact pages, merged ranges, overlapping line spans).
 */
export function markCoveredGroups(
  groups: ChunkGroup[],
  labels: string[],
): boolean[] {
  const cited = parseRefLabels(labels);

  return groups.map((group) =>
    group.units.some((unit) =>
      cited.some((span) => spansOverlap(unit, span)),
    ),
  );
}

export type CoverageStats = {
  usableUnits: number;
  coveredUnits: number;
  percent: number;
  groupCount: number;
  coveredGroups: number;
};

/**
 * Distinct usable units (cited-but-missing pages never inflate
 * the count) and how many stored labels cover. Empty input is
 * honestly 0 %, never 100 %.
 */
export function coverageStats(
  groups: ChunkGroup[],
  labels: string[],
): CoverageStats {
  const cited = parseRefLabels(labels);
  const usablePoints = new Set<string>();
  const usableRanges: ParsedCoverageUnit[] = [];
  const seenRanges = new Set<string>();

  for (const group of groups) {
    for (const unit of group.units) {
      if (unit.kind === "lines") {
        const key = `lines:${unit.from}-${unit.to}`;

        if (!seenRanges.has(key)) {
          seenRanges.add(key);
          usableRanges.push(unit);
        }

        continue;
      }

      for (let n = unit.from; n <= unit.to; n += 1) {
        usablePoints.add(`${unit.kind}:${n}`);
      }
    }
  }

  const coveredPoints = new Set<string>();

  for (const span of cited) {
    if (span.kind === "lines") continue;

    for (let n = span.from; n <= span.to; n += 1) {
      const key = `${span.kind}:${n}`;

      if (usablePoints.has(key)) coveredPoints.add(key);
    }
  }

  let coveredRanges = 0;

  for (const range of usableRanges) {
    if (cited.some((span) => spansOverlap(range, span))) {
      coveredRanges += 1;
    }
  }

  const usableUnits = usablePoints.size + usableRanges.length;
  const coveredUnits = coveredPoints.size + coveredRanges;
  const covered = markCoveredGroups(groups, labels);

  return {
    usableUnits,
    coveredUnits,
    percent:
      usableUnits === 0
        ? 0
        : Math.round((coveredUnits / usableUnits) * 100),
    groupCount: groups.length,
    coveredGroups: covered.filter(Boolean).length,
  };
}

export type WindowOptions = {
  maxGroups?: number;
  budgetChars?: number;
  minGroupChars?: number;
};

export type SelectedWindow = {
  groups: ChunkGroup[];
  chunkIndices: number[];
  truncated: boolean;
  poolSize: number;
};

/**
 * Deterministic spread window: uncovered groups first (stable
 * document order), evenly spaced picks, then a char-budget fit
 * that always keeps the first pick. Thin groups are skipped
 * unless that would empty the pool; a fully covered document
 * spreads over everything and lets dedup decide.
 */
export function selectWindow(
  groups: ChunkGroup[],
  covered: boolean[],
  opts: WindowOptions,
): SelectedWindow {
  const maxGroups =
    Number.isInteger(opts.maxGroups) && (opts.maxGroups ?? 0) > 0
      ? (opts.maxGroups as number)
      : DEFAULT_MAX_GROUPS;
  const budgetChars =
    Number.isInteger(opts.budgetChars) && (opts.budgetChars ?? 0) > 0
      ? (opts.budgetChars as number)
      : DEFAULT_BUDGET_CHARS;
  const minGroupChars =
    Number.isInteger(opts.minGroupChars) && (opts.minGroupChars ?? 0) > 0
      ? (opts.minGroupChars as number)
      : DEFAULT_MIN_GROUP_CHARS;

  const order = groups.map((_, index) => index);
  const uncovered = order.filter((index) => covered[index] !== true);
  const substantial = uncovered.filter(
    (index) => (groups[index]?.chars ?? 0) >= minGroupChars,
  );
  const pool =
    substantial.length > 0
      ? substantial
      : uncovered.length > 0
        ? uncovered
        : order;

  const count = Math.min(maxGroups, pool.length);

  if (count === 0) {
    return { groups: [], chunkIndices: [], truncated: false, poolSize: 0 };
  }

  const picks =
    count === 1
      ? [pool[0] as number]
      : Array.from(
          { length: count },
          (_, i) =>
            pool[
              Math.round((i * (pool.length - 1)) / (count - 1))
            ] as number,
        );
  const selected: ChunkGroup[] = [];
  let used = 0;

  for (const index of [...picks].sort((a, b) => a - b)) {
    const group = groups[index];

    if (group === undefined) continue;

    if (used + group.chars > budgetChars && selected.length > 0) break;

    selected.push(group);
    used += group.chars;
  }

  return {
    groups: selected,
    chunkIndices: selected
      .flatMap((group) => group.chunkIndices)
      .sort((a, b) => a - b),
    truncated: selected.length < pool.length,
    poolSize: pool.length,
  };
}

/**
 * Adaptive target: ~1 question per 2.5 usable units
 * (20→8, 50→20, 200→80, 300→120), min 4, max 150, 0 when
 * there is nothing usable at all.
 */
export function targetQuestionCount(usableUnits: number): number {
  if (!Number.isInteger(usableUnits) || usableUnits <= 0) return 0;

  return Math.min(150, Math.max(4, Math.round(usableUnits / 2.5)));
}

/**
 * Groups per generation call: at least 2 (a window of one is a
 * point, not a spread), at most the default cap, scaling with
 * the requested question count in between.
 */
export function maxGroupsForCount(count: number): number {
  const safe =
    Number.isInteger(count) && count > 0 ? count : DEFAULT_MAX_GROUPS;

  return Math.min(DEFAULT_MAX_GROUPS, Math.max(2, safe));
}

/** One chunk plus its caller-owned payload (row, stored chunk). */
export type WindowEntry<T> = CoverableChunk & { payload: T };

export type WindowSelection<T> = {
  /** Window entries in document order. */
  picked: WindowEntry<T>[];
  /** Group labels, e.g. ["Folie 1", "Folien 101–105"]. */
  labels: string[];
  poolSize: number;
  truncated: boolean;
  coverage: CoverageStats;
};

/**
 * Shared window selection for the cloud service and the local
 * client path (parity by construction): group, mark covered,
 * spread-pick within budget. Entries must arrive in document
 * order; coverage reflects the passed labels (pre-batch state).
 */
export function selectQuestionWindow<T>(
  entries: WindowEntry<T>[],
  coveredRefs: string[],
  count: number,
  budgetChars: number,
): WindowSelection<T> {
  const groups = groupChunksByUnit(entries);
  const covered = markCoveredGroups(groups, coveredRefs);
  const window = selectWindow(groups, covered, {
    maxGroups: maxGroupsForCount(count),
    budgetChars,
  });
  const picked = new Set(window.chunkIndices);
  const coverage = coverageStats(groups, coveredRefs);

  return {
    picked: entries.filter((entry) => picked.has(entry.index)),
    labels: window.groups.map((group) => group.label),
    poolSize: window.poolSize,
    truncated: window.truncated,
    coverage,
  };
}

// ------------------------------------------------------------ sweep plan

/** Source chars per summary span (one model call). */
export const SUMMARY_SPAN_BUDGET_CHARS = 4000;

/** One contiguous summary span (stable key across replans). */
export type SummarySpan = {
  key: string;
  label: string;
  units: ParsedCoverageUnit[];
  chunkIndices: number[];
  chars: number;
};

function spanKey(units: ParsedCoverageUnit[]): string {
  const first = units[0];

  if (first === undefined) return "empty:0";

  let min = first.from;
  let max = first.to;

  for (const unit of units) {
    if (unit.kind !== first.kind) {
      return `${first.kind}:${min}-${max}+${units.length}`;
    }

    min = Math.min(min, unit.from);
    max = Math.max(max, unit.to);
  }

  return min === max ? `${first.kind}:${min}` : `${first.kind}:${min}-${max}`;
}

/** Bit-reversal rank: recursive-halving distributed order. */
function bitReverse(value: number, bits: number): number {
  let reversed = 0;

  for (let bit = 0; bit < bits; bit += 1) {
    reversed = (reversed << 1) | ((value >> bit) & 1);
  }

  return reversed;
}

/**
 * Full-coverage sweep plan: contiguous groups accumulate into
 * spans (logical reading order inside each span), then spans run
 * in bit-reversal order so the first batches already spread over
 * the whole document. Unlike the question window (a sample), the
 * sweep covers every usable unit exactly once. Deterministic.
 */
export function planSummarySweep(
  groups: ChunkGroup[],
  budgetChars: number = SUMMARY_SPAN_BUDGET_CHARS,
): SummarySpan[] {
  const budget =
    Number.isInteger(budgetChars) && budgetChars > 0
      ? budgetChars
      : SUMMARY_SPAN_BUDGET_CHARS;
  const ordered: SummarySpan[] = [];
  let current: SummarySpan | null = null;
  let used = 0;

  for (const group of groups) {
    if (
      current !== null &&
      used + group.chars > budget &&
      current.chunkIndices.length > 0
    ) {
      current.key = spanKey(current.units);
      current.label = unitsLabel(current.units);
      ordered.push(current);
      current = null;
      used = 0;
    }

    if (current === null) {
      current = { key: "", label: "", units: [], chunkIndices: [], chars: 0 };
    }

    for (const unit of group.units) pushUnit(current.units, { ...unit });

    current.chunkIndices.push(...group.chunkIndices);
    current.chars += group.chars;
    used += group.chars;
  }

  if (current !== null && current.chunkIndices.length > 0) {
    current.key = spanKey(current.units);
    current.label = unitsLabel(current.units);
    ordered.push(current);
  }

  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(ordered.length, 1))));

  // Fixed-width bit-reversal is a bijection: ranks never tie.
  return ordered
    .map((span, index) => ({ span, rank: bitReverse(index, bits) }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.span);
}

/** Lowercased letter/digit tokens (punctuation stripped). */
export function questionTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== "");
}

/** Token-set Jaccard similarity in [0, 1]. */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(questionTokens(a));
  const setB = new Set(questionTokens(b));
  const union = new Set([...setA, ...setB]);

  if (union.size === 0) return 1;

  let shared = 0;

  for (const token of setA) {
    if (setB.has(token)) shared += 1;
  }

  return shared / union.size;
}

/** True when the pair is at least `threshold` similar. */
export function isNearDuplicate(
  a: string,
  b: string,
  threshold: number = NEAR_DUP_THRESHOLD,
): boolean {
  return jaccardSimilarity(a, b) >= threshold;
}

export type FreshQuestions = {
  fresh: QuizQuestion[];
  skipped: number;
  skippedExact: number;
  skippedNear: number;
};

/**
 * Exact dedup first (shared `filterNewQuestions` semantics:
 * normalized text scoped per document), then a near-duplicate
 * pass over survivors against existing plus accepted-batch
 * questions — still scoped per document, because identical text
 * from another document cites different material.
 */
export function filterFreshQuestions(
  existing: QuizQuestion[],
  candidates: QuizQuestion[],
  opts: { threshold?: number } = {},
): FreshQuestions {
  const { fresh: exactFresh, skipped: skippedExact } = filterNewQuestions(
    existing,
    candidates,
  );
  const threshold =
    typeof opts.threshold === "number" &&
    opts.threshold >= 0 &&
    opts.threshold <= 1
      ? opts.threshold
      : NEAR_DUP_THRESHOLD;
  const fresh: QuizQuestion[] = [];
  const pool: QuizQuestion[] = [...existing];
  let skippedNear = 0;

  for (const candidate of exactFresh) {
    const documentId = candidate.documentId ?? "";
    const duplicate = pool.some(
      (item) =>
        (item.documentId ?? "") === documentId &&
        isNearDuplicate(item.question, candidate.question, threshold),
    );

    if (duplicate) {
      skippedNear += 1;
      continue;
    }

    pool.push(candidate);
    fresh.push(candidate);
  }

  return { fresh, skipped: skippedExact + skippedNear, skippedExact, skippedNear };
}
