/**
 * Document-wide summarization core: marker-to-label resolution,
 * synthesis ordering/reduction/validation, and the resumable
 * sweep orchestrator. Framework-free and store-agnostic — the
 * cloud service, the local path, and tests share it.
 *
 * Trust rule: the persisted draft (per generation_id) is the only
 * resume truth. Callers never supply completed spans; the store
 * decides what is done, so stale or foreign state cannot skip
 * content or fabricate progress.
 */

import {
  parseRefLabels,
  spansOverlap,
  type ParsedCoverageUnit,
} from "@/src/lib/study/coverage";
import type {
  DocumentSummary,
  SummarizeBatchResponse,
  SynthesizeResponse,
} from "@/src/lib/study/protocol";

/** Spans generated per run (resume continues where this stops). */
export const DEFAULT_MAX_SUMMARY_SPANS = 10;

/** Per-call [Qn] source for label resolution. */
export type LabelledSource = {
  marker: string;
  refLabel: string;
};

const MARKER_PATTERN = /\[Q(\d+)\]/g;

/**
 * Rewrites per-call [Qn] markers to stable parenthesized labels
 * ("(Seite 3)") so persisted span texts stay self-contained and
 * synthesizable. Unresolvable markers vanish (never leak raw).
 */
export function resolveMarkersToLabels(
  text: string,
  sources: LabelledSource[],
): { text: string; refs: string[] } {
  const byMarker = new Map(
    sources.map((source) => [source.marker, source.refLabel]),
  );
  const refs: string[] = [];
  MARKER_PATTERN.lastIndex = 0;

  const out = text.replace(MARKER_PATTERN, (full, num: string) => {
    const label = byMarker.get(`[Q${num}]`);

    if (label === undefined || label === "") return "";

    if (!refs.includes(label)) refs.push(label);

    return `(${label})`;
  });

  return { text: out.replace(/[ \t]{2,}/g, " ").trim(), refs };
}

function spanSortKey(key: string): [number, string] {
  const match = /^[a-z]+:(\d+)/.exec(key);

  return [match === null ? 0 : Number.parseInt(match[1] ?? "0", 10), key];
}

/** Persisted spans back into document (reading) order. */
export function orderSpansForSynthesis<T extends { key: string }>(
  spans: T[],
): T[] {
  return [...spans].sort((a, b) => {
    const [aFrom, aKey] = spanSortKey(a.key);
    const [bFrom, bKey] = spanSortKey(b.key);

    return aFrom - bFrom || (aKey < bKey ? -1 : aKey > bKey ? 1 : 0);
  });
}

/**
 * Greedy contiguous reduction groups within budget (whole
 * sections only, at least one per group). Bounded hierarchical
 * synthesis never ships every raw chunk at once.
 */
export function groupSectionsForReduction<
  T extends { label: string; text: string },
>(sections: T[], budgetChars: number): T[][] {
  const budget =
    Number.isInteger(budgetChars) && budgetChars > 0 ? budgetChars : 6000;
  const groups: T[][] = [];
  let current: T[] = [];
  let used = 0;

  for (const section of sections) {
    const size = section.label.length + section.text.length + 4;

    if (current.length > 0 && used + size > budget) {
      groups.push(current);
      current = [];
      used = 0;
    }

    current.push(section);
    used += size;
  }

  if (current.length > 0) groups.push(current);

  return groups;
}

const LABEL_FINDER =
  /(Seite|Seiten|Folie|Folien|Absatz|Absätze|Zeile|Zeilen)\s+\d+(?:\s*[–—-]\s*\d+)?/g;

/**
 * Every label-like citation in synthesized text must parse and
 * overlap a usable source unit. Fabricated or out-of-range refs
 * fail validation — the draft stays incomplete for retry.
 */
export function validateSynthesisRefs(
  text: string,
  usable: ParsedCoverageUnit[],
): { ok: boolean; refs: string[]; invalid: string[] } {
  LABEL_FINDER.lastIndex = 0;
  const found = [...text.matchAll(LABEL_FINDER)].map((match) => match[0]);
  const refs: string[] = [];
  const invalid: string[] = [];

  for (const label of found) {
    if (refs.includes(label) || invalid.includes(label)) continue;

    const parsed = parseRefLabels([label]);
    const grounded =
      parsed.length > 0 &&
      parsed.every((span) =>
        usable.some((unit) => spansOverlap(unit, span)),
      );

    if (grounded) refs.push(label);
    else invalid.push(label);
  }

  return { ok: invalid.length === 0, refs, invalid };
}

/**
 * Store-validated progress: units of completed spans over usable
 * units of the whole plan. Spans partition units disjointly, so a
 * plain sum is exact; textless units never enter the plan.
 */
