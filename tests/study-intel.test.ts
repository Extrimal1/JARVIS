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
  generationLockKey,
  getStudyCoverage,
  processStudyDoc,
  releaseGenerationLock,
  retrieveStudyChunks,
  summarizeNextSpan,
  summarizeStudyDoc,
  synthesizeSummary,
  tryAcquireGenerationLock,
  validExplainInput,
  validRetrieveInput,
  validSummarizeInput,
  validSummaryBatchInput,
  validSynthesizeInput,
} from "@/src/lib/api/modules/studyIntel";
import { ProviderError } from "@/src/lib/assistant/llm";
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

describe("getStudyCoverage", () => {
  const DOC_ROW = {
    id: "doc-1",
    name: "Vorlesung.pptx",
    extraction_status: "completed",
    page_count: 8,
  };
  const CHUNK_ROWS = [1, 2, 3, 4].map((slide) => ({
    id: `s${slide}`,
    document_id: "doc-1",
    chunk_index: slide - 1,
    content: `Inhalt Folie ${slide}.`,
    source_refs: [{ kind: "slide", slide }],
  }));

  it("derives usable/covered units from chunks and question labels", async () => {
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
    onRest("GET", "quiz_questions", () =>
      json([
        { id: "q1", source_refs: ["Folie 1"] },
        { id: "q2", source_refs: ["Folien 3–4"] },
        { id: "q3", source_refs: [] },
      ]),
    );

    const outcome = await getStudyCoverage(DB, "doc-1");

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.deepEqual(outcome.coverage, {
      documentId: "doc-1",
      totalPages: 8,
      usableUnits: 4,
      coveredUnits: 3,
      percent: 75,
      questionCount: 3,
      target: 4,
    });
    assert.ok(hits.every((hit) => !hit.url.includes("11434")));
  });

  it("reports honest zeros when nothing usable exists", async () => {
    onRest("GET", "study_documents", () =>
      json([{ ...DOC_ROW, page_count: null }]),
    );
    onRest("GET", "retrieval_chunks", () => json([]));
    onRest("GET", "quiz_questions", () =>
      json([{ id: "q1", source_refs: ["Folie 1"] }]),
    );

    const outcome = await getStudyCoverage(DB, "doc-1");

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.deepEqual(outcome.coverage, {
      documentId: "doc-1",
      totalPages: null,
      usableUnits: 0,
      coveredUnits: 0,
      percent: 0,
      questionCount: 1,
      target: 0,
    });
  });

  it("returns 404 for unknown documents", async () => {
    onRest("GET", "study_documents", () => json([]));

    const outcome = await getStudyCoverage(DB, "missing");

    assert.deepEqual(outcome, {
      ok: false,
      http: 404,
      message: "Dokument nicht gefunden.",
    });
  });
});

describe("summary validators", () => {
  it("validates batch and synthesize input", () => {
    assert.deepEqual(
      validSummaryBatchInput({ documentId: "d", locale: "de" }),
      { documentId: "d", locale: "de", generationId: null },
    );
    assert.deepEqual(
      validSummaryBatchInput({
        documentId: "d",
        locale: "ru",
        generationId: "11111111-1111-4111-8111-111111111111",
      }),
      {
        documentId: "d",
        locale: "ru",
        generationId: "11111111-1111-4111-8111-111111111111",
      },
    );
    assert.equal(
      validSummaryBatchInput({
        documentId: "d",
        locale: "de",
        generationId: "stale",
      }),
      null,
    );
    assert.deepEqual(
      validSynthesizeInput({
        documentId: "d",
        locale: "de",
        generationId: "11111111-1111-4111-8111-111111111111",
      }),
      {
        documentId: "d",
        locale: "de",
        generationId: "11111111-1111-4111-8111-111111111111",
      },
    );
    assert.equal(
      validSynthesizeInput({ documentId: "d", locale: "de" }),
      null,
    );
  });
});

