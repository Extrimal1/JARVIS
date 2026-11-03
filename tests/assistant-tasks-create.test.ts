/**
 * Assistant task-creation tests: plan validation, registry coverage,
 * executor task writes with undo, and an end-to-end agent turn that
 * PERFORMS the creation (not just describes it). Tasks created this
 * way flow through the shared task store, so they appear in the
 * Dashboard briefing, quick actions, and notifications unchanged.
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
import { turnHref } from "@/src/lib/assistant/transcript";
import { EMPTY_FINANCE } from "@/src/lib/finance";
import { EMPTY_STUDY } from "@/src/lib/study";
import type { Task } from "@/src/lib/tasks";
import type { RemoteResult } from "@/src/lib/db/useRemoteResource";

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
    todayISO: "2026-11-03",
    nowTime: "12:00",
    ...overrides,
  };
}

function makeTaskStore() {
  const saved = new Map<string, Task>();

  return {
    saved,
    store: {
      saveTask: async (task: Task): Promise<RemoteResult<Task>> => {
        saved.set(task.id, task);
        return { ok: true, data: task };
      },
      deleteTask: async (id: string): Promise<RemoteResult<null>> => {
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

describe("tasks.create plan", () => {
  it("validates a well-formed task plan", () => {
    assert.equal(
      isAssistantPlan({
        type: "tasks.create",
        task: { title: "Milch kaufen", time: "18:00", priority: "Mittel" },
      }),
      true,
    );
  });

  it("rejects empty titles, times, and bad priorities", () => {
    assert.equal(
      isAssistantPlan({
        type: "tasks.create",
        task: { title: "", time: "18:00", priority: "Mittel" },
      }),
      false,
    );
    assert.equal(
      isAssistantPlan({
        type: "tasks.create",
        task: { title: "T", time: "", priority: "Mittel" },
      }),
      false,
    );
    assert.equal(
      isAssistantPlan({
        type: "tasks.create",
        task: { title: "T", time: "18:00", priority: "Dringend" },
      }),
      false,
    );
  });

  it("describes the plan in German and Russian", () => {
    const plan = {
      type: "tasks.create",
      task: { title: "Lesen", time: "Keine Frist", priority: "Niedrig" },
    } as const;

    assert.match(describePlan(plan, "de"), /Aufgabe erstellen/);
    assert.match(describePlan(plan, "ru"), /Создать задачу/);
  });
});

describe("tasks.create registry coverage", () => {
  it("registers tasks.create as a write tool", () => {
    const tool = getToolDefinition("tasks.create");

    assert.notEqual(tool, null);
    assert.equal(tool?.permission, "write");
    assert.equal(typeof MODEL_PARAMS["tasks.create"], "string");
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

describe("executor tasks.create", () => {
  function deps(tasks?: ExecutorDeps["tasks"]): ExecutorDeps {
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
      tasks,
      locale: "de",
    };
  }

  it("saves through the store with href and undo", async () => {
    const fake = makeTaskStore();
    const report = await executePlan(
      {
        type: "tasks.create",
        task: { title: "Bericht schreiben", time: "14:00", priority: "Hoch" },
      },
      "task-key-1",
      deps(fake.store),
    );

    assert.equal(report.status, "done");
    assert.equal(report.status === "done" && report.href, "/#aufgaben");
    assert.equal(fake.saved.size, 1);
    assert.equal(fake.saved.get("task-key-1")?.done, false);

    const undo = report.status === "done" ? report.undo : undefined;
    assert.notEqual(undo, undefined);
    assert.equal(undo?.kind, "remove-task");
  });

  it("undoes a task write by deleting it", async () => {
    const fake = makeTaskStore();
    const report = await executePlan(
      {
        type: "tasks.create",
        task: { title: "T", time: "Keine Frist", priority: "Niedrig" },
      },
      "task-key-2",
      deps(fake.store),
    );

    assert.equal(report.status, "done");

    const undone = await executeUndo(
      { kind: "remove-task", id: "task-key-2" },
      deps(fake.store),
    );

    assert.equal(undone.ok, true);
    assert.equal(fake.saved.size, 0);
  });

  it("fails honestly without a task store", async () => {
    const report = await executePlan(
      {
        type: "tasks.create",
        task: { title: "T", time: "Keine Frist", priority: "Niedrig" },
      },
      "task-key-3",
      deps(undefined),
    );

    assert.equal(report.status, "error");
  });
});

describe("agent turn creates a task", () => {
  it("saves via tasks.create with undo", async () => {
    const fake = makeTaskStore();
    const outcome = await runAgent("Erstelle eine Aufgabe: Arzt anrufen.", {
      chat: scriptChat([
        '{"tool": "tasks.create", "args": {"task": {"title": "Arzt anrufen", "time": "Keine Frist", "priority": "Hoch"}}}',
        '{"final": "Aufgabe gespeichert: Arzt anrufen."}',
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
        tasks: fake.store,
      } satisfies AgentStores,
      locale: "de",
    });

    assert.equal(outcome.status, "done");
    assert.equal(fake.saved.size, 1);
    assert.equal(
      outcome.status === "done" &&
        outcome.undos.some((entry) => entry.tool === "tasks.create"),
      true,
    );
  });
});

describe("turnHref for tasks", () => {
  it("links task turns to the dashboard task list", () => {
    assert.equal(
      turnHref([{ tool: "tasks.create", label: "x", ok: true, detail: null }]),
      "/#aufgaben",
    );
  });
});