export function spanUnitCounts(
  spans: { key: string; units: ParsedCoverageUnit[] }[],
  doneKeys: string[],
): { processedUnits: number; usableUnits: number; percent: number } {
  const done = new Set(doneKeys);
  let usableUnits = 0;
  let processedUnits = 0;

  for (const span of spans) {
    let count = 0;

    for (const unit of span.units) {
      count += unit.kind === "lines" ? 1 : unit.to - unit.from + 1;
    }

    usableUnits += count;

    if (done.has(span.key)) processedUnits += count;
  }

  return {
    processedUnits,
    usableUnits,
    percent:
      usableUnits === 0 ? 0 : Math.round((processedUnits / usableUnits) * 100),
  };
}

// ------------------------------------------------------------ orchestrator

export type SummarySweepOptions = {
  /** Stored draft/active state (null when nothing persisted). */
  loadDraft: () => Promise<DocumentSummary | null>;
  /** Next span (null generation starts a new draft server-side). */
  generateSpan: (
    generationId: string | null,
  ) => Promise<SummarizeBatchResponse>;
  synthesize: (generationId: string) => Promise<SynthesizeResponse>;
  /** True starts a replacement draft even with an active summary. */
  startNew?: boolean;
  maxSpans?: number;
  signal?: AbortSignal;
  onSpan?: (progress: {
    index: number;
    total: number;
    label: string;
    percent: number;
    processedUnits: number;
    usableUnits: number;
  }) => void;
};

export type SummarySweepStatus =
  | "complete"
  | "partial"
  | "cancelled"
  | "error";

export type SummarySweepResult = {
  status: SummarySweepStatus;
  generationId: string | null;
  spansDone: number;
  spansTotal: number;
  percent: number;
  synthesis: SynthesizeResponse | null;
  error: string | null;
};

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Resumable sweep: replays the persisted draft's generation_id,
 * generates up to maxSpans new spans (store-validated, never
 * caller-claimed), then synthesizes. Cancel/error/close keep
 * every persisted span; synthesis failure keeps the draft
 * incomplete for retry. Never touches quiz logic.
 */
export async function runSummarySweep(
  opts: SummarySweepOptions,
): Promise<SummarySweepResult> {
  const maxSpans =
    Number.isInteger(opts.maxSpans) && (opts.maxSpans ?? 0) > 0
      ? (opts.maxSpans as number)
      : DEFAULT_MAX_SUMMARY_SPANS;
  const result: SummarySweepResult = {
    status: "partial",
    generationId: null,
    spansDone: 0,
    spansTotal: 0,
    percent: 0,
    synthesis: null,
    error: null,
  };

  let stored: DocumentSummary | null;

  try {
    stored = await opts.loadDraft();
  } catch (error: unknown) {
    result.status = "error";
    result.error =
      error instanceof Error ? error.message : "Zusammenfassung konnte nicht geladen werden.";

    return result;
  }

  let generationId = stored?.draft?.generationId ?? null;

  if (opts.startNew === true) generationId = null;

  if (
    generationId === null &&
    stored?.active !== null &&
    stored?.active !== undefined &&
    opts.startNew !== true
  ) {
    result.status = "complete";

    return result;
  }

  for (let count = 0; count < maxSpans; count += 1) {
    if (aborted(opts.signal)) {
      result.status = "cancelled";

      return result;
    }

    let response: SummarizeBatchResponse;

    try {
      response = await opts.generateSpan(generationId);
    } catch (error: unknown) {
      result.status = "error";
      result.error =
        error instanceof Error ? error.message : "Abschnitt konnte nicht zusammengefasst werden.";

      return result;
    }

    generationId = response.generationId;
    result.generationId = generationId;
    result.spansDone = response.done
      ? response.span.total
      : response.span.index + 1;
    result.spansTotal = response.span.total;
    result.percent = response.percent;

    opts.onSpan?.({
      index: response.span.index,
      total: response.span.total,
      label: response.span.label,
      percent: response.percent,
      processedUnits: response.processedUnits,
      usableUnits: response.usableUnits,
    });

    if (response.done === true || response.percent >= 100) break;
  }

  if (aborted(opts.signal)) {
    result.status = "cancelled";

    return result;
  }

  try {
    const synthesis =
      generationId === null
        ? null
        : await opts.synthesize(generationId);

    if (synthesis === null) {
      result.status = "error";
      result.error = "Keine Abschnitte zum Zusammenführen.";

      return result;
    }

    result.synthesis = synthesis;
    result.status = synthesis.complete ? "complete" : "partial";
  } catch (error: unknown) {
    result.status = "partial";
    result.error =
      error instanceof Error
        ? error.message
        : "Synthese fehlgeschlagen — Abschnitte bleiben gespeichert.";
  }

  return result;
}
