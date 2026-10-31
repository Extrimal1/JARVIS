/**
 * Document metadata: the page/slide total survives the metadata
 * guard whether it is present, null, or absent (pre-totals rows).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDocumentMeta } from "@/src/lib/documents";

function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc-1",
    name: "Skript.pdf",
    mimeType: "application/pdf",
    size: 1024,
    kind: "pdf",
    subject: null,
    description: "",
    uploadedAt: "2026-10-31T10:00:00.000Z",
    extractionStatus: "completed",
    ...overrides,
  };
}

describe("isDocumentMeta pageCount", () => {
  it("accepts records with a total, null, or no total", () => {
    assert.equal(isDocumentMeta(meta({ pageCount: 120 })), true);
    assert.equal(isDocumentMeta(meta({ pageCount: null })), true);
    assert.equal(isDocumentMeta(meta()), true);
  });

  it("still rejects records with broken required fields", () => {
    assert.equal(isDocumentMeta(meta({ id: "" })), false);
    assert.equal(isDocumentMeta(meta({ extractionStatus: "fertig" })), false);
  });
});
