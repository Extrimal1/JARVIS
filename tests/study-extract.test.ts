/**
 * Study extraction tests: real PDF/DOCX/PPTX/TXT fixtures through
 * `extractDocument`, plus every failure mode (corrupt, encrypted,
 * scanned, empty, oversized). Refs must be exact — citations depend
 * on them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 as crc32Of } from "node:zlib";
import {
  blocksToText,
  extractDocument,
  ExtractError,
  formatSourceRef,
  formatSourceRefs,
  MAX_EXTRACT_BYTES,
} from "@/src/lib/study/extract";

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
  );
}

async function extractErrorOf(
  kind: string,
  bytes: Uint8Array,
): Promise<ExtractError> {
  try {
    await extractDocument(kind, bytes);
  } catch (error: unknown) {
    assert.ok(error instanceof ExtractError);

    return error;
  }

  assert.fail("expected ExtractError");
}

describe("extractDocument", () => {
  it("extracts two PDF pages with umlauts and page refs", async () => {
    const doc = await extractDocument("pdf", fixture("sample.pdf"));

    assert.equal(doc.blocks.length, 2);
    assert.deepEqual(doc.blocks[0]?.ref, { kind: "page", page: 1 });
    assert.deepEqual(doc.blocks[1]?.ref, { kind: "page", page: 2 });
    assert.match(doc.blocks[0]?.text ?? "", /Glykolyse/);
    assert.match(doc.blocks[0]?.text ?? "", /Moleküle/);
    assert.match(doc.blocks[1]?.text ?? "", /Citratzyklus/);
    assert.match(doc.blocks[1]?.text ?? "", /Phosphorylierung/);
  });

  it("extracts DOCX paragraphs with stable numbering + footnotes", async () => {
    const doc = await extractDocument("docx", fixture("sample.docx"));
    const texts = doc.blocks.map((block) => block.text);

    assert.equal(doc.blocks.length, 4);
    assert.deepEqual(doc.blocks[0]?.ref, {
      kind: "paragraph",
      paragraph: 1,
    });
    assert.deepEqual(doc.blocks[2]?.ref, {
      kind: "paragraph",
      paragraph: 4,
    });
    assert.match(texts[0] ?? "", /Bastille/);
    assert.match(texts[1] ?? "", /Menschen- und Bürgerrechte/);
    // XML entities are unescaped, not leaked.
    assert.match(texts[2] ?? "", /Forschung & Freiheit/);
    assert.ok(!(texts[2] ?? "").includes("&amp;"));
    assert.match(texts[3] ?? "", /Fußnoten: Bastille/);
  });

  it("extracts PPTX slides and skips textless slides", async () => {
    const doc = await extractDocument("pptx", fixture("sample.pptx"));

    assert.equal(doc.blocks.length, 2);
    assert.deepEqual(doc.blocks[0]?.ref, { kind: "slide", slide: 1 });
    assert.deepEqual(doc.blocks[1]?.ref, { kind: "slide", slide: 2 });
    assert.match(doc.blocks[0]?.text ?? "", /Trägheitsprinzip/);
    assert.match(doc.blocks[1]?.text ?? "", /Masse mal Beschleunigung/);
  });

  it("groups TXT into line blocks", async () => {
    const doc = await extractDocument("txt", fixture("sample.txt"));

    assert.equal(doc.blocks.length, 2);
    assert.deepEqual(doc.blocks[0]?.ref, {
      kind: "lines",
      start: 1,
      end: 50,
    });
    assert.deepEqual(doc.blocks[1]?.ref, {
      kind: "lines",
      start: 51,
      end: 65,
    });
    assert.match(doc.blocks[0]?.text ?? "", /Periodensystem/);
  });

  it("rejects unknown kinds", async () => {
    const error = await extractErrorOf(
      "xlsx",
      new Uint8Array([1, 2, 3]),
    );

    assert.equal(error.code, "unsupported-kind");
  });

  it("rejects empty input", async () => {
    const error = await extractErrorOf("txt", new Uint8Array(0));

    assert.equal(error.code, "empty");
  });

  it("rejects oversized input", async () => {
    const error = await extractErrorOf(
      "txt",
      new Uint8Array(MAX_EXTRACT_BYTES + 1),
    );

    assert.equal(error.code, "too-large");
  });

  it("reports truncated archives as corrupt", async () => {
    const error = await extractErrorOf(
      "docx",
      fixture("sample.docx").slice(0, 100),
    );

    assert.equal(error.code, "corrupt");
  });

  it("reports checksum damage as corrupt", async () => {
    const bytes = fixture("sample.docx").slice();
    // Flip a byte deep inside the deflated document.xml payload.
    bytes[400] = (bytes[400] ?? 0) ^ 0xff;

    const error = await extractErrorOf("docx", bytes);

    assert.equal(error.code, "corrupt");
  });

  it("reports non-PDF bytes as corrupt", async () => {
    const error = await extractErrorOf(
      "pdf",
      new TextEncoder().encode("definitely not a pdf file"),
    );

    assert.equal(error.code, "corrupt");
  });

  it("reports password-protected PDFs as encrypted", async () => {
    const error = await extractErrorOf(
      "pdf",
      new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Encrypt 5 0 R >>\nendobj\n"),
    );

    assert.equal(error.code, "encrypted");
  });

  it("reports legacy/protected Office files as encrypted", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const error = await extractErrorOf("docx", ole);

    assert.equal(error.code, "encrypted");
  });

  it("reports textless PDFs as scanned", async () => {
    const emptyPdf = [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 11 >> stream",
      "BT 0 0 Td ET",
      "endstream endobj",
      "trailer << /Root 1 0 R >>",
    ].join("\n");
    const error = await extractErrorOf(
      "pdf",
      new TextEncoder().encode(emptyPdf),
    );

    assert.equal(error.code, "scanned");
  });

  it("reports textless DOCX as empty", async () => {
    // Minimal stored (uncompressed) zip with a run-free document.
    const name = new TextEncoder().encode("word/document.xml");
    const payload = new TextEncoder().encode(
      '<?xml version="1.0"?><w:document xmlns:w="urn:x"><w:body><w:p><w:r></w:r></w:p></w:body></w:document>',
    );
    const bytes = new Uint8Array(30 + name.length + payload.length + 46 + name.length + 22);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(26, name.length, true);
    bytes.set(name, 30);
    bytes.set(payload, 30 + name.length);
    // CRC of the payload (IEEE): computed once, hardcoded honestly.
    view.setUint32(14, crc32Of(payload), true);
    view.setUint32(18, payload.length, true);
    view.setUint32(22, payload.length, true);
    const central = 30 + name.length + payload.length;
    view.setUint32(central, 0x02014b50, true);
    view.setUint16(central + 4, 20, true);
    view.setUint16(central + 6, 20, true);
    view.setUint32(central + 16, crc32Of(payload), true);
    view.setUint32(central + 20, payload.length, true);
    view.setUint32(central + 24, payload.length, true);
    view.setUint16(central + 28, name.length, true);
    view.setUint32(central + 42, 0, true);
    bytes.set(name, central + 46);
    const eocd = central + 46 + name.length;
    view.setUint32(eocd, 0x06054b50, true);
    view.setUint16(eocd + 8, 1, true);
    view.setUint16(eocd + 10, 1, true);
    view.setUint32(eocd + 12, 46 + name.length, true);
    view.setUint32(eocd + 16, central, true);

    const error = await extractErrorOf("docx", bytes);

    assert.equal(error.code, "empty");
  });

  it("reports whitespace-only text as empty", async () => {
    const error = await extractErrorOf(
      "txt",
      new TextEncoder().encode("  \n \n"),
    );

    assert.equal(error.code, "empty");
  });
});

describe("source refs", () => {
  it("formats single refs", () => {
    assert.equal(formatSourceRef({ kind: "page", page: 3 }), "Seite 3");
    assert.equal(formatSourceRef({ kind: "slide", slide: 5 }), "Folie 5");
    assert.equal(
      formatSourceRef({ kind: "paragraph", paragraph: 12 }),
      "Absatz 12",
    );
    assert.equal(
      formatSourceRef({ kind: "lines", start: 4, end: 9 }),
      "Zeilen 4–9",
    );
  });

  it("merges consecutive refs into ranges", () => {
    assert.equal(
      formatSourceRefs([
        { kind: "page", page: 3 },
        { kind: "page", page: 4 },
        { kind: "page", page: 5 },
      ]),
      "Seiten 3–5",
    );
    assert.equal(
      formatSourceRefs([
        { kind: "slide", slide: 1 },
        { kind: "slide", slide: 3 },
      ]),
      "Folie 1, Folie 3",
    );
    assert.equal(
      formatSourceRefs([
        { kind: "paragraph", paragraph: 1 },
        { kind: "paragraph", paragraph: 2 },
      ]),
      "Absätze 1–2",
    );
  });

  it("joins blocks back to preview text", () => {
    assert.equal(
      blocksToText([
        { text: "eins", ref: { kind: "page", page: 1 } },
        { text: "zwei", ref: { kind: "page", page: 2 } },
      ]),
      "eins\n\nzwei",
    );
  });
});
