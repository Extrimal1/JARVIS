/**
 * Study-intelligence server tests: validators plus the real
 * process/retrieve/summarize/explain pipeline against a stubbed
 * Supabase HTTP layer (real fixture bytes, scripted Ollama).
 * Anything hitting an unstubbed URL fails the test — including
 * unexpected LLM calls.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  explainStudyDoc,
  processStudyDoc,
  retrieveStudyChunks,
  summarizeStudyDoc,
  validExplainInput,
  validRetrieveInput,
  validSummarizeInput,
} from "@/src/lib/api/modules/studyIntel";
import { dbFor } from "@/src/lib/supabase/db";

const DB = dbFor(
  { url: "https://supabase.test", anonKey: "anon" },
  "token",
  "user-1",
);

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
  );
}

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

function ollamaWith(contents: string[]): void {
  let index = 0;

  routes.push({
    match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
    respond: () =>
      json({
        message: {
          content: contents[Math.min(index++, contents.length - 1)],
        },
      }),
  });
}

describe("study validators", () => {
  it("validates retrieval input", () => {
    assert.deepEqual(
      validRetrieveInput({ query: "Bastille", limit: 3 }),
      { query: "Bastille", documentId: undefined, limit: 3 },
    );
    assert.equal(validRetrieveInput({ query: "" }), null);
    assert.equal(validRetrieveInput({ query: "x", limit: 11 }), null);
    assert.equal(validRetrieveInput({ query: "x".repeat(501) }), null);
    assert.equal(validRetrieveInput(null), null);
  });

  it("validates summarize/explain input", () => {
    assert.deepEqual(
      validSummarizeInput({ documentId: "d", locale: "ru" }),
      { documentId: "d", locale: "ru" },
    );
    assert.equal(validSummarizeInput({ documentId: "d", locale: "en" }), null);
    assert.equal(validSummarizeInput({ documentId: "", locale: "de" }), null);
    assert.deepEqual(
      validExplainInput({ documentId: "d", question: "Warum?", locale: "de" }),
      { documentId: "d", question: "Warum?", locale: "de" },
    );
    assert.equal(
      validExplainInput({ documentId: "d", question: "  ", locale: "de" }),
      null,
    );
  });
});

describe("retrieveStudyChunks", () => {
  it("ranks owned chunks and joins document names", async () => {
    let sawFilter = "";
    onRest("GET", "retrieval_chunks", (args) => {
      sawFilter = args.url;

      return json([
        {
          id: "c1",
          document_id: "doc-1",
          chunk_index: 0,
          content: "Die Französische Revolution begann 1789.",
          source_refs: [{ kind: "paragraph", paragraph: 1 }],
        },
        {
          id: "c2",
          document_id: "doc-1",
          chunk_index: 1,
          content: "Newton formulierte die Gravitation.",
          source_refs: [{ kind: "paragraph", paragraph: 2 }],
        },
      ]);
    });
    onRest("GET", "study_documents", () =>
      json([
        {
          id: "doc-1",
          name: "Geschichte.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: 975,
          kind: "docx",
          subject: null,
          description: "",
          uploaded_at: "2026-10-30T10:00:00.000Z",
          extraction_status: "completed",
        },
      ]),
    );

    const result = await retrieveStudyChunks(DB, {
      query: "Französische Revolution",
      documentId: "doc-1",
      limit: 5,
    });

    assert.match(sawFilter, /document_id=eq\.doc-1/);
    assert.equal(result.totalCandidates, 2);
    assert.deepEqual(result.terms, ["französische", "revolution"]);
    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0]?.chunkId, "c1");
    assert.equal(result.chunks[0]?.documentName, "Geschichte.docx");
    assert.equal(result.chunks[0]?.refLabel, "Absatz 1");
    assert.deepEqual(result.chunks[0]?.matchedTerms, [
      "französische",
      "revolution",
    ]);
  });

  it("answers stopword-only queries without touching the database", async () => {
    const result = await retrieveStudyChunks(DB, { query: "was ist der" });

    assert.deepEqual(result, { chunks: [], totalCandidates: 0, terms: [] });
    assert.equal(hits.length, 0);
  });
});

describe("processStudyDoc", () => {
  const DOC_ROW = {
    id: "doc-1",
    user_id: "user-1",
    name: "Geschichte.docx",
    kind: "docx",
    storage_path: "user-1/doc-1/Geschichte.docx",
    extraction_status: "not_processed",
  };

  it("extracts, chunks, and stores with refs (real fixture bytes)", async () => {
    const statuses: string[] = [];
    let inserted: Record<string, unknown>[] = [];

    onRest("GET", "study_documents", () => json([DOC_ROW]));
    routes.push({
      match: (args) =>
        args.url ===
        "https://supabase.test/storage/v1/object/study-documents/user-1/doc-1/Geschichte.docx",
      respond: () =>
        new Response(fixture("sample.docx") as unknown as BodyInit),
    });
    onRest("DELETE", "retrieval_chunks", () => new Response(null, { status: 204 }));
    onRest("POST", "retrieval_chunks", (args) => {
      inserted = JSON.parse(args.body ?? "[]") as Record<string, unknown>[];

      return json(inserted);
    });
    routes.push({
      match: (args) => args.url.includes("/storage/v1/object/study-documents/"),
      respond: () => new Response(null, { status: 200 }),
    });
    onRest("PATCH", "study_documents", (args) => {
      const body = JSON.parse(args.body ?? "{}") as Record<string, unknown>;
      statuses.push(String(body.extraction_status));

      return json([{ ...DOC_ROW, extraction_status: body.extraction_status }]);
    });

    const outcome = await processStudyDoc(DB, "user-1", "doc-1");

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.status, "completed");
    assert.equal(outcome.response.blocks, 4);
    assert.equal(outcome.response.chunks, 1);
    assert.deepEqual(statuses[statuses.length - 1], "completed");

    const chunk = inserted[0];
    assert.equal(chunk?.document_id, "doc-1");
    assert.equal(chunk?.chunk_index, 0);
    assert.match(String(chunk?.content ?? ""), /Bastille/);
    assert.ok((chunk?.token_count as number) > 0);
    assert.deepEqual(chunk?.source_refs, [
      { kind: "paragraph", paragraph: 1 },
      { kind: "paragraph", paragraph: 2 },
      { kind: "paragraph", paragraph: 4 },
    ]);
  });

  it("marks corrupt files failed without inserting chunks", async () => {
    let inserts = 0;
    let finalStatus = "";

    onRest("GET", "study_documents", () => json([DOC_ROW]));
    routes.push({
      match: (args) => args.url.includes("/storage/v1/object/"),
      respond: () => new Response(new Uint8Array([1, 2, 3]) as unknown as BodyInit),
    });
    onRest("POST", "retrieval_chunks", () => {
      inserts += 1;

      return json([]);
    });
    onRest("PATCH", "study_documents", (args) => {
      const body = JSON.parse(args.body ?? "{}") as Record<string, unknown>;
      finalStatus = String(body.extraction_status);

      return json([DOC_ROW]);
    });

    const outcome = await processStudyDoc(DB, "user-1", "doc-1");

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.status, "failed");
    assert.equal(inserts, 0);
    assert.equal(finalStatus, "failed");
  });

  it("returns 404 for unknown documents", async () => {
    onRest("GET", "study_documents", () => json([]));

    const outcome = await processStudyDoc(DB, "user-1", "missing");

    assert.deepEqual(outcome, {
      ok: false,
      http: 404,
      message: "Dokument nicht gefunden.",
    });
  });
});

describe("explainStudyDoc", () => {
  it("answers insufficient evidence deterministically (no LLM call)", async () => {
    onRest("GET", "study_documents", () =>
      json([
        {
          id: "doc-1",
          name: "Bio.pdf",
          extraction_status: "completed",
        },
      ]),
    );
    onRest("GET", "retrieval_chunks", () =>
      json([
        {
          id: "c1",
          document_id: "doc-1",
          chunk_index: 0,
          content: "Die Glykolyse spaltet Glukose.",
          source_refs: [{ kind: "page", page: 1 }],
        },
      ]),
    );

    const outcome = await explainStudyDoc(DB, {
      documentId: "doc-1",
      question: "Wer gewann die Fußball-WM?",
      locale: "de",
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.insufficient, true);
    assert.match(outcome.response.answer, /nichts Passendes gefunden/);
    assert.ok(!outcome.response.answer.includes("[Q"));
    // No Ollama route registered: any LLM call would throw.
    assert.ok(hits.every((hit) => !hit.url.includes("11434")));
  });
});

describe("summarizeStudyDoc", () => {
  const DOC_ROW = {
    id: "doc-1",
    name: "Skript.pdf",
    extraction_status: "completed",
  };
  const CHUNK_ROWS = [
    {
      id: "c1",
      document_id: "doc-1",
      chunk_index: 0,
      content: "Der Citratzyklus läuft in den Mitochondrien ab.",
      source_refs: [{ kind: "page", page: 3 }],
    },
  ];

  function stubDocAndChunks(): void {
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
  }

  it("summarizes with repaired citations and real refs", async () => {
    stubDocAndChunks();
    ollamaWith([
      "Zusammenfassung mit Bluff [Q2].",
      "Zusammenfassung sauber [Q1].",
    ]);

    const outcome = await summarizeStudyDoc(DB, {
      documentId: "doc-1",
      locale: "de",
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.documentName, "Skript.pdf");
    assert.deepEqual(outcome.response.refsUsed, ["Seite 3"]);
    assert.equal(outcome.response.truncated, false);
    assert.equal(outcome.response.summary, "Zusammenfassung sauber [Q1].");
  });

  it("strips unrepairable citations with a visible note", async () => {
    stubDocAndChunks();
    ollamaWith(["Bluff [Q5].", "Weiter Bluff [Q6]."]);

    const outcome = await summarizeStudyDoc(DB, {
      documentId: "doc-1",
      locale: "de",
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    const [body] = outcome.response.summary.split("Hinweis:");
    assert.ok(!(body ?? "").includes("[Q"));
    assert.match(outcome.response.summary, /konnten nicht verifiziert/);
  });

  it("refuses unprocessed documents without calling the LLM", async () => {
    onRest("GET", "study_documents", () =>
      json([{ ...DOC_ROW, extraction_status: "processing" }]),
    );

    const outcome = await summarizeStudyDoc(DB, {
      documentId: "doc-1",
      locale: "de",
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.match(outcome.response.summary, /noch nicht verarbeitet/);
    assert.ok(hits.every((hit) => !hit.url.includes("11434")));
  });
});
