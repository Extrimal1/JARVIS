/**
 * Retrieval scoring tests: tokenization (de/en/ru stopwords),
 * coverage-dominated ranking, and honest empty results.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rankByTerms,
  scoreText,
  tokenizeQuery,
} from "@/src/lib/study/retrieve";

describe("tokenizeQuery", () => {
  it("drops stopwords and short tokens, dedupes", () => {
    assert.deepEqual(
      tokenizeQuery("Was ist die Photosynthese der Pflanzen?"),
      ["photosynthese", "pflanzen"],
    );
  });

  it("handles English and Russian stopwords", () => {
    assert.deepEqual(tokenizeQuery("what is the cell"), ["what", "cell"]);
    assert.deepEqual(tokenizeQuery("что такое клетка"), ["клетка"]);
  });

  it("returns [] for stopword-only queries", () => {
    assert.deepEqual(tokenizeQuery("was ist der und die"), []);
  });
});

describe("scoreText", () => {
  it("scores 0 without term matches", () => {
    assert.deepEqual(scoreText(["photosynthese"], "Newton und Äpfel"), {
      score: 0,
      matchedTerms: [],
    });
  });

  it("prefers coverage over repetition", () => {
    const broad = scoreText(
      ["kraft", "masse"],
      "Kraft ist Masse mal Beschleunigung.",
    );
    const narrow = scoreText(
      ["kraft", "masse"],
      "Kraft Kraft Kraft Kraft Kraft.",
    );

    assert.deepEqual(broad.matchedTerms, ["kraft", "masse"]);
    assert.deepEqual(narrow.matchedTerms, ["kraft"]);
    assert.ok(broad.score > narrow.score);
  });
});

describe("rankByTerms", () => {
  const items = [
    { id: "a", text: "Die Französische Revolution begann 1789." },
    { id: "b", text: "Newton formulierte die Gravitationstheorie." },
    { id: "c", text: "Die Revolution frisst ihre Kinder, sagte man 1793." },
  ];

  it("ranks matches best-first and caps the limit", () => {
    const ranked = rankByTerms(items, (item) => item.text, "Revolution 1789", 2);

    assert.equal(ranked.length, 2);
    assert.equal(ranked[0]?.item.id, "a");
    assert.deepEqual(ranked[0]?.matchedTerms, ["revolution", "1789"]);
    assert.equal(ranked[1]?.item.id, "c");
  });

  it("returns [] when nothing matches or no terms exist", () => {
    assert.deepEqual(rankByTerms(items, (item) => item.text, "Photosynthese", 5), []);
    assert.deepEqual(rankByTerms(items, (item) => item.text, "was ist", 5), []);
  });
});
