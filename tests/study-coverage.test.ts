/**
 * Coverage-aware question generation: ref-label parsing, page/slide
 * grouping, spread window selection, coverage math, adaptive targets,
 * and exact + near-duplicate filtering. All pure and deterministic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  coverageStats,
  filterFreshQuestions,
  groupChunksByUnit,
  isNearDuplicate,
  jaccardSimilarity,
  markCoveredGroups,
  maxGroupsForCount,
  parseRefLabels,
  selectQuestionWindow,
  selectWindow,
  targetQuestionCount,
  type CoverableChunk,
} from "@/src/lib/study/coverage";
import { formatSourceRefs } from "@/src/lib/study/extract";
import type { QuizQuestion } from "@/src/lib/quiz";

function chunk(
  index: number,
  text: string,
  refs: CoverableChunk["refs"],
): CoverableChunk {
  return { index, text, refs };
}

function pageChunks(pages: number, chars = 1200): CoverableChunk[] {
  return Array.from({ length: pages }, (_, i) =>
    chunk(i, `Inhalt Seite ${i + 1}. `.repeat(Math.ceil(chars / 16)), [
      { kind: "page", page: i + 1 },
    ]),
  );
}

function slideChunks(slides: number, chars = 400): CoverableChunk[] {
  return Array.from({ length: slides }, (_, i) =>
    chunk(i, `Inhalt Folie ${i + 1}. `.repeat(Math.ceil(chars / 16)), [
      { kind: "slide", slide: i + 1 },
    ]),
  );
}

function manualQuestion(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: "q-1",
    subject: "BWL",
    examId: null,
    topicId: null,
    question: "Was ist der Zinseszins?",
    options: ["A", "B", "C"],
    correctIndex: 0,
    explanation: "Begründung.",
    documentId: "doc-1",
    source: "ai",
    sourceRefs: ["Seite 1"],
    ...overrides,
  };
}

// ------------------------------------------------------------------- parsing

describe("parseRefLabels", () => {
  it("parses singular and plural page/slide/paragraph/line labels", () => {
    assert.deepEqual(parseRefLabels(["Seite 3"]), [
      { kind: "page", from: 3, to: 3 },
    ]);
    assert.deepEqual(parseRefLabels(["Folie 12"]), [
      { kind: "slide", from: 12, to: 12 },
    ]);
    assert.deepEqual(parseRefLabels(["Absatz 2"]), [
      { kind: "paragraph", from: 2, to: 2 },
    ]);
    assert.deepEqual(parseRefLabels(["Seiten 3–4"]), [
      { kind: "page", from: 3, to: 4 },
    ]);
    assert.deepEqual(parseRefLabels(["Folien 5–24"]), [
      { kind: "slide", from: 5, to: 24 },
    ]);
    assert.deepEqual(parseRefLabels(["Zeilen 5–12"]), [
      { kind: "lines", from: 5, to: 12 },
    ]);
    assert.deepEqual(parseRefLabels(["Zeile 7"]), [
      { kind: "lines", from: 7, to: 7 },
    ]);
  });

  it("splits multi-part labels and tolerates hyphen ranges", () => {
    assert.deepEqual(parseRefLabels(["Seite 3, Folie 5"]), [
      { kind: "page", from: 3, to: 3 },
      { kind: "slide", from: 5, to: 5 },
    ]);
    assert.deepEqual(parseRefLabels(["Seiten 3-4"]), [
      { kind: "page", from: 3, to: 4 },
    ]);
  });

  it("ignores unknown labels instead of throwing", () => {
    assert.deepEqual(parseRefLabels(["[Q1]", "", "Seite 0", "Kapitel X"]), []);
  });

  it("round-trips every formatSourceRefs output", () => {
    const refs = [
      { kind: "page", page: 3 },
      { kind: "page", page: 4 },
      { kind: "slide", slide: 9 },
      { kind: "paragraph", paragraph: 1 },
      { kind: "paragraph", paragraph: 2 },
      { kind: "lines", start: 5, end: 12 },
    ] as const;
    const label = formatSourceRefs([...refs]);
    const parsed = parseRefLabels([label]);

    assert.ok(parsed.length >= 4);
    assert.deepEqual(parsed[0], { kind: "page", from: 3, to: 4 });
  });
});

// ------------------------------------------------------------------ grouping

describe("groupChunksByUnit", () => {
  it("groups consecutive same-page chunks into one labelled group", () => {
    const groups = groupChunksByUnit([
      chunk(0, "a".repeat(800), [{ kind: "page", page: 1 }]),
      chunk(1, "b".repeat(800), [{ kind: "page", page: 1 }]),
      chunk(2, "c".repeat(800), [{ kind: "page", page: 2 }]),
    ]);

    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.label, "Seite 1");
    assert.deepEqual(groups[0]?.chunkIndices, [0, 1]);
    assert.equal(groups[1]?.label, "Seite 2");
  });

  it("keeps sparse multi-slide chunks as range-labelled groups", () => {
    const groups = groupChunksByUnit([
      chunk(0, "kurz", [
        { kind: "slide", slide: 1 },
        { kind: "slide", slide: 2 },
        { kind: "slide", slide: 3 },
      ]),
      chunk(1, "kurz", [{ kind: "slide", slide: 4 }]),
    ]);

    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.label, "Folien 1–3");
    assert.equal(groups[1]?.label, "Folie 4");
  });

  it("keeps text chunks without refs selectable under a chunk label", () => {
    const groups = groupChunksByUnit([chunk(0, "text ohne refs", [])]);

    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]?.chunkIndices, [0]);
    assert.deepEqual(groups[0]?.units, []);
  });
});

// ------------------------------------------------------------------ coverage

describe("markCoveredGroups and coverageStats", () => {
  it("marks groups covered by exact and range labels", () => {
    const groups = groupChunksByUnit(pageChunks(6, 300));
    const covered = markCoveredGroups(groups, ["Seite 2", "Seiten 4–5"]);

    assert.deepEqual(covered, [false, true, false, true, true, false]);

    const stats = coverageStats(groups, ["Seite 2", "Seiten 4–5"]);

    assert.equal(stats.usableUnits, 6);
    assert.equal(stats.coveredUnits, 3);
    assert.equal(stats.percent, 50);
  });

  it("ignores cited pages that have no chunks (partial extraction)", () => {
    const chunks = [
      chunk(0, "a".repeat(300), [{ kind: "page", page: 1 }]),
      chunk(1, "c".repeat(300), [{ kind: "page", page: 3 }]),
    ];
    const groups = groupChunksByUnit(chunks);
    const stats = coverageStats(groups, ["Seite 2", "Seite 3"]);

    assert.equal(stats.usableUnits, 2);
    assert.equal(stats.coveredUnits, 1);
    assert.equal(stats.percent, 50);
  });

  it("matches cited line ranges by overlap", () => {
    const groups = groupChunksByUnit([
      chunk(0, "a".repeat(300), [{ kind: "lines", start: 1, end: 40 }]),
      chunk(1, "b".repeat(300), [{ kind: "lines", start: 41, end: 80 }]),
    ]);

    assert.deepEqual(markCoveredGroups(groups, ["Zeilen 5–12"]), [true, false]);
  });

  it("reports zero percent when nothing usable exists", () => {
    const stats = coverageStats([], []);

    assert.equal(stats.usableUnits, 0);
    assert.equal(stats.percent, 0);
  });
});

// ------------------------------------------------------------------ selection

describe("selectWindow", () => {
  it("spreads the first window across a 300-slide deck (no front bias)", () => {
    const groups = groupChunksByUnit(slideChunks(300));
    const covered = markCoveredGroups(groups, []);
    const window = selectWindow(groups, covered, {
      maxGroups: 4,
      budgetChars: 4000,
      minGroupChars: 120,
    });

    assert.equal(window.groups.length, 4);
    assert.equal(window.truncated, true);
    const firstUnits = window.groups.map((group) => group.units[0]?.from ?? 0);

    assert.ok(firstUnits[0] === 1);
    assert.ok((firstUnits[3] ?? 0) > 200);
    assert.deepEqual(
      [...firstUnits].sort((a, b) => a - b),
      firstUnits,
      "window stays in document order",
    );
  });

  it("prefers uncovered slides on repeated generation", () => {
    const groups = groupChunksByUnit(slideChunks(20));
    const first = selectWindow(groups, markCoveredGroups(groups, []), {
      maxGroups: 4,
      budgetChars: 4000,
      minGroupChars: 120,
    });
    const coveredLabels = first.groups.map((group) => group.label);
    const second = selectWindow(groups, markCoveredGroups(groups, coveredLabels), {
      maxGroups: 4,
      budgetChars: 4000,
      minGroupChars: 120,
    });

    const firstKeys = new Set(first.groups.map((group) => group.key));
    const overlap = second.groups.filter((group) => firstKeys.has(group.key));

    assert.equal(second.groups.length, 4);
    assert.equal(overlap.length, 0);
  });

  it("is deterministic for identical input", () => {
    const groups = groupChunksByUnit(slideChunks(120));
    const covered = markCoveredGroups(groups, ["Folie 7"]);
    const opts = { maxGroups: 4, budgetChars: 4000, minGroupChars: 120 };

    assert.deepEqual(selectWindow(groups, covered, opts), selectWindow(groups, covered, opts));
  });

  it("respects the char budget but always keeps one group", () => {
    const groups = groupChunksByUnit(pageChunks(10));
    const window = selectWindow(groups, markCoveredGroups(groups, []), {
      maxGroups: 6,
      budgetChars: 2500,
      minGroupChars: 120,
    });

    assert.ok(window.groups.length >= 1);
    assert.ok(window.groups.length < 6);
    assert.equal(window.truncated, true);
  });

  it("skips thin groups but never returns empty when chunks exist", () => {
    const groups = groupChunksByUnit([
      chunk(0, "Titel", [{ kind: "slide", slide: 1 }]),
      chunk(1, "x".repeat(500), [{ kind: "slide", slide: 2 }]),
    ]);
    const window = selectWindow(groups, markCoveredGroups(groups, []), {
      maxGroups: 4,
      budgetChars: 4000,
      minGroupChars: 120,
    });

    assert.deepEqual(
      window.groups.map((group) => group.key),
      ["slide:2"],
    );

    const thinOnly = selectWindow(
      groupChunksByUnit([chunk(0, "Titel", [{ kind: "slide", slide: 1 }])]),
      [false],
      { maxGroups: 4, budgetChars: 4000, minGroupChars: 120 },
    );

    assert.equal(thinOnly.groups.length, 1);
  });

  it("returns an empty window for empty input", () => {
    const window = selectWindow([], [], {});

    assert.deepEqual(window.groups, []);
    assert.deepEqual(window.chunkIndices, []);
    assert.equal(window.truncated, false);
  });
});

// ------------------------------------------------------------- shared window

describe("maxGroupsForCount", () => {
  it("keeps at least a pair and at most the cap", () => {
    assert.equal(maxGroupsForCount(1), 2);
    assert.equal(maxGroupsForCount(2), 2);
    assert.equal(maxGroupsForCount(3), 3);
    assert.equal(maxGroupsForCount(6), 4);
    assert.equal(maxGroupsForCount(10), 4);
    assert.equal(maxGroupsForCount(0), 4);
  });
});

describe("selectQuestionWindow", () => {
  const entries = slideChunks(8, 300).map((entry) => ({
    ...entry,
    payload: `row-${entry.index}`,
  }));

  it("picks payloads in document order with labels and coverage", () => {
    const first = selectQuestionWindow(entries, [], 2, 4000);

    assert.deepEqual(
      first.picked.map((entry) => entry.payload),
      ["row-0", "row-7"],
    );
    assert.deepEqual(first.labels, ["Folie 1", "Folie 8"]);
    assert.equal(first.poolSize, 8);
    assert.equal(first.truncated, true);
    assert.deepEqual(first.coverage, {
      usableUnits: 8,
      coveredUnits: 0,
      percent: 0,
      groupCount: 8,
      coveredGroups: 0,
    });
  });

  it("shifts to uncovered slices on repeat calls", () => {
    const second = selectQuestionWindow(entries, ["Folie 1", "Folie 8"], 2, 4000);

    assert.deepEqual(
      second.picked.map((entry) => entry.payload),
      ["row-1", "row-6"],
    );
    assert.equal(second.coverage.coveredUnits, 2);
    assert.equal(second.coverage.percent, 25);
  });
});

// ------------------------------------------------------------------- targets

describe("targetQuestionCount", () => {
  it("follows the guideline curve and clamps both ends", () => {
    assert.equal(targetQuestionCount(0), 0);
    assert.equal(targetQuestionCount(1), 4);
    assert.equal(targetQuestionCount(20), 8);
    assert.equal(targetQuestionCount(50), 20);
    assert.equal(targetQuestionCount(200), 80);
    assert.equal(targetQuestionCount(300), 120);
    assert.equal(targetQuestionCount(9999), 150);
  });
});

// --------------------------------------------------------------------- dedup

describe("near-duplicate detection", () => {
  it("scores identical texts at 1 and unrelated texts low", () => {
    assert.equal(jaccardSimilarity("Was ist der Zinseszins?", "Was ist der Zinseszins?"), 1);
    assert.ok(jaccardSimilarity("Was ist der Zinseszins?", "Nenne drei Arten von Renten.") < 0.5);
  });

  it("flags high-overlap paraphrases but keeps short distinct questions", () => {
    assert.equal(
      isNearDuplicate(
        "Welche Bereiche werden in der Finanzmathematik betrachtet?",
        "Welche Bereiche werden in der Finanzmathematik nun betrachtet?",
      ),
      true,
    );
    assert.equal(isNearDuplicate("Was ist X?", "Was ist Y?"), false);
  });

  it("filterFreshQuestions rejects exact and near duplicates per document", () => {
    const existing = [
      manualQuestion({ id: "e1", question: "Was ist der Zinseszins?" }),
      manualQuestion({
        id: "e2",
        question: "Welche Bereiche werden in der Finanzmathematik betrachtet?",
      }),
    ];
    const candidates = [
      manualQuestion({ id: "c-exact", question: "  was ist der  ZINSESZINS? " }),
      manualQuestion({
        id: "c-near",
        question: "Welche Bereiche werden in der Finanzmathematik nun betrachtet?",
      }),
      manualQuestion({ id: "c-fresh", question: "Nenne drei Arten von Renten." }),
      manualQuestion({
        id: "c-other-doc",
        documentId: "doc-2",
        question: "Was ist der Zinseszins?",
      }),
    ];

    const { fresh, skippedExact, skippedNear } = filterFreshQuestions(existing, candidates);

    assert.deepEqual(
      fresh.map((item) => item.id),
      ["c-fresh", "c-other-doc"],
    );
    assert.equal(skippedExact, 1);
    assert.equal(skippedNear, 1);
  });

  it("filterFreshQuestions also dedupes within the candidate batch", () => {
    const candidates = [
      manualQuestion({ id: "c1", question: "Nenne drei Arten von Renten." }),
      manualQuestion({ id: "c2", question: "Nenne drei Arten von Renten!" }),
    ];

    const { fresh, skippedNear } = filterFreshQuestions([], candidates);

    assert.deepEqual(
      fresh.map((item) => item.id),
      ["c1"],
    );
    assert.equal(skippedNear, 1);
  });
});