describe("summarizeNextSpan", () => {
  const GEN = "11111111-1111-4111-8111-111111111111";
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

  function summaryRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "sum-1",
      user_id: "user-1",
      document_id: "doc-1",
      status: "partial",
      active_final_md: "",
      active_final_refs: [],
      active_completed_at: null,
      draft_generation_id: GEN,
      draft_planned: [
        { key: "slide:1-2", label: "Folien 1–2", order: 0 },
        { key: "slide:3-4", label: "Folien 3–4", order: 1 },
      ],
      draft_spans: [],
      draft_preview_md: "",
      draft_preview_refs: [],
      draft_started_at: "2026-10-31T09:00:00.000Z",
      ...overrides,
    };
  }

  function stubDocAndChunks(): void {
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
  }

  it("creates a draft and persists the first span", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () => json([]));
    let inserted: Record<string, unknown> = {};
    onRest("POST", "study_summaries", (args) => {
      const rows = JSON.parse(args.body ?? "[]") as Record<string, unknown>[];
      inserted = rows[0] ?? {};

      return json([inserted]);
    });
    const patches: Record<string, unknown>[] = [];
    onRest("PATCH", "study_summaries", (args) => {
      patches.push(JSON.parse(args.body ?? "{}") as Record<string, unknown>);

      return json([{}]);
    });
    ollamaWith(["Überblick [Q1] und Details [Q2]."]);

    const outcome = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: null,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.span.key, "slide:1-2");
    assert.equal(outcome.response.span.label, "Folien 1–2");
    assert.equal(outcome.response.span.index, 0);
    assert.equal(outcome.response.span.total, 2);
    assert.equal(
      outcome.response.text,
      "Überblick (Folie 1) und Details (Folie 2).",
    );
    assert.deepEqual(outcome.response.refs, ["Folie 1", "Folie 2"]);
    assert.equal(outcome.response.processedUnits, 2);
    assert.equal(outcome.response.usableUnits, 4);
    assert.equal(outcome.response.percent, 50);
    assert.equal(outcome.response.done, false);
    assert.ok(typeof inserted.draft_generation_id === "string");
    assert.equal(
      outcome.response.generationId,
      inserted.draft_generation_id,
    );
    assert.equal(patches.length, 1);
    assert.equal(
      (patches[0]?.draft_spans as unknown[]).length,
      1,
    );
  });

  it("resumes a matching draft and prunes stale spans", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () =>
      json([
        summaryRow({
          draft_spans: [
            {
              key: "slide:9-9",
              label: "Folie 9",
              text: "Alt.",
              refs: [],
              completedAt: "2026-10-30T10:00:00.000Z",
            },
            {
              key: "slide:1-2",
              label: "Folien 1–2",
              text: "Bereits da.",
              refs: ["Folie 1"],
              completedAt: "2026-10-31T10:00:00.000Z",
            },
          ],
        }),
      ]),
    );
    const patches: Record<string, unknown>[] = [];
    onRest("PATCH", "study_summaries", (args) => {
      patches.push(JSON.parse(args.body ?? "{}") as Record<string, unknown>);

      return json([{}]);
    });
    ollamaWith(["Zweiter Teil [Q1]."]);

    const outcome = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: GEN,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.span.key, "slide:3-4");
    assert.equal(outcome.response.span.index, 1);
    assert.equal(outcome.response.percent, 100);
    const spans = patches[0]?.draft_spans as { key: string }[];

    assert.deepEqual(
      spans.map((span) => span.key),
      ["slide:1-2", "slide:3-4"],
    );
  });

  it("retries a truncated span smaller and persists the subspan", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () => json([]));
    onRest("POST", "study_summaries", () => json([{}]));
    const patches: Record<string, unknown>[] = [];
    onRest("PATCH", "study_summaries", (args) => {
      patches.push(JSON.parse(args.body ?? "{}") as Record<string, unknown>);

      return json([{}]);
    });
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

        return json({ message: { content: "Teil eins [Q1]." } });
      },
    });

    const outcome = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: null,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(calls, 2);
    assert.equal(outcome.response.span.key, "slide:1");
    assert.equal(outcome.response.span.label, "Folie 1");
    assert.equal(outcome.response.text, "Teil eins (Folie 1).");
    assert.deepEqual(outcome.response.refs, ["Folie 1"]);
    assert.equal(outcome.response.attempts, 2);
    assert.equal(outcome.response.percent, 25);
    assert.equal(patches.length, 2);
    assert.deepEqual(patches[0]?.draft_splits, { "slide:1-2": 1 });
    assert.deepEqual(patches[0]?.draft_spans, []);
    assert.equal((patches[1]?.draft_spans as unknown[]).length, 1);

    const bodies = hits
      .filter((hit) => hit.url.includes("11434"))
      .map((hit) => hit.body ?? "");

    assert.ok(bodies[0]?.includes("FOLIE-1-TEXT"));
    assert.ok(bodies[0]?.includes("FOLIE-2-TEXT"));
    assert.ok(bodies[1]?.includes("FOLIE-1-TEXT"));
    assert.ok(!bodies[1]?.includes("FOLIE-2-TEXT"));
  });

  it("drills recursively on repeated truncation", async () => {
    const bigChunks = [1, 2, 3, 4, 5, 6, 7, 8].map((slide) => ({
      id: `s${slide}`,
      document_id: "doc-1",
      chunk_index: slide - 1,
      content: `FOLIE-${slide}-TEXT ${"x".repeat(1000)}`,
      source_refs: [{ kind: "slide", slide }],
    }));
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json(bigChunks));
    onRest("GET", "study_summaries", () => json([]));
    onRest("POST", "study_summaries", () => json([{}]));
    const patches: Record<string, unknown>[] = [];
    onRest("PATCH", "study_summaries", (args) => {
      patches.push(JSON.parse(args.body ?? "{}") as Record<string, unknown>);

      return json([{}]);
    });
    let calls = 0;
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () => {
        calls += 1;

        if (calls <= 2) {
          return json({
            message: { content: "" },
            done: true,
            done_reason: "length",
            eval_count: 2000,
          });
        }

        return json({ message: { content: "Winzig [Q1]." } });
      },
    });

    const outcome = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: null,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(calls, 3);
    assert.equal(outcome.response.span.key, "slide:1");
    assert.equal(outcome.response.attempts, 3);
    assert.deepEqual(patches[patches.length - 1]?.draft_splits, {
      "slide:1-3": 2,
    });
  });

  it("never regenerates persisted subspans on resume", async () => {
    const bigChunks = [1, 2, 3, 4, 5, 6, 7, 8].map((slide) => ({
      id: `s${slide}`,
      document_id: "doc-1",
      chunk_index: slide - 1,
      content: `FOLIE-${slide}-TEXT ${"x".repeat(1000)}`,
      source_refs: [{ kind: "slide", slide }],
    }));
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json(bigChunks));
    onRest("GET", "study_summaries", () =>
      json([
        summaryRow({
          draft_splits: { "slide:1-4": 2 },
          draft_spans: [
            {
              key: "slide:1",
              label: "Folie 1",
              text: "Bereits da (Folie 1).",
              refs: ["Folie 1"],
              completedAt: "2026-10-31T10:00:00.000Z",
            },
          ],
        }),
      ]),
    );
    onRest("PATCH", "study_summaries", () => json([{}]));
    ollamaWith(["Weiter [Q1] und [Q2]."]);

    const outcome = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: GEN,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.span.key, "slide:7-8");
    assert.equal(outcome.response.attempts, 1);
    assert.equal(outcome.response.percent, 38);

    const body =
      hits.find((hit) => hit.url.includes("11434"))?.body ?? "";

    assert.ok(body.includes("FOLIE-7-TEXT"));
    assert.ok(body.includes("FOLIE-8-TEXT"));
    assert.ok(!body.includes("FOLIE-1-TEXT"));
    assert.ok(!body.includes("FOLIE-2-TEXT"));
  });

  it("keeps minimum-size truncation resumable", async () => {
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () =>
      json([
        {
          id: "s1",
          document_id: "doc-1",
          chunk_index: 0,
          content: `FOLIE-1-TEXT ${"x".repeat(1500)}`,
          source_refs: [{ kind: "slide", slide: 1 }],
        },
      ]),
    );
    onRest("GET", "study_summaries", () => json([]));
    let inserted: Record<string, unknown> = {};
    onRest("POST", "study_summaries", (args) => {
      const rows = JSON.parse(args.body ?? "[]") as Record<string, unknown>[];
      inserted = rows[0] ?? {};

      return json([inserted]);
    });
    let patched = 0;
    onRest("PATCH", "study_summaries", () => {
      patched += 1;

      return json([{}]);
    });
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () =>
        json({
          message: { content: "" },
          done: true,
          done_reason: "length",
          eval_count: 2000,
        }),
    });

    const first = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: null,
    });

    assert.deepEqual(first, {
      ok: false,
      http: 409,
      message:
        "Selbst der kleinste Abschnitt wurde abgeschnitten — der Entwurf bleibt gespeichert, bitte später erneut versuchen.",
    });
    assert.equal(patched, 0);

    const gid = inserted.draft_generation_id as string;

    assert.ok(typeof gid === "string" && gid !== "");

    routes.length = 0;
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () =>
      json([
        {
          id: "s1",
          document_id: "doc-1",
          chunk_index: 0,
          content: "FOLIE-1-TEXT",
          source_refs: [{ kind: "slide", slide: 1 }],
        },
      ]),
    );
    onRest("GET", "study_summaries", () =>
      json([summaryRow({ draft_generation_id: gid, draft_spans: [] })]),
    );
    onRest("POST", "study_summaries", () => json([{}]));
    onRest("PATCH", "study_summaries", () => json([{}]));
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () =>
        json({
          message: { content: "" },
          done: true,
          done_reason: "length",
          eval_count: 2000,
        }),
    });

    const retry = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: gid,
    });

    assert.deepEqual(retry, first);
  });

  it("bounds retries on persistently truncating spans", async () => {
    const many = Array.from({ length: 512 }, (_, i) => ({
      id: `s${i + 1}`,
      document_id: "doc-1",
      chunk_index: i,
      content: `ZEILE-${i + 1} ${"x".repeat(8)}`,
      source_refs: [{ kind: "lines", start: i + 1, end: i + 1 }],
    }));
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json(many));
    onRest("GET", "study_summaries", () => json([]));
    onRest("POST", "study_summaries", () => json([{}]));
    const patches: Record<string, unknown>[] = [];
    onRest("PATCH", "study_summaries", (args) => {
      patches.push(JSON.parse(args.body ?? "{}") as Record<string, unknown>);

      return json([{}]);
    });
    let calls = 0;
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () => {
        calls += 1;

        return json({
          message: { content: "" },
          done: true,
          done_reason: "length",
          eval_count: 2000,
        });
      },
    });

    const outcome = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: null,
    });

    assert.deepEqual(outcome, {
      ok: false,
      http: 409,
      message:
        "Der Abschnitt wurde wiederholt abgeschnitten — der Entwurf bleibt gespeichert, bitte erneut versuchen.",
    });
    assert.equal(calls, 8);
    assert.deepEqual(patches[patches.length - 1]?.draft_spans, []);
    assert.equal(
      Object.values(
        (patches[patches.length - 1]?.draft_splits as Record<string, number>) ??
          {},
      )[0],
      8,
    );
  });

  it("rejects stale generations without calling the model", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () => json([summaryRow()]));

    const outcome = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: "22222222-2222-4222-8222-222222222222",
    });

    assert.deepEqual(outcome, {
      ok: false,
      http: 409,
      message: "Unbekannte oder abgelaufene Generierung — bitte neu starten.",
    });
    assert.ok(hits.every((hit) => !hit.url.includes("11434")));
  });

  it("reports done when every span persisted", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () =>
      json([
        summaryRow({
          draft_spans: [
            {
              key: "slide:1-2",
              label: "Folien 1–2",
              text: "Eins.",
              refs: [],
              completedAt: "2026-10-31T10:00:00.000Z",
            },
            {
              key: "slide:3-4",
              label: "Folien 3–4",
              text: "Zwei.",
              refs: [],
              completedAt: "2026-10-31T10:01:00.000Z",
            },
          ],
        }),
      ]),
    );
    onRest("PATCH", "study_summaries", () => json([{}]));

    const outcome = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: GEN,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.done, true);
    assert.equal(outcome.response.percent, 100);
    assert.ok(hits.every((hit) => !hit.url.includes("11434")));
  });

  it("rejects documents without usable text", async () => {
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json([]));
    onRest("GET", "study_summaries", () => json([]));

    const outcome = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: null,
    });

    assert.deepEqual(outcome, {
      ok: false,
      http: 409,
      message: "Zu diesem Dokument liegen keine auswertbaren Textstellen vor.",
    });
    assert.ok(hits.every((hit) => !hit.url.includes("11434")));
  });

  it("recovers from truncation, then reports minimum size", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () => json([]));
    onRest("POST", "study_summaries", () => json([{}]));
    const patches: Record<string, unknown>[] = [];
    onRest("PATCH", "study_summaries", (args) => {
      patches.push(JSON.parse(args.body ?? "{}") as Record<string, unknown>);

      return json([{}]);
    });
    let calls = 0;
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () => {
        calls += 1;

        return json({
          message: { content: "" },
          done: true,
          done_reason: "length",
          eval_count: 2000,
        });
      },
    });

    const outcome = await summarizeNextSpan(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: null,
    });

    assert.equal(calls, 2);
    assert.deepEqual(outcome, {
      ok: false,
      http: 409,
      message:
        "Selbst der kleinste Abschnitt wurde abgeschnitten — der Entwurf bleibt gespeichert, bitte später erneut versuchen.",
    });
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0]?.draft_splits, { "slide:1-2": 1 });
    assert.deepEqual(patches[0]?.draft_spans, []);
  });

  it("returns 404/409 for missing or unprocessed documents", async () => {
    onRest("GET", "study_documents", () => json([]));

    assert.deepEqual(
      await summarizeNextSpan(DB, {
        documentId: "missing",
        locale: "de",
        generationId: null,
      }),
      { ok: false, http: 404, message: "Dokument nicht gefunden." },
    );

    routes.length = 0;
    onRest("GET", "study_documents", () =>
      json([{ ...DOC_ROW, extraction_status: "processing" }]),
    );

    assert.deepEqual(
      await summarizeNextSpan(DB, {
        documentId: "doc-1",
        locale: "de",
        generationId: null,
      }),
      {
        ok: false,
        http: 409,
        message: "Das Dokument ist noch nicht verarbeitet.",
      },
    );
  });
});

