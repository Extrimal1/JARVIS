/**
 * Memory-write and lecture-read assistant tests: plan validation,
 * registry coverage, the lecture overview tool, executor memory
 * writes with undo, and end-to-end agent turns that PERFORM the
 * actions (not just describe them).
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  describePlan,
  isAssistantPlan,
} from "@/src/lib/assistant/actions";
import {
  MODEL_PARAMS,
  runAgent,
  type AgentData,
  type AgentStores,
} from "@/src/lib/assistant/agent";
import {
  ASSISTANT_TOOLS,
  getToolDefinition,
} from "@/src/lib/assistant/registry";
import {
  clearExecutionCache,
  executePlan,
  executeUndo,
  type ExecutorDeps,
} from "@/src/lib/assistant/executor";
import { getLectureOverview } from "@/src/lib/assistant/tools";
import { turnHref } from "@/src/lib/assistant/transcript";
import { EMPTY_FINANCE } from "@/src/lib/finance";
import { EMPTY_STUDY } from "@/src/lib/study";
import type { MemoryEntry } from "@/src/lib/memory";
import type {
  LectureSession,
  LocalRecording,
} from "@/src/lib/lecture/types";
import type { RemoteResult } from "@/src/lib/db/useRemoteResource";

const SESSION: LectureSession = {
  id: "session-1",
  courseId: null,
  title: "Mathe I",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
};

function recording(overrides: Partial<LocalRecording> = {}): LocalRecording {
  return {
    id: "rec-1",
    sessionId: "session-1",
    courseId: null,
    title: "Vorlesung 1",
    language: "de",
    mimeType: "audio/webm",
    durationSeconds: 3600,
    sizeBytes: 1000,
    sha256: "abc",
    status: "saved_locally",
    errorCode: "",
    consentAt: "2026-10-20T10:00:00.000Z",
    createdAt: "2026-10-20T12:00:00.000Z",
    updatedAt: "2026-10-20T12:00:00.000Z",
    ...overrides,
  };
}

function makeData(overrides: Partial<AgentData> = {}): AgentData {
  return {
    events: [],
    finance: EMPTY_FINANCE,
    tasks: [],
    study: EMPTY_STUDY,
    places: [],
    savedIds: [],
    plans: [],
    prefs: {
      city: "",
      useGeolocation: false,
      latitude: null,
      longitude: null,
      radiusKm: 10,
      maxBudgetCents: null,
      categories: [],
      setting: "any",
      maxDurationMinutes: null,
      company: "any",
    },
    memory: [],
    sessions: [SESSION],
    recordings: [recording()],
    todayISO: "2026-10-30",
    nowTime: "12:00",
    ...overrides,
  };
}

function makeMemoryStore() {
  const saved = new Map<string, MemoryEntry>();

  return {
    saved,
    store: {
      saveMemory: async (
        entry: MemoryEntry,
      ): Promise<RemoteResult<MemoryEntry>> => {
        saved.set(entry.id, entry);
        return { ok: true, data: entry };
      },
      deleteMemory: async (id: string): Promise<RemoteResult<null>> => {
        saved.delete(id);
        return { ok: true, data: null };
      },
    },
  };
}

function scriptChat(scripts: string[]) {
  let index = 0;

  return async (): Promise<string> => {
    const next = scripts[Math.min(index, scripts.length - 1)];
    index += 1;
    return next;
  };
}

beforeEach(() => {
  clearExecutionCache();
});

describe("memory.create plan", () => {
  it("validates a well-formed memory plan", () => {
    assert.equal(
      isAssistantPlan({
        type: "memory.create",
        entry: {
          category: "preferences",
          title: "Kaffee",
          content: "Trinkt morgens Filterkaffee.",
        },
      }),
      true,
    );
  });

  it("rejects unknown categories and empty content", () => {
    assert.equal(
      isAssistantPlan({
        type: "memory.create",
        entry: { category: "nope", title: "T", content: "C" },
      }),
      false,
    );
    assert.equal(
      isAssistantPlan({
        type: "memory.create",
        entry: { category: "goals", title: "T", content: "   " },
      }),
      false,
    );
  });

  it("describes the plan in German and Russian", () => {
    const plan = {
      type: "memory.create",
      entry: { category: "goals", title: "Marathon", content: "10 km laufen." },
    } as const;

    assert.match(describePlan(plan, "de"), /Erinnerung speichern/);
    assert.match(describePlan(plan, "ru"), /Сохранить напоминание/);
  });
});

describe("registry coverage", () => {
  it("registers lecture.overview as a read tool", () => {
    const tool = getToolDefinition("lecture.overview");

    assert.notEqual(tool, null);
    assert.equal(tool?.permission, "read");
    assert.equal(typeof MODEL_PARAMS["lecture.overview"], "string");
  });

  it("registers memory.create as a write tool", () => {
    const tool = getToolDefinition("memory.create");

    assert.notEqual(tool, null);
    assert.equal(tool?.permission, "write");
    assert.equal(typeof MODEL_PARAMS["memory.create"], "string");
  });

  it("keeps every registered tool model-addressable", () => {
    for (const tool of ASSISTANT_TOOLS) {
      assert.equal(
        typeof MODEL_PARAMS[tool.id],
        "string",
        `missing MODEL_PARAMS for ${tool.id}`,
      );
    }
  });
});

describe("getLectureOverview", () => {
  it("counts sessions, recordings, and durations", () => {
    const result = getLectureOverview({
      sessions: [SESSION],
      recordings: [
        recording({ id: "a", durationSeconds: 60 }),
        recording({ id: "b", status: "failed", durationSeconds: 0 }),
      ],
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.data.sessionCount, 1);
    assert.equal(result.ok && result.data.recordingCount, 2);
    assert.equal(result.ok && result.data.savedCount, 1);
    assert.equal(result.ok && result.data.failedCount, 1);
    assert.equal(result.ok && result.data.totalDurationSeconds, 60);
  });

  it("returns newest recordings first", () => {
    const result = getLectureOverview({
      sessions: [],
      recordings: [
        recording({ id: "old", createdAt: "2026-10-01T10:00:00.000Z" }),
        recording({ id: "new", createdAt: "2026-10-29T10:00:00.000Z" }),
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok && result.data.recent.map((item) => item.id),
      ["new", "old"],
    );
  });

  it("rejects invalid input", () => {
    assert.equal(
      getLectureOverview({ sessions: null, recordings: [] }).ok,
      false,
    );
    assert.equal(
      getLectureOverview({ sessions: [], recordings: [{ nope: 1 }] }).ok,
      false,
    );
  });
});

describe("executor memory.create", () => {
  function deps(
    memories?: ExecutorDeps["memories"],
  ): ExecutorDeps {
    return {
      events: [],
      finance: EMPTY_FINANCE,
      calendar: {
        create: async () => ({ ok: false, error: "unused" }) as never,
        update: async () => ({ ok: false, error: "unused" }) as never,
        remove: async () => ({ ok: false, error: "unused" }) as never,
      },
      transactions: {
        saveTransaction: async () =>
          ({ ok: false, error: "unused" }) as never,
        deleteTransaction: async () =>
          ({ ok: false, error: "unused" }) as never,
      },
      memories,
      locale: "de",
    };
  }

  it("saves through the store with href and undo", async () => {
    const fake = makeMemoryStore();
    const report = await executePlan(
      {
        type: "memory.create",
        entry: {
          category: "study",
          title: "Prüfung",
          content: "Mathe-Klausur am 12.12.",
        },
      },
      "mem-key-1",
      deps(fake.store),
    );

    assert.equal(report.status, "done");
    assert.equal(report.status === "done" && report.href, "/memory");
    assert.equal(fake.saved.size, 1);

    const undo = report.status === "done" ? report.undo : undefined;
    assert.notEqual(undo, undefined);
    assert.equal(undo?.kind, "remove-memory");
  });

  it("undoes a memory write by deleting it", async () => {
    const fake = makeMemoryStore();
    const report = await executePlan(
      {
        type: "memory.create",
        entry: { category: "goals", title: "T", content: "C" },
      },
      "mem-key-2",
      deps(fake.store),
    );

    assert.equal(report.status, "done");

    const undone = await executeUndo(
      { kind: "remove-memory", id: "mem-key-2" },
      deps(fake.store),
    );

    assert.equal(undone.ok, true);
    assert.equal(fake.saved.size, 0);
  });

  it("fails honestly without a memory store", async () => {
    const report = await executePlan(
      {
        type: "memory.create",
        entry: { category: "goals", title: "T", content: "C" },
      },
      "mem-key-3",
      deps(undefined),
    );

    assert.equal(report.status, "error");
  });
});

describe("agent turns perform actions", () => {
  it("reads the lecture library via lecture.overview", async () => {
    const outcome = await runAgent("Was habe ich aufgenommen?", {
      chat: scriptChat([
        '{"tool": "lecture.overview", "args": {}}',
        '{"final": "Eine Aufnahme: Vorlesung 1 (Mathe I)."}',
      ]),
      data: makeData(),
      stores: {
        calendar: {
          create: async () => ({ ok: false, error: "unused" }) as never,
          update: async () => ({ ok: false, error: "unused" }) as never,
          remove: async () => ({ ok: false, error: "unused" }) as never,
        },
        transactions: {
          saveTransaction: async () =>
            ({ ok: false, error: "unused" }) as never,
          deleteTransaction: async () =>
            ({ ok: false, error: "unused" }) as never,
        },
      } satisfies AgentStores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");
    assert.equal(
      outcome.status === "done" &&
        outcome.steps.some(
          (step) => step.tool === "lecture.overview" && step.ok,
        ),
      true,
    );
  });

  it("saves a memory via memory.create with undo", async () => {
    const fake = makeMemoryStore();
    const outcome = await runAgent("Merk dir, dass ich Max heiße.", {
      chat: scriptChat([
        '{"tool": "memory.create", "args": {"entry": {"category": "preferences", "title": "Name", "content": "Der Nutzer heißt Max."}}}',
        '{"final": "Gemerkt: Du heißt Max."}',
      ]),
      data: makeData(),
      stores: {
        calendar: {
          create: async () => ({ ok: false, error: "unused" }) as never,
          update: async () => ({ ok: false, error: "unused" }) as never,
          remove: async () => ({ ok: false, error: "unused" }) as never,
        },
        transactions: {
          saveTransaction: async () =>
            ({ ok: false, error: "unused" }) as never,
          deleteTransaction: async () =>
            ({ ok: false, error: "unused" }) as never,
        },
        memories: fake.store,
      } satisfies AgentStores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");
    assert.equal(fake.saved.size, 1);
    assert.equal(
      outcome.status === "done" &&
        outcome.undos.some((entry) => entry.tool === "memory.create"),
      true,
    );
  });
});

describe("turnHref", () => {
  it("links memory and lecture turns", () => {
    assert.equal(
      turnHref([{ tool: "memory.create", label: "x", ok: true, detail: null }]),
      "/memory",
    );
    assert.equal(
      turnHref([{ tool: "lecture.overview", label: "x", ok: true, detail: null }]),
      "/lecture",
    );
  });
});
