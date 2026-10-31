/**
 * Summary core tests: marker resolution, synthesis ordering /
 * reduction / ref validation, and the resumable sweep
 * orchestrator (new draft, resume, caps, cancel, failures).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  containingBaseSpan,
  groupSectionsForReduction,
  orderSpansForSynthesis,
  pruneStaleSpans,
  resolveMarkersToLabels,
  runSummarySweep,
  validateSynthesisRefs,
} from "@/src/lib/study/summaries";
import type {
  DocumentSummary,
  SummarizeBatchResponse,
  SynthesizeResponse,
} from "@/src/lib/study/protocol";

function batch(
  overrides: Partial<SummarizeBatchResponse> = {},
): SummarizeBatchResponse {
  return {
    documentId: "doc-1",
    generationId: "gen-1",
    span: { key: "slide:1-4", label: "Folien 1–4", index: 0, total: 2 },
    text: "Text (Folie 1).",
    refs: ["Folie 1"],
    processedUnits: 4,
    usableUnits: 8,
    percent: 50,
    done: false,
    attempts: 1,
    ...overrides,
  };
}

function synthesis(
  overrides: Partial<SynthesizeResponse> = {},
): SynthesizeResponse {
  return {
    documentId: "doc-1",
    generationId: "gen-1",
    text: "Final.",
    refs: ["Folien 1–4"],
    complete: true,
    levels: 1,
    ...overrides,
  };
}

function draftOf(generationId: string): DocumentSummary {
  return {
    documentId: "doc-1",
    status: "partial",
    active: null,
    draft: {
      generationId,
      plannedSpans: [],
      spans: [],
      preview: null,
      startedAt: "2026-10-31T09:00:00.000Z",
    },
  };
}

// ------------------------------------------------------------------ helpers

describe("summary helpers", () => {
  it("resolves markers to labels and drops unknown ones", () => {
    const { text, refs } = resolveMarkersToLabels(
      "Erstens [Q1], zweitens [Q2], erstens [Q1], bluff [Q9].",
      [
        { marker: "[Q1]", refLabel: "Folie 1" },
        { marker: "[Q2]", refLabel: "Folien 2–3" },
      ],
    );

    assert.equal(
      text,
      "Erstens (Folie 1), zweitens (Folien 2–3), erstens (Folie 1), bluff .",
    );
    assert.deepEqual(refs, ["Folie 1", "Folien 2–3"]);
  });

  it("orders spans back into document order", () => {
    assert.deepEqual(
      orderSpansForSynthesis([
        { key: "slide:21-30" },
        { key: "slide:1-10" },
        { key: "slide:11-20" },
      ]).map((span) => span.key),
      ["slide:1-10", "slide:11-20", "slide:21-30"],
    );
  });

  it("groups sections within budget, oversized ones alone", () => {
    const groups = groupSectionsForReduction(
      [
        { label: "A", text: "x".repeat(100) },
        { label: "B", text: "y".repeat(100) },
        { label: "C", text: "z".repeat(5000) },
      ],
      1000,
    );

    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups[0]?.map((section) => section.label),
      ["A", "B"],
    );
    assert.deepEqual(
      groups[1]?.map((section) => section.label),
      ["C"],
    );
  });

  it("validates synthesis refs against usable units", () => {
    const usable = [{ kind: "slide", from: 1, to: 8 }] as const;

    assert.deepEqual(
      validateSynthesisRefs("Siehe Folien 2–3 und Folie 5.", [...usable]),
      { ok: true, refs: ["Folien 2–3", "Folie 5"], invalid: [] },
    );
    assert.deepEqual(
      validateSynthesisRefs("Siehe Folie 99.", [...usable]),
      { ok: false, refs: [], invalid: ["Folie 99"] },
    );
    assert.deepEqual(validateSynthesisRefs("Ohne Belege.", [...usable]), {
      ok: true,
      refs: [],
      invalid: [],
    });
  });

  it("finds containing base spans and prunes stale keys", () => {
    const base = [
      { key: "slide:1-10", units: [{ kind: "slide", from: 1, to: 10 }] },
      { key: "slide:11-20", units: [{ kind: "slide", from: 11, to: 20 }] },
    ] as const;

    assert.equal(
      containingBaseSpan([...base], {
        units: [{ kind: "slide", from: 3, to: 5 }],
      }),
      "slide:1-10",
    );
    assert.equal(
      containingBaseSpan([...base], {
        units: [{ kind: "slide", from: 9, to: 12 }],
      }),
      null,
    );
    assert.deepEqual(
      pruneStaleSpans(
        [
          { kind: "slide", from: 1, to: 10 },
          { kind: "slide", from: 11, to: 20 },
        ],
        [
          { key: "slide:1-5", label: "Folien 1–5" },
          { key: "slide:30-32", label: "Folien 30–32" },
          { key: "??", label: "Kapitel X" },
        ],
      ).map((span) => span.key),
      ["slide:1-5"],
    );
  });
});

// ------------------------------------------------------------ orchestrator

describe("runSummarySweep", () => {
  it("runs a new draft to completion", async () => {
    const seen: (string | null)[] = [];
    const calls = [
      batch({ percent: 50 }),
      batch({
        span: { key: "slide:5-8", label: "Folien 5–8", index: 1, total: 2 },
        percent: 100,
        processedUnits: 8,
      }),
    ];
    let index = 0;

    const result = await runSummarySweep({
      loadDraft: async () => null,
      generateSpan: async (generationId) => {
        seen.push(generationId);

        return calls[index++] ?? calls[0]!;
      },
      synthesize: async (generationId) => {
        assert.equal(generationId, "gen-1");

        return synthesis();
      },
    });

    assert.equal(result.status, "complete");
    assert.equal(result.generationId, "gen-1");
    assert.equal(result.spansDone, 2);
    assert.equal(result.percent, 100);
    assert.deepEqual(seen, [null, "gen-1"]);
  });

  it("resumes with the persisted generation id", async () => {
    const seen: (string | null)[] = [];

    const result = await runSummarySweep({
      loadDraft: async () => draftOf("gen-9"),
      generateSpan: async (generationId) => {
        seen.push(generationId);

        return batch({ generationId: "gen-9", percent: 100, done: true });
      },
      synthesize: async () => synthesis({ generationId: "gen-9" }),
    });

    assert.deepEqual(seen, ["gen-9"]);
    assert.equal(result.status, "complete");
  });

  it("does nothing when a complete summary exists", async () => {
    const result = await runSummarySweep({
      loadDraft: async () => ({
        documentId: "doc-1",
        status: "complete",
        active: { text: "Alt.", refs: [], completedAt: "2026-10-30" },
        draft: null,
      }),
      generateSpan: async () => {
        assert.fail("must not generate");

        return batch();
      },
      synthesize: async () => {
        assert.fail("must not synthesize");

        return synthesis();
      },
    });

    assert.equal(result.status, "complete");
    assert.equal(result.synthesis, null);
  });

  it("starts a replacement draft only when asked", async () => {
    const seen: (string | null)[] = [];

    await runSummarySweep({
      loadDraft: async () => ({
        documentId: "doc-1",
        status: "complete",
        active: { text: "Alt.", refs: [], completedAt: "2026-10-30" },
        draft: null,
      }),
      startNew: true,
      maxSpans: 1,
      generateSpan: async (generationId) => {
        seen.push(generationId);

        return batch({ generationId: "gen-new", percent: 50 });
      },
      synthesize: async () => synthesis({ complete: false }),
    });

    assert.deepEqual(seen, [null]);
  });

  it("stops at the span cap and synthesizes a preview", async () => {
    let calls = 0;

    const result = await runSummarySweep({
      loadDraft: async () => null,
      maxSpans: 1,
      generateSpan: async () => {
        calls += 1;

        return batch({ percent: 50 });
      },
      synthesize: async () => synthesis({ complete: false }),
    });

    assert.equal(calls, 1);
    assert.equal(result.status, "partial");
    assert.equal(result.synthesis?.complete, false);
  });

  it("cancels between spans and keeps progress", async () => {
    const controller = new AbortController();

    const result = await runSummarySweep({
      loadDraft: async () => null,
      maxSpans: 5,
      signal: controller.signal,
      generateSpan: async () => batch({ percent: 50 }),
      synthesize: async () => {
        assert.fail("must not synthesize after cancel");

        return synthesis();
      },
      onSpan: () => controller.abort(),
    });

    assert.equal(result.status, "cancelled");
    assert.equal(result.spansDone, 1);
  });

  it("keeps spans when a later batch fails", async () => {
    let calls = 0;

    const result = await runSummarySweep({
      loadDraft: async () => null,
      maxSpans: 5,
      generateSpan: async () => {
        calls += 1;

        if (calls >= 2) throw new Error("Modell antwortet nicht.");

        return batch({ percent: 50 });
      },
      synthesize: async () => {
        assert.fail("must not synthesize after error");

        return synthesis();
      },
    });

    assert.equal(result.status, "error");
    assert.equal(result.spansDone, 1);
    assert.equal(result.error, "Modell antwortet nicht.");
  });

  it("keeps the draft resumable when synthesis fails", async () => {
    const result = await runSummarySweep({
      loadDraft: async () => null,
      maxSpans: 1,
      generateSpan: async () => batch({ percent: 100 }),
      synthesize: async () => {
        throw new Error("Synthese abgeschnitten.");
      },
    });

    assert.equal(result.status, "partial");
    assert.equal(result.spansDone, 1);
    assert.equal(result.error, "Synthese abgeschnitten.");
    assert.equal(result.synthesis, null);
  });
});
