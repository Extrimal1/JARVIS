/**
 * Grounding tests: citation markers must resolve to retrieved
 * sources; fabricated markers get repaired once, then stripped with
 * a visible note. No invented ref may reach the user.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  citationRepairPrompt,
  findCitations,
  insufficientContextMessage,
  strippedCitationNote,
  stripInvalidCitations,
  validateCitations,
  type CitationSource,
} from "@/src/lib/study/grounding";

const SOURCES: CitationSource[] = [
  { marker: "[Q1]", documentName: "Bio.pdf", refLabel: "Seite 1" },
  { marker: "[Q2]", documentName: "Bio.pdf", refLabel: "Seite 2" },
];

describe("findCitations", () => {
  it("finds markers in reading order", () => {
    assert.deepEqual(findCitations("Siehe [Q2] und [Q1], auch [Q2]."), [2, 1, 2]);
  });

  it("ignores lookalikes", () => {
    assert.deepEqual(findCitations("Abschnitt [1], [Q], [Qx]"), []);
  });
});

describe("validateCitations", () => {
  it("accepts in-range markers", () => {
    assert.deepEqual(validateCitations("Fakt [Q1], Fakt [Q2].", 2), { ok: true });
  });

  it("accepts answers without markers", () => {
    assert.deepEqual(validateCitations("Keine Zitate nötig.", 2), { ok: true });
  });

  it("flags out-of-range and zero markers", () => {
    assert.deepEqual(validateCitations("Fakt [Q1], Bluff [Q3], Bluff [Q0].", 2), {
      ok: false,
      invalid: [0, 3],
    });
  });

  it("flags every marker when no sources exist", () => {
    assert.deepEqual(validateCitations("Bluff [Q1].", 0), {
      ok: false,
      invalid: [1],
    });
  });
});

describe("stripInvalidCitations", () => {
  it("removes exactly the banned markers", () => {
    assert.equal(
      stripInvalidCitations("Gut [Q1], schlecht [Q3], ok [Q2].", [3]),
      "Gut [Q1], schlecht , ok [Q2].",
    );
  });

  it("is a no-op for empty ban lists", () => {
    assert.equal(stripInvalidCitations("Text [Q1].", []), "Text [Q1].");
  });
});

describe("honesty messages", () => {
  it("names bad markers and the valid range (de/ru)", () => {
    const de = citationRepairPrompt("de", [3], SOURCES);
    const ru = citationRepairPrompt("ru", [3], SOURCES);

    assert.match(de, /\[Q3\]/);
    assert.match(de, /\[Q1\]…\[Q2\]/);
    assert.match(ru, /\[Q3\]/);
    assert.match(ru, /\[Q1\]…\[Q2\]/);
  });

  it("lists removed markers and verified sources", () => {
    const note = strippedCitationNote("de", [3], SOURCES);

    assert.match(note, /\[Q3\]/);
    assert.match(note, /Bio\.pdf, Seite 1/);
  });

  it("admits insufficient context without inventing (de/ru)", () => {
    assert.match(insufficientContextMessage("de"), /nichts Passendes gefunden/);
    assert.match(insufficientContextMessage("ru"), /ничего подходящего/);
    assert.ok(!insufficientContextMessage("de").includes("[Q"));
  });
});
