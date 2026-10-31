/**
 * Client/server questions contract: the cloud branch of
 * `generateQuestionsForDocument` sends `coveredRefs` and accepts
 * the windowed response (window + coverage) unchanged.
 *
 * The mode switch is import-time, so this file sets the env flag
 * before the dynamic import and never imports studyActions
 * statically. The local branch needs IndexedDB and stays
 * browser-only (covered manually, same shared selector).
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const realFetch = globalThis.fetch;
const SAVED_MODE = process.env.NEXT_PUBLIC_CLOUD_ENABLED;

let seenBody: unknown = null;

beforeEach(() => {
  seenBody = null;
  process.env.NEXT_PUBLIC_CLOUD_ENABLED = "1";
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    if (String(input) === "/api/study/questions") {
      seenBody = JSON.parse(String(init?.body ?? "null")) as unknown;

      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            questions: [],
            documentId: "doc-1",
            documentName: "Skript.pdf",
            subject: null,
            refsUsed: [],
            truncated: true,
            chunkCount: 8,
            insufficient: false,
            droppedInvalid: 0,
            partial: true,
            window: { labels: ["Folie 1", "Folie 8"], poolSize: 8, truncated: true },
            coverage: { usableUnits: 8, coveredUnits: 0, percent: 0 },
          },
        }),
        { status: 200 },
      );
    }

    if (String(input).startsWith("/api/study/coverage")) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            documentId: "doc-1",
            totalPages: 8,
            usableUnits: 4,
            coveredUnits: 3,
            percent: 75,
            questionCount: 3,
            target: 4,
          },
        }),
        { status: 200 },
      );
    }

    throw new Error(`unstubbed fetch: ${String(input)}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;

  if (SAVED_MODE === undefined) delete process.env.NEXT_PUBLIC_CLOUD_ENABLED;
  else process.env.NEXT_PUBLIC_CLOUD_ENABLED = SAVED_MODE;
});

describe("generateQuestionsForDocument cloud branch", () => {
  it("sends coveredRefs and keeps window/coverage", async () => {
    const { generateQuestionsForDocument } = await import(
      "@/src/lib/db/studyActions"
    );

    const response = await generateQuestionsForDocument(
      "doc-1",
      "de",
      2,
      fetch,
      undefined,
      ["Seite 1"],
    );

    assert.deepEqual(seenBody, {
      documentId: "doc-1",
      locale: "de",
      count: 2,
      coveredRefs: ["Seite 1"],
    });
    assert.deepEqual(response.window, {
      labels: ["Folie 1", "Folie 8"],
      poolSize: 8,
      truncated: true,
    });
    assert.deepEqual(response.coverage, {
      usableUnits: 8,
      coveredUnits: 0,
      percent: 0,
    });
  });

  it("reads the coverage snapshot through the guard", async () => {
    const { getDocumentCoverage } = await import("@/src/lib/db/studyActions");

    const coverage = await getDocumentCoverage("doc-1", ["Folie 1"], 3);

    assert.deepEqual(coverage, {
      documentId: "doc-1",
      totalPages: 8,
      usableUnits: 4,
      coveredUnits: 3,
      percent: 75,
      questionCount: 3,
      target: 4,
    });
  });
});
