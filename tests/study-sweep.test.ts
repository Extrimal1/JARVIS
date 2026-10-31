/**
 * Summary sweep tests: full-coverage span planning (51/200/300
 * slides), distributed processing order, stable span keys, batch
 * + synthesis prompts, and summary protocol guards. All pure.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRefLabels,
  planSummarySweep,
  type CoverableChunk,
  type SummarySpan,
} from "@/src/lib/study/coverage";
import {
  batchSummaryPrompt,
  synthesizePrompt,
} from "@/src/lib/study/prompts";
import {
  isDocumentSummary,
  isSummarizeBatchResponse,
  isSynthesizeResponse,
  type DocumentSummary,
} from "@/src/lib/study/protocol";

function slideChunks(slides: number, chars = 400): CoverableChunk[] {
  return Array.from({ length: slides }, (_, i) =>
    chunk(i, `Inhalt Folie ${i + 1}. `.repeat(Math.ceil(chars / 16)), [
      { kind: "slide", slide: i + 1 },
    ]),
  );
}

function chunk(
  index: number,
  text: string,
  refs: CoverableChunk["refs"],
): CoverableChunk {
  return { index, text, refs };
}

function planOf(
  slides: number,
  chars = 400,
  splits: Record<string, number> = {},
): SummarySpan[] {
  return planSummarySweep(slideChunks(slides, chars), 4000, splits);
}

/** Every unit 1..n covered exactly once across all spans. */
function assertExactCover(spans: SummarySpan[], slides: number): void {
  const seen: number[] = [];

  for (const span of spans) {
    for (const unit of span.units) {
      assert.equal(unit.kind, "slide");

      for (let n = unit.from; n <= unit.to; n += 1) seen.push(n);
    }
  }

  assert.deepEqual(
    seen.sort((a, b) => a - b),
    Array.from({ length: slides }, (_, i) => i + 1),
  );
}

function spanMid(span: SummarySpan): number {
  const from = span.units[0]?.from ?? 0;
  const last = span.units[span.units.length - 1];

  return (from + (last?.to ?? from)) / 2;
}

// ------------------------------------------------------------------ planner

describe("planSummarySweep", () => {
  for (const slides of [51, 200, 300]) {
    it(`covers a ${slides}-slide deck exactly once`, () => {
      const spans = planOf(slides);

      assert.ok(spans.length >= 2);
      assertExactCover(spans, slides);

      const keys = spans.map((span) => span.key);

      assert.equal(new Set(keys).size, keys.length);

      for (const span of spans) {
        const sorted = [...span.chunkIndices].sort((a, b) => a - b);

        assert.deepEqual(span.chunkIndices, sorted);
        assert.equal(
          sorted[sorted.length - 1]! - sorted[0]! + 1,
          sorted.length,
        );
        assert.ok(span.chars <= 4000 + 1200);
        assert.ok(parseRefLabels([span.label]).length > 0);
      }
    });
  }

  it("processes spans in distributed order (no front bias)", () => {
    const spans = planOf(51);
    const first = spans[0]!;
    const second = spans[1]!;

    assert.ok(Math.abs(spanMid(first) - spanMid(second)) > 51 / 4);

    const mids = spans.slice(0, 4).map(spanMid);
    const spread = Math.max(...mids) - Math.min(...mids);

    assert.ok(spread > 51 / 2);
  });

  it("uses bit-reversal order for eight spans", () => {
    const chunks = Array.from({ length: 8 }, (_, i) =>
      chunk(i, "x".repeat(100), [{ kind: "slide", slide: i + 1 }]),
    );
    const spans = planSummarySweep(chunks, 150);

    assert.deepEqual(
      spans.map((span) => span.label),
      [
        "Folie 1",
        "Folie 5",
        "Folie 3",
        "Folie 7",
        "Folie 2",
        "Folie 6",
        "Folie 4",
        "Folie 8",
      ],
    );
  });

  it("is deterministic with stable keys", () => {
    const first = planOf(51);
    const second = planOf(51);

    assert.deepEqual(
      first.map((span) => span.key),
      second.map((span) => span.key),
    );
  });

  it("keeps dense pages in few spans and honors the budget", () => {
    const pages = Array.from({ length: 4 }, (_, i) =>
      chunk(i, "x".repeat(1200), [{ kind: "page", page: i + 1 }]),
    );
    const tight = planSummarySweep(pages, 1500);
    const wide = planSummarySweep(pages, 100000);

    assert.equal(tight.length, 4);
    assert.equal(wide.length, 1);
    assert.equal(wide[0]?.label, "Seiten 1–4");
  });

  it("returns no spans for empty input", () => {
    assert.deepEqual(planSummarySweep([]), []);
  });

  it("subdivides split spans with exact unit keys", () => {
    const base = planOf(20);
    const baseKeys = base.map((span) => span.key);
    const victim = baseKeys[0]!;
    const split = planOf(20, 400, { [victim]: 1 });

    assert.equal(split.length, base.length + 1);
    assert.ok(!split.some((span) => span.key === victim));
    assertExactCover(split, 20);

    const parent = base.find((span) => span.key === victim)!;
    const children = split.filter((span) =>
      parent.chunkIndices.some((index) => span.chunkIndices.includes(index)),
    );

    assert.equal(children.length, 2);

    const [first, second] = [...children].sort(
      (a, b) => a.chunkIndices[0]! - b.chunkIndices[0]!,
    );

    assert.ok(first!.chunkIndices.every((index) => index < (second!.chunkIndices[0] ?? 0)));
    assert.deepEqual(
      [...(first?.chunkIndices ?? []), ...(second?.chunkIndices ?? [])].sort(
        (a, b) => a - b,
      ),
      [...parent.chunkIndices].sort((a, b) => a - b),
    );
  });

  it("drills recursively and stops at single-chunk spans", () => {
    const one = planOf(8, 400, { "slide:1-8": 2 });

    assert.equal(one.length, 4);
    assertExactCover(one, 8);

    const immune = planSummarySweep(slideChunks(2, 100), 100000, {
      "slide:1-2": 5,
    });

    assert.deepEqual(
      immune.map((span) => span.key),
      ["slide:1", "slide:2"],
    );
  });

  it("ignores unknown split keys", () => {
    assert.deepEqual(
      planOf(20, 400, { "slide:99": 3 }).map((span) => span.key),
      planOf(20).map((span) => span.key),
    );
  });
});

