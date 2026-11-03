/**
 * Auto topic-extraction regression tests: meaningful-text gate,
 * error causes, bounded retry progress, the shared runner loop
 * (merge + persist + idempotent re-run), server gate messages,
 * tolerant parsing, and mastery/priority preservation.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyExtractResponse,
  classifyTopicError,
  emptyTopicProgress,
  formatTopicSummary,
  hasMeaningfulText,
  persistMergedTopics,
  runDocumentTopicExtraction,
  topicCauseLabel,
  TOPIC_SPAN_MAX_ATTEMPTS,
  type TopicExtractCall,
  type TopicPersistStore,
} from "@/src/lib/study/autoTopics";
import {
  mergeExtractedTopics,
  mergeTopicsManual,
  parseTopicExtraction,
} from "@/src/lib/study/topics";
import {
  extractTopics,
} from "@/src/lib/api/modules/topicIntel";
import { dbFor } from "@/src/lib/supabase/db";
import type { TopicsExtractResponse } from "@/src/lib/study/protocol";
import type { GroundedSource } from "@/src/lib/study/prompts";
import type { ParsedCoverageUnit } from "@/src/lib/study/coverage";
import type { Entry } from "@/src/lib/study";

// ------------------------------------------------------------------ fixtures

const SOURCES: GroundedSource[] = [
  {
    marker: "[Q1]",
    documentName: "Vorlesung.pptx",
    refLabel: "Folie 1",
    text: "Zinsrechnung: einfacher Zins.",
  },
  {
    marker: "[Q2]",
    documentName: "Vorlesung.pptx",
    refLabel: "Folie 2",
    text: "Rentenrechnung: nachschüssige Rente.",
  },
];

const USABLE: ParsedCoverageUnit[] = [{ kind: "slide", from: 1, to: 2 }];

function topicDto(name: string, refs: string[]) {
  return {
    name,
    summary: `${name} kurz.`,
    concepts: [`${name}-Begriff`],
    formulas: [],
    examples: [],
    prerequisites: [],
    parent: null,
    refs,
  };
}

function response(
  overrides: Partial<TopicsExtractResponse> = {},
): TopicsExtractResponse {
  return {
    documentId: "doc-1",
    documentName: "Vorlesung.pptx",
    spansDone: [],
    skippedSpans: [],
    topics: [],
    droppedInvalid: 0,
    droppedUngrounded: 0,
    repaired: false,
    insufficient: false,
    done: true,
    ...overrides,
  };
}

function makeStore(): TopicPersistStore & {
  added: Entry[];
  updated: { id: string; patch: Partial<Entry> }[];
} {
  const added: Entry[] = [];
  const updated: { id: string; patch: Partial<Entry> }[] = [];

  return {
    added,
    updated,
    addEntry: async (_section, entry) => {
      added.push(entry);

      return { ok: true as const };
    },
    updateEntry: async (id, patch) => {
      updated.push({ id, patch });

      return { ok: true as const };
    },
  };
}

function makeIds(): () => string {
  let next = 0;

  return () => `t-${(next += 1)}`;
}

// ------------------------------------------------------------------ gate

describe("hasMeaningfulText", () => {
  it("rejects empty, blank, and fragment-only chunks", () => {
    assert.equal(hasMeaningfulText([]), false);
    assert.equal(hasMeaningfulText([{ text: "" }]), false);
    assert.equal(hasMeaningfulText([{ text: "   \n\t  " }]), false);
    assert.equal(
      hasMeaningfulText([{ text: "… --- …" }, { text: " . " }]),
      false,
    );
    assert.equal(hasMeaningfulText([{ text: "kurz" }]), false);
  });

  it("accepts real text across chunks", () => {
    assert.equal(
      hasMeaningfulText([
        { text: "Zinsrechnung: einfacher Zins auf das angelegte Kapital pro Jahr." },
        {
          text: "Rentenrechnung mit nachschüssiger Rente über viele Perioden hinweg betrachtet, inklusive Barwert.",
        },
      ]),
      true,
    );
  });
});

// ------------------------------------------------------------------ causes

describe("classifyTopicError", () => {
  it("maps layers to causes with retry flags", () => {
    assert.deepEqual(
      classifyTopicError(new Error("Ollama ist nicht erreichbar")),
      {
        cause: "ollama",
        detail: "Ollama ist nicht erreichbar",
        retryable: true,
      },
    );
    assert.equal(
      classifyTopicError(new Error("Supabase timeout")).cause,
      "supabase",
    );
    assert.equal(
      classifyTopicError(new Error("kein JSON gefunden")).cause,
      "format",
    );
    assert.equal(
      classifyTopicError(new Error("Das Dokument ist noch nicht verarbeitet."))
        .cause,
      "conflict",
    );
    assert.deepEqual(
      classifyTopicError(new Error("Sitzung abgelaufen. Bitte melde dich erneut an.")),
      {
        cause: "auth",
        detail: "Sitzung abgelaufen. Bitte melde dich erneut an.",
        retryable: false,
      },
    );
    assert.equal(
      classifyTopicError(new Error("Abgebrochen.")).cause,
      "aborted",
    );
    assert.deepEqual(classifyTopicError(new Error("eingescannt, OCR nötig")), {
      cause: "empty",
      detail: "eingescannt, OCR nötig",
      retryable: false,
    });
    assert.equal(
      classifyTopicError(new Error("etwas Unerwartetes")).cause,
      "unknown",
    );
    assert.equal(topicCauseLabel("ollama"), "KI-Dienst");
    assert.equal(topicCauseLabel("supabase"), "Cloud-Speicher");
  });
});

// ------------------------------------------------------------------ progress

describe("applyExtractResponse", () => {
  it("accumulates covered spans and reports progress", () => {
    const first = applyExtractResponse(
      emptyTopicProgress(),
      response({ spansDone: ["Folien 1–2"], done: false }),
    );

    assert.equal(first.madeProgress, true);
    assert.deepEqual(first.progress.coveredLabels, ["Folien 1–2"]);
    assert.deepEqual(first.retryableSkipped, []);

    const second = applyExtractResponse(
      first.progress,
      response({ spansDone: ["Folien 1–2", "Folien 3–4"], done: true }),
    );

    assert.equal(second.madeProgress, true);
    assert.deepEqual(second.progress.coveredLabels, [
      "Folien 1–2",
      "Folien 3–4",
    ]);
  });

  it("retries skipped spans, then exhausts them (terminates)", () => {
    let state = emptyTopicProgress();
    const skipped = response({
      spansDone: [],
      skippedSpans: ["Folien 1–2"],
      done: false,
    });

    for (let round = 1; round < TOPIC_SPAN_MAX_ATTEMPTS; round += 1) {
      const applied = applyExtractResponse(state, skipped);

      state = applied.progress;
      assert.deepEqual(applied.retryableSkipped, ["Folien 1–2"]);
      assert.equal(applied.madeProgress, false);
    }

    const last = applyExtractResponse(state, skipped);

    assert.deepEqual(last.retryableSkipped, []);
    assert.deepEqual(last.progress.exhaustedLabels, ["Folien 1–2"]);
  });
});

// ------------------------------------------------------------------ summary

describe("formatTopicSummary", () => {
  it("reports created/merged plus honest drop counts", () => {
    assert.equal(
      formatTopicSummary({
        documentId: "",
        created: 0,
        merged: 0,
        droppedInvalid: 0,
        droppedUngrounded: 0,
        spansDone: [],
        skippedSpans: [],
        exhaustedLabels: [],
        insufficient: false,
        done: true,
      }),
      "+0 neu · 0 ergänzt",
    );
  });

  it("names exhausted spans and insufficient text", () => {
    const summary = {
      documentId: "doc-1",
      created: 2,
      merged: 1,
      droppedInvalid: 1,
      droppedUngrounded: 2,
      spansDone: ["Folien 1–2"],
      skippedSpans: [],
      exhaustedLabels: ["Folien 3–4"],
      insufficient: false,
      done: false,
    };

    assert.equal(
      formatTopicSummary(summary),
      "+2 neu · 1 ergänzt · 1 ungültig verworfen · 2 ohne Beleg verworfen · 1 Abschnitt fehlerhaft (Folien 3–4)",
    );
    assert.equal(
      formatTopicSummary({ ...summary, insufficient: true }),
      "Kein ausreichender Text für Themen gefunden.",
    );
  });
});

// ------------------------------------------------------------------ runner

describe("runDocumentTopicExtraction", () => {
  it("loops rounds, merges, and persists linked doc+subject", async () => {
    const seen: string[][] = [];
    const call: TopicExtractCall = async (covered) => {
      seen.push([...covered]);

      if (covered.length === 0) {
        return response({
          spansDone: ["Folien 1–2"],
          topics: [topicDto("Zinsrechnung", ["Folie 1"])],
          done: false,
        });
      }

      return response({
        spansDone: ["Folien 1–2", "Folien 3–4"],
        topics: [topicDto("Rentenrechnung", ["Folie 4"])],
        done: true,
      });
    };
    const store = makeStore();

    const summary = await runDocumentTopicExtraction({
      documentId: "doc-1",
      subject: "Mathe",
      locale: "de",
      topics: [],
      makeId: makeIds(),
      call,
      store,
    });

    assert.equal(summary.done, true);
    assert.equal(summary.created, 2);
    assert.equal(summary.merged, 0);
    assert.deepEqual(seen, [[], ["Folien 1–2"]]);
    assert.equal(store.added.length, 2);
    assert.ok(
      store.added.every(
        (entry) =>
          entry.subject === "Mathe" &&
          (entry.sourceRefs ?? []).every(
            (ref) => ref.documentId === "doc-1",
          ),
      ),
    );
    assert.equal(summary.topics.length, 2);
  });

  it("is idempotent: re-runs merge without duplicates or writes", async () => {
    const call: TopicExtractCall = async () =>
      response({
        spansDone: ["Folien 1–2"],
        topics: [topicDto("Zinsrechnung", ["Folie 1"])],
        done: true,
      });
    const first = makeStore();
    const makeId = makeIds();

    const once = await runDocumentTopicExtraction({
      documentId: "doc-1",
      subject: "Mathe",
      locale: "de",
      topics: [],
      makeId,
      call,
      store: first,
    });

    assert.equal(once.created, 1);

    const second = makeStore();
    const twice = await runDocumentTopicExtraction({
      documentId: "doc-1",
      subject: "Mathe",
      locale: "de",
      topics: once.topics,
      makeId,
      call,
      store: second,
    });

    assert.equal(twice.created, 0);
    assert.equal(twice.merged, 0);
    assert.equal(twice.topics.length, 1);
    assert.equal(second.added.length, 0);
    assert.equal(second.updated.length, 0);
  });

  it("retries skipped spans until they succeed", async () => {
    let calls = 0;
    const call: TopicExtractCall = async () => {
      calls += 1;

      if (calls === 1) {
        return response({
          spansDone: [],
          skippedSpans: ["Folien 1–2"],
          done: false,
        });
      }

      return response({
        spansDone: ["Folien 1–2"],
        topics: [topicDto("Zinsrechnung", ["Folie 1"])],
        done: true,
      });
    };
    const store = makeStore();

    const summary = await runDocumentTopicExtraction({
      documentId: "doc-1",
      subject: "Mathe",
      locale: "de",
      topics: [],
      makeId: makeIds(),
      call,
      store,
    });

    assert.equal(calls, 2);
    assert.equal(summary.done, true);
    assert.equal(summary.created, 1);
    assert.deepEqual(summary.exhaustedLabels, []);
  });

  it("exhausts persistently failing spans with bounded calls", async () => {
    let calls = 0;
    const call: TopicExtractCall = async () => {
      calls += 1;

      return response({
        spansDone: [],
        skippedSpans: ["Folien 1–2"],
        done: false,
      });
    };

    const summary = await runDocumentTopicExtraction({
      documentId: "doc-1",
      subject: "Mathe",
      locale: "de",
      topics: [],
      makeId: makeIds(),
      call,
      store: makeStore(),
    });

    assert.equal(calls, TOPIC_SPAN_MAX_ATTEMPTS);
    assert.equal(summary.done, false);
    assert.deepEqual(summary.exhaustedLabels, ["Folien 1–2"]);
    assert.deepEqual(summary.skippedSpans, []);
  });

  it("resumes from initial covered labels without re-requesting", async () => {
    const seen: string[][] = [];
    const call: TopicExtractCall = async (covered) => {
      seen.push([...covered]);

      return response({
        spansDone: [...covered, "Folien 3–4"],
        done: true,
      });
    };

    const summary = await runDocumentTopicExtraction({
      documentId: "doc-1",
      subject: "Mathe",
      locale: "de",
      topics: [],
      makeId: makeIds(),
      call,
      store: makeStore(),
      initialCovered: ["Folien 1–2"],
    });

    assert.deepEqual(seen, [["Folien 1–2"]]);
    assert.deepEqual(summary.spansDone, ["Folien 1–2", "Folien 3–4"]);
    assert.equal(summary.done, true);
  });

  it("writes nothing for insufficient text and aborts on signal", async () => {
    const store = makeStore();
    const insufficient = await runDocumentTopicExtraction({
      documentId: "doc-1",
      subject: "Mathe",
      locale: "de",
      topics: [],
      makeId: makeIds(),
      call: async () => response({ insufficient: true, done: true }),
      store,
    });

    assert.equal(insufficient.insufficient, true);
    assert.equal(insufficient.done, true);
    assert.equal(store.added.length, 0);
    assert.equal(store.updated.length, 0);

    const controller = new AbortController();

    controller.abort();

    await assert.rejects(
      runDocumentTopicExtraction({
        documentId: "doc-1",
        subject: "Mathe",
        locale: "de",
        topics: [],
        makeId: makeIds(),
        call: async () => response({}),
        store: makeStore(),
        signal: controller.signal,
      }),
      /Abgebrochen/,
    );
  });

  it("surfaces store failures with their cause", async () => {
    const store = makeStore();

    store.addEntry = async () => ({
      ok: false as const,
      error: "Supabase ist nicht erreichbar.",
    });

    await assert.rejects(
      runDocumentTopicExtraction({
        documentId: "doc-1",
        subject: "Mathe",
        locale: "de",
        topics: [],
        makeId: makeIds(),
        call: async () =>
          response({
            spansDone: ["Folien 1–2"],
            topics: [topicDto("Zinsrechnung", ["Folie 1"])],
            done: true,
          }),
        store,
      }),
      /Supabase ist nicht erreichbar/,
    );
  });
});

// ------------------------------------------------------------------ persist

describe("persistMergedTopics", () => {
  it("diffs against the working list, not stale props", async () => {
    const store = makeStore();
    const working: Entry[] = [
      {
        id: "t-1",
        title: "Zinsrechnung",
        detail: "Alt.",
        subject: "Mathe",
      },
    ];
    const merged = mergeExtractedTopics(
      working,
      [
        {
          topic: {
            name: "Zinsrechnung",
            summary: "Neu dazu.",
            concepts: [],
            formulas: [],
            examples: [],
            prerequisites: [],
            parent: null,
            refs: ["Folie 2"],
          },
          documentId: "doc-1",
        },
      ],
      "Mathe",
      makeIds(),
    );

    const counts = await persistMergedTopics(store, working, merged);

    assert.equal(counts.created, 0);
    assert.equal(counts.merged, 1);
    assert.equal(store.updated.length, 1);
    assert.equal(store.updated[0]?.id, "t-1");
  });
});

// ------------------------------------------------------------------ server gate

const DB = dbFor(
  { url: "https://supabase.test", anonKey: "anon" },
  "token",
  "user-1",
);

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

describe("extractTopics gate", () => {
  it("explains unsupported/failed docs instead of a bare 409", async () => {
    onRest("GET", "study_documents", () =>
      json([{ id: "doc-1", name: "Scan.pdf", extraction_status: "unsupported" }]),
    );

    const unsupported = await extractTopics(DB, {
      documentId: "doc-1",
      locale: "de",
      coveredLabels: [],
      maxSpans: 6,
    });

    assert.equal(unsupported.ok, false);
    if (unsupported.ok) return;
    assert.equal(unsupported.http, 409);
    assert.match(unsupported.message, /OCR/);

    routes.length = 0;
    onRest("GET", "study_documents", () =>
      json([{ id: "doc-1", name: "Kaputt.pdf", extraction_status: "failed" }]),
    );

    const failed = await extractTopics(DB, {
      documentId: "doc-1",
      locale: "de",
      coveredLabels: [],
      maxSpans: 6,
    });

    assert.equal(failed.ok, false);
    if (failed.ok) return;
    assert.match(failed.message, /erneut/);
  });

  it("returns insufficient for textless chunks without a model call", async () => {
    onRest("GET", "study_documents", () =>
      json([
        { id: "doc-1", name: "Leer.pdf", extraction_status: "completed" },
      ]),
    );
    onRest("GET", "retrieval_chunks", () =>
      json([
        {
          id: "c1",
          document_id: "doc-1",
          chunk_index: 0,
          content: "   \n  ",
          source_refs: [{ kind: "page", page: 1 }],
        },
      ]),
    );

    const outcome = await extractTopics(DB, {
      documentId: "doc-1",
      locale: "de",
      coveredLabels: [],
      maxSpans: 6,
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.response.insufficient, true);
    assert.deepEqual(outcome.response.topics, []);
    assert.ok(hits.every((hit) => !hit.url.includes("11434")));
  });
});

// ------------------------------------------------------------------ tolerant parser

describe("parseTopicExtraction tolerance", () => {
  it("accepts bare-string refs, alias keys, and numeric markers", () => {
    const bare = parseTopicExtraction(
      JSON.stringify({ topics: [{ name: "Zins", refs: "[Q1]" }] }),
      SOURCES,
      USABLE,
    );

    assert.equal(bare.topics.length, 1);
    assert.deepEqual(bare.topics[0]?.refs, ["Folie 1"]);

    const alias = parseTopicExtraction(
      JSON.stringify({ topics: [{ name: "Rente", references: ["[Q2]"] }] }),
      SOURCES,
      USABLE,
    );

    assert.equal(alias.topics.length, 1);
    assert.deepEqual(alias.topics[0]?.refs, ["Folie 2"]);

    const numeric = parseTopicExtraction(
      JSON.stringify({ topics: [{ name: "Mix", refs: [1, "Folie 2"] }] }),
      SOURCES,
      USABLE,
    );

    assert.equal(numeric.topics.length, 1);
    assert.deepEqual(numeric.topics[0]?.refs, ["Folie 1", "Folie 2"]);
  });

  it("still drops ungrounded topics with counts", () => {
    const parsed = parseTopicExtraction(
      JSON.stringify({
        topics: [
          { name: "Erfunden", refs: ["Folie 99"] },
          { name: "Zins", refs: ["[Q1]"] },
        ],
      }),
      SOURCES,
      USABLE,
    );

    assert.equal(parsed.topics.length, 1);
    assert.equal(parsed.droppedUngrounded, 1);
  });
});

// ------------------------------------------------------------------ preservation

describe("topic merge preservation", () => {
  it("keeps mastery, evidence, priority, and unions refs", () => {
    const existing: Entry[] = [
      {
        id: "t-1",
        title: "Zinsrechnung",
        detail: "Alt.",
        subject: "Mathe",
        mastery: "understood",
        masteryEvidence: { quizAccuracy: 0.8, reviews: 3, ratedAt: null },
        sourceRefs: [{ documentId: "doc-0", label: "Folie 1" }],
        topicData: {
          concepts: ["Zins"],
          formulas: [],
          examples: [],
          prerequisites: [],
          priority: "high",
        },
      },
    ];

    const merged = mergeExtractedTopics(
      existing,
      [
        {
          topic: {
            name: "Zinsrechnung",
            summary: "Neu dazu.",
            concepts: ["Zinssatz"],
            formulas: [],
            examples: [],
            prerequisites: [],
            parent: null,
            refs: ["Folie 2"],
          },
          documentId: "doc-1",
        },
      ],
      "Mathe",
      makeIds(),
    );

    assert.equal(merged.entries.length, 1);
    assert.equal(merged.created, 0);
    assert.equal(merged.merged, 1);

    const entry = merged.entries[0];

    assert.equal(entry?.mastery, "understood");
    assert.deepEqual(entry?.masteryEvidence, {
      quizAccuracy: 0.8,
      reviews: 3,
      ratedAt: null,
    });
    assert.equal(entry?.topicData?.priority, "high");
    assert.deepEqual(entry?.sourceRefs, [
      { documentId: "doc-0", label: "Folie 1" },
      { documentId: "doc-1", label: "Folie 2" },
    ]);
    assert.deepEqual(entry?.topicData?.concepts, ["Zins", "Zinssatz"]);
  });

  it("keeps the survivor priority on manual merge", () => {
    const merged = mergeTopicsManual(
      [
        {
          id: "t-1",
          title: "Zins",
          detail: "A.",
          subject: "Mathe",
          topicData: {
            concepts: [],
            formulas: [],
            examples: [],
            prerequisites: [],
            priority: "low",
          },
        },
        {
          id: "t-2",
          title: "Zinsrechnung",
          detail: "B.",
          subject: "Mathe",
        },
      ],
      [],
      ["t-1", "t-2"],
      "t-1",
    );

    assert.equal(merged.ok, true);
    if (!merged.ok) return;

    const survivor = merged.result.entries.find(
      (entry) => entry.id === "t-1",
    );

    assert.equal(survivor?.topicData?.priority, "low");
  });
});
