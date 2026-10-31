/**
 * Summary client/server contracts: the cloud branches send the
 * documented bodies and accept windowed batch, synthesis, and
 * summary-record responses through the guards.
 *
 * Import-time mode switch: env is set before the dynamic import
 * (same pattern as the questions parity suite). The local
 * branches need IndexedDB and stay browser-only.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;
const SAVED_MODE = process.env.NEXT_PUBLIC_CLOUD_ENABLED;

let seenBatch: unknown = null;
let seenSynthesis: unknown = null;

beforeEach(() => {
  seenBatch = null;
  seenSynthesis = null;
  process.env.NEXT_PUBLIC_CLOUD_ENABLED = "1";
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);

    if (url === "/api/study/summarize/batch") {
      seenBatch = JSON.parse(String(init?.body ?? "null")) as unknown;

      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            documentId: "doc-1",
            generationId: "11111111-1111-4111-8111-111111111111",
            span: {
              key: "slide:1-2",
              label: "Folien 1–2",
              index: 0,
              total: 2,
            },
            text: "Text (Folie 1).",
            refs: ["Folie 1"],
            processedUnits: 2,
            usableUnits: 4,
            percent: 50,
            done: false,
          },
        }),
        { status: 200 },
      );
    }

    if (url === "/api/study/summarize/synthesize") {
      seenSynthesis = JSON.parse(String(init?.body ?? "null")) as unknown;

      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            documentId: "doc-1",
            generationId: "11111111-1111-4111-8111-111111111111",
            text: "Final.",
            refs: ["Folien 1–2"],
            complete: true,
            levels: 1,
          },
        }),
        { status: 200 },
      );
    }

    if (url === "/api/summaries") {
      return new Response(
        JSON.stringify({
          ok: true,
          data: [
            {
              id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
              documentId: "doc-1",
              status: "partial",
              active: null,
              draft: {
                generationId: "11111111-1111-4111-8111-111111111111",
                plannedSpans: [],
                spans: [],
                preview: null,
                startedAt: "2026-10-31T09:00:00.000Z",
              },
            },
          ],
        }),
        { status: 200 },
      );
    }

    throw new Error(`unstubbed fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;

  if (SAVED_MODE === undefined) delete process.env.NEXT_PUBLIC_CLOUD_ENABLED;
  else process.env.NEXT_PUBLIC_CLOUD_ENABLED = SAVED_MODE;
});

describe("summary cloud branches", () => {
  it("requests the next span with the generation id", async () => {
    const { summarizeNextSpan } = await import("@/src/lib/db/studyActions");

    const response = await summarizeNextSpan("doc-1", "de", null);

    assert.deepEqual(seenBatch, {
      documentId: "doc-1",
      locale: "de",
      generationId: null,
    });
    assert.equal(response.span.key, "slide:1-2");
    assert.equal(response.percent, 50);
  });

  it("requests synthesis for one generation", async () => {
    const { synthesizeDocumentSummary } = await import(
      "@/src/lib/db/studyActions"
    );

    const response = await synthesizeDocumentSummary(
      "doc-1",
      "de",
      "11111111-1111-4111-8111-111111111111",
    );

    assert.deepEqual(seenSynthesis, {
      documentId: "doc-1",
      locale: "de",
      generationId: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(response.complete, true);
  });

  it("reads one document summary from the row list", async () => {
    const { getSummaryState } = await import("@/src/lib/db/studyActions");

    const state = await getSummaryState("doc-1");

    assert.equal(
      state?.draft?.generationId,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(await getSummaryState("other"), null);
  });
});