describe("synthesizeSummary", () => {
  const GEN = "11111111-1111-4111-8111-111111111111";
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

  function summaryRow(spans: unknown[]) {
    return {
      id: "sum-1",
      user_id: "user-1",
      document_id: "doc-1",
      status: "partial",
      active_final_md: "",
      active_final_refs: [],
      active_completed_at: null,
      draft_generation_id: GEN,
      draft_planned: [
        { key: "slide:1-2", label: "Folien 1–2", order: 0 },
        { key: "slide:3-4", label: "Folien 3–4", order: 1 },
      ],
      draft_spans: spans,
      draft_preview_md: "",
      draft_preview_refs: [],
      draft_started_at: "2026-10-31T09:00:00.000Z",
    };
  }

  function span(key: string, label: string) {
    return {
      key,
      label,
      text: `Text ${label}.`,
      refs: [label],
      completedAt: "2026-10-31T10:00:00.000Z",
    };
  }

  function stubDocAndChunks(): void {
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
  }

  it("promotes a complete synthesis to active", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () =>
      json([summaryRow([span("slide:1-2", "Folien 1–2"), span("slide:3-4", "Folien 3–4")])]),
    );
    const patches: Record<string, unknown>[] = [];
    onRest("PATCH", "study_summaries", (args) => {
      patches.push(JSON.parse(args.body ?? "{}") as Record<string, unknown>);

      return json([{}]);
    });
    ollamaWith(["Final (Folien 1–2) und (Folien 3–4)."]);

    const outcome = await synthesizeSummary(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: GEN,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.complete, true);
    assert.equal(outcome.response.levels, 1);
    assert.deepEqual(outcome.response.refs, ["Folien 1–2", "Folien 3–4"]);
    assert.equal(patches.length, 1);
    assert.equal(
      patches[0]?.active_final_md,
      "Final (Folien 1–2) und (Folien 3–4).",
    );
    assert.equal(patches[0]?.status, "complete");
    assert.equal(patches[0]?.draft_generation_id, null);
    assert.deepEqual(patches[0]?.draft_spans, []);
  });

  it("stores a partial preview and keeps the draft", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () =>
      json([summaryRow([span("slide:1-2", "Folien 1–2")])]),
    );
    const patches: Record<string, unknown>[] = [];
    onRest("PATCH", "study_summaries", (args) => {
      patches.push(JSON.parse(args.body ?? "{}") as Record<string, unknown>);

      return json([{}]);
    });
    ollamaWith(["Teilweise (Folien 1–2)."]);

    const outcome = await synthesizeSummary(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: GEN,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.complete, false);
    assert.equal(patches.length, 1);
    assert.equal(patches[0]?.draft_preview_md, "Teilweise (Folien 1–2).");
    assert.ok(!("active_final_md" in (patches[0] ?? {})));
    assert.ok(!("draft_generation_id" in (patches[0] ?? {})));
  });

  it("never marks split drafts complete early", async () => {
    const bigChunks = [1, 2, 3, 4].map((slide) => ({
      id: `s${slide}`,
      document_id: "doc-1",
      chunk_index: slide - 1,
      content: `FOLIE-${slide}-TEXT ${"x".repeat(1500)}`,
      source_refs: [{ kind: "slide", slide }],
    }));
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json(bigChunks));
    onRest("GET", "study_summaries", () =>
      json([
        {
          ...summaryRow([span("slide:1", "Folie 1")]),
          draft_splits: { "slide:1-2": 1 },
        },
      ]),
    );
    onRest("PATCH", "study_summaries", () => json([{}]));
    ollamaWith(["Teil (Folie 1)."]);

    const outcome = await synthesizeSummary(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: GEN,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.complete, false);
    assert.deepEqual(outcome.response.refs, ["Folie 1"]);
  });

  it("rejects fabricated refs without writing", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () =>
      json([summaryRow([span("slide:1-2", "Folien 1–2"), span("slide:3-4", "Folien 3–4")])]),
    );
    let patched = 0;
    onRest("PATCH", "study_summaries", () => {
      patched += 1;

      return json([{}]);
    });
    ollamaWith(["Final (Folie 99)."]);

    await assert.rejects(
      synthesizeSummary(DB, {
        documentId: "doc-1",
        locale: "de",
        generationId: GEN,
      }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "malformed",
    );
    assert.equal(patched, 0);
  });

  it("maps truncation to a retryable error without writing", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () =>
      json([summaryRow([span("slide:1-2", "Folien 1–2"), span("slide:3-4", "Folien 3–4")])]),
    );
    let patched = 0;
    onRest("PATCH", "study_summaries", () => {
      patched += 1;

      return json([{}]);
    });
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () =>
        json({
          message: { content: "" },
          done: true,
          done_reason: "length",
          eval_count: 2000,
        }),
    });

    await assert.rejects(
      synthesizeSummary(DB, {
        documentId: "doc-1",
        locale: "de",
        generationId: GEN,
      }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === "truncated",
    );
    assert.equal(patched, 0);
  });

  it("reduces hierarchically when sections exceed the budget", async () => {
    const bigChunks = [1, 2, 3, 4, 5, 6, 7, 8].map((slide) => ({
      id: `s${slide}`,
      document_id: "doc-1",
      chunk_index: slide - 1,
      content: `FOLIE-${slide}-TEXT ${"x".repeat(1500)}`,
      source_refs: [{ kind: "slide", slide }],
    }));
    onRest("GET", "study_documents", () => json([DOC_ROW]));
    onRest("GET", "retrieval_chunks", () => json(bigChunks));
    const keys = ["slide:1-2", "slide:3-4", "slide:5-6", "slide:7-8"];
    onRest("GET", "study_summaries", () =>
      json([
        {
          id: "sum-1",
          document_id: "doc-1",
          status: "partial",
          active_final_md: "",
          active_final_refs: [],
          active_completed_at: null,
          draft_generation_id: GEN,
          draft_planned: keys.map((key, order) => ({
            key,
            label: `Span ${order}`,
            order,
          })),
          draft_spans: keys.map((key, order) => {
            const label = `Folien ${order * 2 + 1}–${order * 2 + 2}`;

            return {
              key,
              label,
              text: "y".repeat(2100),
              refs: [label],
              completedAt: "2026-10-31T10:00:00.000Z",
            };
          }),
          draft_preview_md: "",
          draft_preview_refs: [],
          draft_started_at: "2026-10-31T09:00:00.000Z",
        },
      ]),
    );
    onRest("PATCH", "study_summaries", () => json([{}]));
    ollamaWith([
      "Zwischen eins (Folien 1–2).",
      "Zwischen zwei (Folien 5–6).",
      "Final (Folien 1–2) und (Folien 5–6).",
    ]);

    const outcome = await synthesizeSummary(DB, {
      documentId: "doc-1",
      locale: "de",
      generationId: GEN,
    });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal(outcome.response.complete, true);
    assert.equal(outcome.response.levels, 2);
    assert.equal(
      hits.filter((hit) => hit.url.includes("11434")).length,
      3,
    );
  });

  it("returns 404/409 without a matching draft", async () => {
    stubDocAndChunks();
    onRest("GET", "study_summaries", () => json([]));

    assert.deepEqual(
      await synthesizeSummary(DB, {
        documentId: "doc-1",
        locale: "de",
        generationId: GEN,
      }),
      { ok: false, http: 404, message: "Keine Zusammenfassung vorhanden." },
    );

    routes.length = 0;
    stubDocAndChunks();
    onRest("GET", "study_summaries", () =>
      json([
        {
          id: "sum-1",
          document_id: "doc-1",
          status: "partial",
          active_final_md: "",
          active_final_refs: [],
          active_completed_at: null,
          draft_generation_id: GEN,
          draft_planned: [],
          draft_spans: [],
          draft_preview_md: "",
          draft_preview_refs: [],
          draft_started_at: "2026-10-31T09:00:00.000Z",
        },
      ]),
    );

    assert.deepEqual(
      await synthesizeSummary(DB, {
        documentId: "doc-1",
        locale: "de",
        generationId: "22222222-2222-4222-8222-222222222222",
      }),
      {
        ok: false,
        http: 409,
        message: "Unbekannte oder abgelaufene Generierung — bitte neu starten.",
      },
    );
  });
});

describe("generation locks", () => {
  it("grants one holder per user and document", () => {
    const key = generationLockKey("user-1", "doc-1");
    const otherDoc = generationLockKey("user-1", "doc-2");
    const otherUser = generationLockKey("user-2", "doc-1");

    assert.equal(tryAcquireGenerationLock(key), true);
    assert.equal(tryAcquireGenerationLock(key), false);
    assert.equal(tryAcquireGenerationLock(otherDoc), true);
    assert.equal(tryAcquireGenerationLock(otherUser), true);

    releaseGenerationLock(key);
    releaseGenerationLock(otherDoc);
    releaseGenerationLock(otherUser);

    assert.equal(tryAcquireGenerationLock(key), true);

    releaseGenerationLock(key);
  });
});
