/**
 * Topic-extraction server tests: validators plus the real span
 * loop against a stubbed Supabase HTTP layer (scripted Ollama).
 * Anything hitting an unstubbed URL fails the test.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractTopics,
  validTopicExtractInput,
} from "@/src/lib/api/modules/topicIntel";
import { dbFor } from "@/src/lib/supabase/db";
import { isTopicsExtractResponse } from "@/src/lib/study/protocol";

const DB = dbFor(
  { url: "https://supabase.test", anonKey: "anon" },
  "token",
  "user-1",
);

const DOC_ROW = {
  id: "doc-1",
  name: "Vorlesung.pptx",
  extraction_status: "completed",
};

const CHUNK_ROWS = [1, 2, 3, 4].map((slide) => ({
  id: `s${slide}`,
  document_id: "doc-1",
  chunk_index: slide - 1,
  content: `FOLIE-${slide}-TEXT ${"x".repeat(1500)}`,
  source_refs: [{ kind: "slide", slide }],
}));

type FetchArgs = { url: string; method: string; body: string | null };
type Route = {
  match: (args: FetchArgs) => boolean;
  respond: (args: FetchArgs) => Response;
};

let routes: Route[] = [];
let hits: FetchArgs[] = [];
const realFetch = globalThis.fetch;
const SAVED_MODEL = process.env.OLLAMA_MODEL;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

beforeEach(() => {
  routes = [];
  hits = [];
  process.env.OLLAMA_MODEL = "qwen3.5:4b";
  globalThis.fetch = (async (input: unknown, init?: {
    method?: string;
    body?: unknown;
  }) => {
    const args: FetchArgs = {
      url: String(input),
      method: init?.method ?? "GET",
      body:
        typeof init?.body === "string"
          ? init.body
          : init?.body === undefined
            ? null
            : "<binary>",
    };
    hits.push(args);

    const route = routes.find((candidate) => candidate.match(args));

    if (route === undefined) {
      throw new Error(`unstubbed fetch: ${args.method} ${args.url}`);
    }

    return route.respond(args);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;

  if (SAVED_MODEL === undefined) delete process.env.OLLAMA_MODEL;
  else process.env.OLLAMA_MODEL = SAVED_MODEL;
});

function onRest(
  method: string,
  table: string,
  respond: (args: FetchArgs) => Response,
): void {
  routes.push({
    match: (args) =>
      args.method === method &&
      args.url.startsWith(`https://supabase.test/rest/v1/${table}`),
    respond,
  });
}

function stubDocAndChunks(): void {
  onRest("GET", "study_documents", () => json([DOC_ROW]));
  onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
}

function topicJson(name: string, marker: string): string {
  return JSON.stringify({
    topics: [
      {
        name,
        summary: `${name} kurz.`,
        concepts: [`${name}-Begriff`],
        formulas: [],
        examples: [],
        prerequisites: [],
        parent: null,
        refs: [marker],
      },
    ],
  });
}

describe("validTopicExtractInput", () => {
  it("accepts valid input and caps spans", () => {
    assert.deepEqual(
      validTopicExtractInput({
        documentId: "doc-1",
        locale: "de",
        coveredLabels: ["Folien 1–2"],
        maxSpans: 99,
      }),
      {
        documentId: "doc-1",
        locale: "de",
        coveredLabels: ["Folien 1–2"],
        maxSpans: 6,
      },
    );
    assert.equal(validTopicExtractInput(null), null);
    assert.equal(
      validTopicExtractInput({
        documentId: "doc-1",
        locale: "en",
        coveredLabels: [],
      }),
      null,
    );
    assert.equal(
      validTopicExtractInput({
        documentId: "doc-1",
        locale: "de",
        coveredLabels: "Folien 1–2",
      }),
      null,
    );
  });
});

describe("extractTopics", () => {
  it("extracts grounded topics across spans", async () => {
    stubDocAndChunks();
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: (() => {
        const bodies = [
          topicJson("Zinsrechnung", "[Q1]"),
          topicJson("Rentenrechnung", "[Q2]"),
        ];
        let index = 0;

        return () =>
          json({
            message: {
              content: bodies[Math.min(index++, bodies.length - 1)],
            },
          });
      })(),
    });

    const outcome = await extractTopics(DB, {
      documentId: "doc-1",
      locale: "de",
      coveredLabels: [],
      maxSpans: 6,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;
    assert.ok(isTopicsExtractResponse(outcome.response));
    assert.equal(outcome.response.topics.length, 2);
    assert.deepEqual(
      outcome.response.topics.map((topic) => topic.name),
      ["Zinsrechnung", "Rentenrechnung"],
    );
    // Span 1 holds chunks 1-2, span 2 holds chunks 3-4: markers
    // resolve to per-span source labels.
    assert.deepEqual(outcome.response.topics[0]?.refs, ["Folie 1"]);
    assert.deepEqual(outcome.response.topics[1]?.refs, ["Folie 4"]);
    assert.equal(outcome.response.done, true);
    assert.equal(outcome.response.repaired, false);
    assert.deepEqual(outcome.response.skippedSpans, []);

    const bodies = hits
      .filter((hit) => hit.url.includes("11434"))
      .map((hit) => hit.body ?? "");

    assert.equal(bodies.length, 2);
    assert.ok(
      bodies.every(
        (body) =>
          body.includes('"format":"json"') && body.includes('"think":false'),
      ),
    );
  });

  it("resumes from covered labels without regenerating", async () => {
    stubDocAndChunks();
    let calls = 0;
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () => {
        calls += 1;

        return json({ message: { content: topicJson("Rente", "[Q1]") } });
      },
    });

    const outcome = await extractTopics(DB, {
      documentId: "doc-1",
      locale: "de",
      coveredLabels: ["Folien 1–2"],
      maxSpans: 6,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(calls, 1);
    assert.deepEqual(outcome.response.spansDone, ["Folien 3–4"]);
    assert.equal(outcome.response.done, true);
  });

  it("skips truncated spans and continues honestly", async () => {
    stubDocAndChunks();
    let calls = 0;
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () => {
        calls += 1;

        if (calls === 1) {
          return json({
            message: { content: "" },
            done: true,
            done_reason: "length",
            eval_count: 2000,
          });
        }

        return json({ message: { content: topicJson("Rente", "[Q1]") } });
      },
    });

    const outcome = await extractTopics(DB, {
      documentId: "doc-1",
      locale: "de",
      coveredLabels: [],
      maxSpans: 6,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.deepEqual(outcome.response.skippedSpans, ["Folien 1–2"]);
    assert.deepEqual(outcome.response.spansDone, ["Folien 3–4"]);
    assert.equal(outcome.response.topics.length, 1);
    // Skipped spans stay retryable: not done.
    assert.equal(outcome.response.done, false);
  });

  it("repairs malformed JSON once, then skips on failure", async () => {
    stubDocAndChunks();
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: (() => {
        const bodies = [
          "Nur Prosa, kein JSON.",
          topicJson("Zinsrechnung", "[Q1]"),
          "Weiterhin kein JSON.",
          "Immer noch keins.",
        ];
        let index = 0;

        return () =>
          json({
            message: {
              content: bodies[Math.min(index++, bodies.length - 1)],
            },
          });
      })(),
    });

    const outcome = await extractTopics(DB, {
      documentId: "doc-1",
      locale: "de",
      coveredLabels: [],
      maxSpans: 6,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.topics.length, 1);
    assert.equal(outcome.response.repaired, true);
    assert.deepEqual(outcome.response.spansDone, ["Folien 1–2"]);
    assert.deepEqual(outcome.response.skippedSpans, ["Folien 3–4"]);
    assert.equal(outcome.response.done, false);
    assert.equal(
      hits.filter((hit) => hit.url.includes("11434")).length,
      4,
    );
  });

  it("drops ungrounded topics with counts", async () => {
    stubDocAndChunks();
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () =>
        json({
          message: {
            content: JSON.stringify({
              topics: [
                { name: "Erfunden", refs: ["Folie 99"] },
                { name: "Zinsrechnung", refs: ["[Q1]"] },
              ],
            }),
          },
        }),
    });

    const outcome = await extractTopics(DB, {
      documentId: "doc-1",
      locale: "de",
      coveredLabels: ["Folien 3–4"],
      maxSpans: 6,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.topics.length, 1);
    assert.equal(outcome.response.droppedUngrounded, 1);
  });

  it("returns 404/409/insufficient without calling the model", async () => {
    onRest("GET", "study_documents", () => json([]));

    assert.deepEqual(
      await extractTopics(DB, {
        documentId: "doc-1",
        locale: "de",
        coveredLabels: [],
        maxSpans: 6,
      }),
      { ok: false, http: 404, message: "Dokument nicht gefunden." },
    );

    routes.length = 0;
    onRest("GET", "study_documents", () =>
      json([{ ...DOC_ROW, extraction_status: "processing" }]),
    );

    assert.deepEqual(
      await extractTopics(DB, {
        documentId: "doc-1",
        locale: "de",
        coveredLabels: [],
        maxSpans: 6,
      }),
      { ok: false, http: 409, message: "Das Dokument ist noch nicht verarbeitet." },
    );

    routes.length = 0;
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json([]));

    const empty = await extractTopics(DB, {
      documentId: "doc-1",
      locale: "de",
      coveredLabels: [],
      maxSpans: 6,
    });

    assert.equal(empty.ok, true);

    if (!empty.ok) return;

    assert.equal(empty.response.insufficient, true);
    assert.equal(empty.response.done, true);
    assert.ok(hits.every((hit) => !hit.url.includes("11434")));
  });
});
