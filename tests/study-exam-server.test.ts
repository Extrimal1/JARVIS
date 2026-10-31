/**
 * Exam/subject server tests: link ownership validation in the
 * study CRUD checks plus old-record compatibility. The Supabase
 * HTTP layer is stubbed; foreign ids answer empty (as RLS would).
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { studyConfig } from "@/src/lib/api/modules/study";
import { dbFor } from "@/src/lib/supabase/db";
import { isEntry, isStudyData } from "@/src/lib/study";

const DB = dbFor(
  { url: "https://supabase.test", anonKey: "anon" },
  "token",
  "user-1",
);

type FetchArgs = { url: string; method: string; body: string | null };

let routes: { match: (args: FetchArgs) => boolean; respond: () => Response }[] =
  [];
const realFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

beforeEach(() => {
  routes = [];
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const args: FetchArgs = {
      url: String(input),
      method: init?.method ?? "GET",
      body: null,
    };
    const route = routes.find((candidate) => candidate.match(args));

    if (route === undefined) {
      throw new Error(`unstubbed fetch: ${args.method} ${args.url}`);
    }

    return route.respond();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubRow(table: string, id: string, row: unknown): void {
  routes.push({
    match: (args) =>
      args.url.startsWith(`https://supabase.test/rest/v1/${table}`) &&
      args.url.includes(`id=eq.${id}`),
    respond: () => json(row === null ? [] : [row]),
  });
}

const AVAILABILITY = {
  weekly: [60, 60, 60, 60, 60, 0, 0],
  exceptions: {},
};

describe("exam link ownership", () => {
  it("accepts owned document and topic links", async () => {
    stubRow("study_documents", "doc-1", { id: "doc-1" });
    stubRow("study_entries", "topic-1", { id: "topic-1", section: "topics" });

    const result = await studyConfig.checkCreate(DB, {
      id: "exam-1",
      section: "exams",
      title: "Klausur",
      examData: {
        documentIds: ["doc-1"],
        topicIds: ["topic-1"],
        availability: AVAILABILITY,
      },
    });

    assert.ok(!("message" in result));
  });

  it("rejects foreign or missing document links", async () => {
    stubRow("study_documents", "doc-x", null);

    const result = await studyConfig.checkCreate(DB, {
      id: "exam-1",
      section: "exams",
      title: "Klausur",
      examData: {
        documentIds: ["doc-x"],
        topicIds: [],
        availability: AVAILABILITY,
      },
    });

    assert.deepEqual(result, { message: "Unbekannte Dokumentverknüpfung." });
  });

  it("rejects topic links outside the topics section", async () => {
    stubRow("study_entries", "exam-9", { id: "exam-9", section: "exams" });

    const result = await studyConfig.checkCreate(DB, {
      id: "exam-1",
      section: "exams",
      title: "Klausur",
      examData: {
        documentIds: [],
        topicIds: ["exam-9"],
        availability: AVAILABILITY,
      },
    });

    assert.deepEqual(result, { message: "Unbekannte Themenverknüpfung." });
  });

  it("rejects foreign topic parents", async () => {
    stubRow("study_entries", "t-x", null);

    const result = await studyConfig.checkCreate(DB, {
      id: "topic-1",
      section: "topics",
      title: "Zins",
      parentId: "t-x",
    });

    assert.deepEqual(result, {
      message: "Unbekanntes übergeordnetes Thema.",
    });
  });

  it("validates links on update without clobbering state", async () => {
    stubRow("study_documents", "doc-1", { id: "doc-1" });
    stubRow("study_entries", "topic-1", { id: "topic-1", section: "topics" });

    const existing = {
      id: "exam-1",
      title: "Klausur",
      detail: "",
      section: "exams",
      date: "2026-12-01",
      examData: {
        documentIds: ["doc-1"],
        topicIds: ["topic-1"],
        availability: AVAILABILITY,
      },
    };
    const renamed = await studyConfig.checkUpdate(
      DB,
      { title: "Klausur neu" },
      existing,
    );

    assert.ok(!("message" in renamed));

    if ("message" in renamed) return;

    // A title patch preserves the other exam's state shape: the
    // row keeps every existing link and the availability.
    assert.deepEqual(
      (renamed.row as Record<string, unknown>).exam_data,
      existing.examData,
    );

    stubRow("study_documents", "doc-x", null);

    const foreign = await studyConfig.checkUpdate(
      DB,
      {
        examData: {
          documentIds: ["doc-x"],
          topicIds: [],
          availability: AVAILABILITY,
        },
      },
      existing,
    );

    assert.deepEqual(foreign, { message: "Unbekannte Dokumentverknüpfung." });
  });

  it("skips link lookups for unrelated sections", async () => {
    let reads = 0;
    routes.push({
      match: () => {
        reads += 1;

        return true;
      },
      respond: () => json([]),
    });

    const result = await studyConfig.checkCreate(DB, {
      id: "s1",
      section: "subjects",
      title: "Mathe",
    });

    assert.ok(!("message" in result));
    assert.equal(reads, 0);
  });
});

describe("old-record compatibility", () => {
  it("reads pre-migration rows without exam data", () => {
    const domain = studyConfig.toDomain({
      id: "exam-1",
      title: "Klausur",
      detail: "",
      section: "exams",
      date: "2026-12-01",
    }) as Record<string, unknown>;

    assert.equal(domain.examData, undefined);
    assert.ok(isEntry({ id: "exam-1", title: "Klausur", detail: "" }));
  });

  it("round-trips stored plans through the row mapper", () => {
    const plan = {
      examId: "exam-1",
      generatedAt: "2026-10-31T10:00:00.000Z",
      inputsSignature: "{}",
      deficitMinutes: 0,
      warnings: [],
      tasks: [
        {
          id: "t1",
          date: "2026-11-02",
          kind: "theory",
          topicId: "topic-1",
          questionIds: [],
          minutes: 15,
          priority: "normal",
          reason: "Grundlagen aufbauen.",
          origin: "auto",
          status: "open",
        },
      ],
    };
    const domain = studyConfig.toDomain({
      id: "exam-1",
      title: "Klausur",
      detail: "",
      section: "exams",
      exam_data: {
        documentIds: [],
        topicIds: ["topic-1"],
        availability: AVAILABILITY,
        plan,
      },
    }) as Record<string, unknown>;

    assert.deepEqual(
      (domain.examData as Record<string, unknown>).plan,
      plan,
    );
    assert.ok(isEntry(domain));
  });

  it("round-trips new fields through guards", () => {
    assert.ok(
      isStudyData({
        subjects: [],
        exams: [
          {
            id: "exam-1",
            title: "Klausur",
            detail: "",
            examData: {
              documentIds: [],
              topicIds: [],
              availability: AVAILABILITY,
            },
          },
        ],
        topics: [],
        materials: [],
      }),
    );
    assert.equal(
      isEntry({ id: "x", title: "y", examData: { broken: true } }),
      false,
    );
  });
});