// ------------------------------------------------------------------ prompts

describe("summary prompts", () => {
  const sources = [
    {
      marker: "[Q1]",
      documentName: "Skript.pdf",
      refLabel: "Folie 1",
      text: "Der Citratzyklus läuft in den Mitochondrien ab.",
    },
  ];

  it("asks for a grounded span summary with citations", () => {
    const [system, user] = batchSummaryPrompt(
      "de",
      "Skript.pdf",
      "Folien 1–4",
      sources,
    );

    assert.equal(system?.role, "system");
    assert.match(user?.content ?? "", /Folien 1–4/);
    assert.match(user?.content ?? "", /\[Qn\]/);
    assert.match(user?.content ?? "", /Erfinde nichts/);
    assert.match(user?.content ?? "", /Formeln/);
  });

  it("supports Russian span summaries", () => {
    const [, user] = batchSummaryPrompt(
      "ru",
      "Скрипт.pdf",
      "Folien 1–4",
      sources,
    );

    assert.match(user?.content ?? "", /пометкой \[Qn\]/);
  });

  it("merges sections with headings and verbatim labels", () => {
    const [, user] = synthesizePrompt(
      "de",
      "Skript.pdf",
      [
        { label: "Folien 1–4", text: "Abschnitt eins." },
        { label: "Folien 5–8", text: "Abschnitt zwei." },
      ],
      true,
    );

    assert.match(user?.content ?? "", /## Folien 1–4/);
    assert.match(user?.content ?? "", /Überschriften/);
    assert.match(user?.content ?? "", /wörtlich/);
    assert.ok(!(user?.content ?? "").includes("nicht verarbeitet"));
  });

  it("marks partial synthesis honestly in both locales", () => {
    const [, de] = synthesizePrompt("de", "Skript.pdf", [], false);
    const [, ru] = synthesizePrompt("ru", "Скрипт.pdf", [], false);

    assert.match(de?.content ?? "", /noch nicht verarbeitet/);
    assert.match(ru?.content ?? "", /ещё не обработаны/);
  });
});

// ------------------------------------------------------------------ guards

describe("summary protocol guards", () => {
  const full: DocumentSummary = {
    documentId: "doc-1",
    status: "partial",
    active: {
      text: "Alte Zusammenfassung.",
      refs: ["Folie 1"],
      completedAt: "2026-10-30T10:00:00.000Z",
    },
    draft: {
      generationId: "gen-1",
      plannedSpans: [{ key: "slide:1-4", label: "Folien 1–4", order: 0 }],
      spans: [
        {
          key: "slide:1-4",
          label: "Folien 1–4",
          text: "Neu.",
          refs: ["Folie 1"],
          completedAt: "2026-10-31T10:00:00.000Z",
        },
      ],
      preview: null,
      startedAt: "2026-10-31T09:00:00.000Z",
    },
  };

  it("accepts full and empty summary states", () => {
    assert.equal(isDocumentSummary(full), true);
    assert.equal(
      isDocumentSummary({ documentId: "doc-1", status: "none", active: null, draft: null }),
      true,
    );
  });

  it("accepts drafts with and without splits", () => {
    assert.equal(
      isDocumentSummary({
        ...full,
        draft: { ...full.draft, splits: { "slide:1-10": 2 } },
      }),
      true,
    );
    assert.equal(
      isDocumentSummary({
        ...full,
        draft: { ...full.draft, splits: { "slide:1-10": "tief" } },
      }),
      false,
    );
  });

  it("rejects malformed summary states", () => {
    assert.equal(isDocumentSummary({ ...full, status: "fertig" }), false);
    assert.equal(
      isDocumentSummary({ ...full, draft: { generationId: "x" } }),
      false,
    );
    assert.equal(
      isDocumentSummary({
        ...full,
        draft: { ...full.draft, spans: [{ key: "x" }] },
      }),
      false,
    );
  });

  it("validates batch and synthesis responses", () => {
    assert.equal(
      isSummarizeBatchResponse({
        documentId: "doc-1",
        generationId: "gen-1",
        span: { key: "slide:1-4", label: "Folien 1–4", index: 0, total: 6 },
        text: "Zusammenfassung.",
        refs: ["Folie 1"],
        processedUnits: 4,
        usableUnits: 51,
        percent: 8,
        done: false,
        attempts: 1,
      }),
      true,
    );
    assert.equal(
      isSummarizeBatchResponse({ documentId: "doc-1", percent: 8 }),
      false,
    );
    assert.equal(
      isSynthesizeResponse({
        documentId: "doc-1",
        generationId: "gen-1",
        text: "Final.",
        refs: ["Folien 1–4"],
        complete: true,
        levels: 1,
      }),
      true,
    );
    assert.equal(
      isSynthesizeResponse({ documentId: "doc-1", complete: true }),
      false,
    );
  });
});
