/**
 * Chunking tests: size bounds, overlap, ref preservation across
 * merges and splits. Every chunk must keep honest source refs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkBlocks, estimateTokens } from "@/src/lib/study/chunk";
import type { SourceRef } from "@/src/lib/study/extract";

const PAGE = (page: number): SourceRef => ({ kind: "page", page });

describe("chunkBlocks", () => {
  it("merges small blocks and keeps every ref", () => {
    const chunks = chunkBlocks(
      [
        { text: "Eins.", ref: PAGE(1) },
        { text: "Zwei.", ref: PAGE(2) },
        { text: "Drei.", ref: PAGE(3) },
      ],
      { targetChars: 1200 },
    );

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.index, 0);
    assert.deepEqual(chunks[0]?.refs, [PAGE(1), PAGE(2), PAGE(3)]);
    assert.match(chunks[0]?.text ?? "", /Eins\.\s*\n\n\s*Zwei\./);
  });

  it("splits at the target and overlaps neighbors", () => {
    const first = `Anfang. ${"Wort ".repeat(300)}Ende-eins.`;
    const second = `Start-zwei. ${"Satz ".repeat(300)}Schluss.`;
    const chunks = chunkBlocks(
      [
        { text: first, ref: PAGE(1) },
        { text: second, ref: PAGE(2) },
      ],
      { targetChars: 1200, overlapChars: 150 },
    );

    assert.ok(chunks.length >= 2);

    for (const chunk of chunks) {
      assert.ok(chunk.charCount <= 2000);
      assert.equal(chunk.charCount, chunk.text.length);
    }

    // Overlap: the tail of chunk 0 reappears at the start of chunk 1.
    const tail = (chunks[0]?.text ?? "").slice(-150);
    assert.ok((chunks[1]?.text ?? "").startsWith(tail.slice(tail.indexOf(" ") + 1)));
    // The overlap carrier keeps the ref of the overlapped chunk.
    assert.deepEqual(chunks[1]?.refs[0], PAGE(1));
  });

  it("splits single overlong blocks on sentence boundaries", () => {
    const text = `${"Erster Satz mit Inhalt. ".repeat(100)}Letzter Satz.`;
    const chunks = chunkBlocks([{ text, ref: PAGE(7) }], {
      targetChars: 1200,
      maxChars: 2000,
    });

    assert.ok(chunks.length >= 2);

    for (const chunk of chunks) {
      assert.ok(chunk.charCount <= 2000);
      assert.deepEqual(chunk.refs, [PAGE(7)]);
    }

    assert.match(
      chunks.map((chunk) => chunk.text).join(" "),
      /Letzter Satz\./,
    );
  });

  it("hard-slices pathological single tokens", () => {
    const chunks = chunkBlocks(
      [{ text: `x${"y".repeat(3000)}`, ref: PAGE(1) }],
      { targetChars: 1200, maxChars: 2000 },
    );

    assert.ok(chunks.length >= 2);

    for (const chunk of chunks) {
      assert.ok(chunk.charCount <= 2000);
    }
  });

  it("drops empty blocks and indexes from zero", () => {
    const chunks = chunkBlocks([
      { text: "  ", ref: PAGE(1) },
      { text: "Inhalt.", ref: PAGE(2) },
    ]);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.index, 0);
    assert.deepEqual(chunks[0]?.refs, [PAGE(2)]);
  });

  it("returns no chunks for empty input", () => {
    assert.deepEqual(chunkBlocks([]), []);
  });
});

describe("estimateTokens", () => {
  it("estimates roughly chars ÷ 4", () => {
    assert.equal(estimateTokens(1200), 300);
    assert.equal(estimateTokens(0), 0);
    assert.equal(estimateTokens(-5), 0);
  });
});
