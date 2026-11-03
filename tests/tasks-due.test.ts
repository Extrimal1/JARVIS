/**
 * Task due dates: model validation, overdue detection, assistant
 * contract (plan + NLU + executor), API mapping, and notifications.
 * Legacy tasks without a due date behave exactly like before.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatDueDate,
  isTask,
  isTaskOverdue,
  type Task,
} from "@/src/lib/tasks";
import {
  describePlan,
  isAssistantPlan,
} from "@/src/lib/assistant/actions";
import { parseCommand } from "@/src/lib/assistant/nlu";
import type { NluContext } from "@/src/lib/assistant/actions";
import { getOpenTasks } from "@/src/lib/assistant/tools";
import {
  clearExecutionCache,
  executePlan,
  type ExecutorDeps,
} from "@/src/lib/assistant/executor";
import { tasksConfig } from "@/src/lib/api/modules/tasks";
import { checkFailed } from "@/src/lib/api/crud";
import { buildNotifications } from "@/src/lib/dashboard";
import { EMPTY_FINANCE } from "@/src/lib/finance";
import type { RemoteResult } from "@/src/lib/db/useRemoteResource";

function task(patch: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Lesen",
    time: "Keine Frist",
    done: false,
    priority: "Mittel",
    ...patch,
  };
}

const CTX: NluContext = {
  todayISO: "2026-10-27",
  nowTime: "10:00",
  timezone: "Europe/Berlin",
  locale: "de",
};

function makeTaskStore() {
  const saved = new Map<string, Task>();

  return {
    saved,
    store: {
      saveTask: async (item: Task): Promise<RemoteResult<Task>> => {
        saved.set(item.id, item);
        return { ok: true, data: item };
      },
      deleteTask: async (id: string): Promise<RemoteResult<null>> => {
        saved.delete(id);
        return { ok: true, data: null };
      },
    },
  };
}

function deps(tasks: ExecutorDeps["tasks"]): ExecutorDeps {
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

beforeEach(() => {
  clearExecutionCache();
});

describe("task model", () => {
  it("accepts legacy tasks without a due date", () => {
    assert.equal(isTask(task()), true);
    assert.equal(
      isTask({ ...task(), dueDate: undefined }),
      true,
    );
  });

  it("accepts valid due dates and rejects invalid ones", () => {
    assert.equal(isTask(task({ dueDate: "2026-11-05" })), true);
    assert.equal(isTask(task({ dueDate: "2026-13-45" })), false);
    assert.equal(isTask(task({ dueDate: "" })), false);
    assert.equal(
      isTask({ ...task(), dueDate: 20261105 } as unknown),
      false,
    );
  });

  it("detects overdue only for open tasks past their due date", () => {
    assert.equal(
      isTaskOverdue(task({ dueDate: "2026-11-02" }), "2026-11-03"),
      true,
    );
    assert.equal(
      isTaskOverdue(task({ dueDate: "2026-11-03" }), "2026-11-03"),
      false,
    );
    assert.equal(
      isTaskOverdue(task({ dueDate: "2026-11-04" }), "2026-11-03"),
      false,
    );
    assert.equal(
      isTaskOverdue(
        task({ dueDate: "2026-11-02", done: true }),
        "2026-11-03",
      ),
      false,
    );
    assert.equal(isTaskOverdue(task(), "2026-11-03"), false);
  });

  it("formats due labels without inventing dates", () => {
    assert.equal(formatDueDate("2026-11-05"), "05.11.");
    assert.equal(formatDueDate("nope"), "nope");
  });
});

describe("getOpenTasks with due dates", () => {
  const pool = [
    task({ id: "past", dueDate: "2026-11-02" }),
    task({ id: "future", dueDate: "2026-11-10" }),
    task({ id: "undated-early", time: "08:00" }),
    task({ id: "undated-none", time: "Keine Frist" }),
  ];

  it("flags past-due tasks when todayISO is given", () => {
    const result = getOpenTasks({
      tasks: pool,
      nowTime: "12:00",
      todayISO: "2026-11-03",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok
        ? result.data.overdue.map((item) => item.id).sort()
        : [],
      ["past", "undated-early"],
    );
  });

  it("keeps legacy time-only behavior without todayISO", () => {
    const result = getOpenTasks({ tasks: pool, nowTime: "12:00" });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok ? result.data.overdue.map((item) => item.id) : [],
      ["undated-early"],
    );
  });

  it("ignores malformed todayISO instead of guessing", () => {
    const result = getOpenTasks({
      tasks: pool,
      nowTime: "12:00",
      todayISO: "gestern",
    });

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.ok ? result.data.overdue.map((item) => item.id) : [],
      ["undated-early"],
    );
  });
});

describe("tasks.create plan with due dates", () => {
  it("validates optional due dates", () => {
    assert.equal(
      isAssistantPlan({
        type: "tasks.create",
        task: {
          title: "Steuern",
          time: "Keine Frist",
          priority: "Hoch",
          dueDate: "2026-11-30",
        },
      }),
      true,
    );
    assert.equal(
      isAssistantPlan({
        type: "tasks.create",
        task: {
          title: "Steuern",
          time: "Keine Frist",
          priority: "Hoch",
          dueDate: "30.11.2026",
        },
      }),
      false,
    );
  });

  it("mentions the due date in the plan description", () => {
    const plan = {
      type: "tasks.create",
      task: {
        title: "Steuern",
        time: "Keine Frist",
        priority: "Hoch",
        dueDate: "2026-11-30",
      },
    } as const;

    assert.match(describePlan(plan, "de"), /30\.11\./);
  });

  it("parses relative due dates from task commands", () => {
    const { plan } = parseCommand(
      "Erstelle eine Aufgabe morgen: Bericht schreiben",
      CTX,
    );

    assert.equal(plan.type, "tasks.create");
    if (plan.type !== "tasks.create") return;

    assert.equal(plan.task.dueDate, "2026-10-28");
    assert.ok(!plan.task.title.includes("morgen"));
  });

  it("leaves tasks dateless when no date is mentioned", () => {
    const { plan } = parseCommand(
      "Erstelle eine Aufgabe: Arzt anrufen",
      CTX,
    );

    assert.equal(plan.type, "tasks.create");
    if (plan.type !== "tasks.create") return;

    assert.equal(plan.task.dueDate, undefined);
  });
});

describe("executor task due dates", () => {
  it("persists the due date through the shared store", async () => {
    const fake = makeTaskStore();
    const report = await executePlan(
      {
        type: "tasks.create",
        task: {
          title: "Steuern",
          time: "Keine Frist",
          priority: "Hoch",
          dueDate: "2026-11-30",
        },
      },
      "due-key-1",
      deps(fake.store),
    );

    assert.equal(report.status, "done");
    assert.equal(fake.saved.get("due-key-1")?.dueDate, "2026-11-30");
    assert.match(
      report.status === "done" ? report.message : "",
      /30\.11\./,
    );
  });

  it("keeps the legacy message for dateless tasks", async () => {
    const fake = makeTaskStore();
    const report = await executePlan(
      {
        type: "tasks.create",
        task: { title: "T", time: "Keine Frist", priority: "Niedrig" },
      },
      "due-key-2",
      deps(fake.store),
    );

    assert.equal(report.status, "done");
    assert.ok(!(report.status === "done" && /fällig/.test(report.message)));
  });
});

describe("tasks API mapping", () => {
  const db = null as never;

  it("maps due_date both ways and omits it when unset", async () => {
    const created = await tasksConfig.checkCreate(
      db,
      task({ dueDate: "2026-11-05" }),
    );

    assert.ok(!checkFailed(created));
    assert.equal(
      !checkFailed(created) &&
        (created.row.due_date as string | undefined),
      "2026-11-05",
    );

    const legacy = await tasksConfig.checkCreate(db, task());

    assert.ok(!checkFailed(legacy));
    assert.ok(!checkFailed(legacy) && !("due_date" in legacy.row));

    const invalid = await tasksConfig.checkCreate(
      db,
      { ...task(), dueDate: "bald" },
    );

    assert.ok(checkFailed(invalid));
  });

  it("patches and clears due dates explicitly", async () => {
    const existing = task({ dueDate: "2026-11-05" });

    const patched = await tasksConfig.checkUpdate(
      db,
      { dueDate: "2026-12-01" },
      existing,
    );

    assert.ok(!checkFailed(patched));
    assert.equal(
      !checkFailed(patched) && (patched.row.due_date as string),
      "2026-12-01",
    );

    const cleared = await tasksConfig.checkUpdate(
      db,
      { dueDate: null },
      existing,
    );

    assert.ok(!checkFailed(cleared));
    assert.equal(
      !checkFailed(cleared) && cleared.row.due_date,
      null,
    );

    const untouched = await tasksConfig.checkUpdate(
      db,
      { title: "Neu" },
      task(),
    );

    assert.ok(!checkFailed(untouched));
    assert.ok(!checkFailed(untouched) && !("due_date" in untouched.row));
  });
});

describe("task overdue notifications", () => {
  function input(tasks: Task[]) {
    return {
      todayISO: "2026-11-03",
      tasks,
      events: [],
      deadlines: [],
      finance: {
        transactions: [],
        monthlyBudgetCents: 0,
        categoryBudgets: {},
        goals: [],
      },
      financeExpenseCents: 0,
      questions: [],
      loaded: {
        tasks: true,
        events: true,
        study: true,
        finance: true,
        quiz: true,
      },
    };
  }

  it("alerts on past-due tasks only", () => {
    const ids = buildNotifications(
      input([
        task({ id: "over", dueDate: "2026-11-01" }),
        task({ id: "open", dueDate: "2026-11-10" }),
        task({ id: "done", dueDate: "2026-11-01", done: true }),
      ]),
    ).map((item) => item.id);

    assert.deepEqual(ids, ["tasks-overdue"]);
  });

  it("stays silent for dateless tasks", () => {
    assert.deepEqual(buildNotifications(input([task()])), []);
  });
});
