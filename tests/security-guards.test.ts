/**
 * Security-guards tests: login rate limiting, post-login redirect
 * safety, honest DELETE semantics, mutation-safe 401 handling,
 * reload-proof executor idempotency, and the 0016 RLS-hardening
 * migration contract. No network, no Supabase — fetch and
 * localStorage are stubbed.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeNext } from "@/src/lib/safeNext";
import {
  checkRateLimit,
  LOGIN_RATE_LIMIT,
  type RateLimitStore,
} from "@/src/lib/api/rateLimit";
import {
  crudHandlers,
  outcomeStatus,
  type CrudConfig,
} from "@/src/lib/api/crud";
import { dbFor } from "@/src/lib/supabase/db";
import {
  clearExecutionCache,
  evictExecutionMemory,
  executePlan,
  type ActionPlan,
  type ExecutorDeps,
} from "@/src/lib/assistant/executor";
import { EMPTY_FINANCE } from "@/src/lib/finance";
import type { Task } from "@/src/lib/tasks";
import type { RemoteResult } from "@/src/lib/db/useRemoteResource";

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("safeNext", () => {
  it("passes through plain app paths", () => {
    assert.equal(safeNext("/study?tab=documents"), "/study?tab=documents");
    assert.equal(safeNext("/"), "/");
    assert.equal(safeNext("/briefing"), "/briefing");
  });

  it("rejects protocol-relative and absolute targets", () => {
    assert.equal(safeNext("//evil.com"), "/");
    assert.equal(safeNext("https://evil.com"), "/");
    assert.equal(safeNext("javascript:alert(1)"), "/");
  });

  it("rejects backslash tricks, empties, and control chars", () => {
    assert.equal(safeNext("/\\evil.com"), "/");
    assert.equal(safeNext("/ok\\evil"), "/");
    assert.equal(safeNext(""), "/");
    assert.equal(safeNext(null), "/");
    assert.equal(safeNext(undefined), "/");
    assert.equal(safeNext("/a\u0007b"), "/");
    assert.equal(safeNext("study"), "/");
  });
});

describe("login rate limit", () => {
  it("allows attempts up to the cap, then blocks", () => {
    const store: RateLimitStore = new Map();
    const now = 1_000_000;

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) {
      assert.equal(
        checkRateLimit(store, "ip:user@test.de", LOGIN_RATE_LIMIT, now + i),
        true,
      );
    }

    assert.equal(
      checkRateLimit(
        store,
        "ip:user@test.de",
        LOGIN_RATE_LIMIT,
        now + LOGIN_RATE_LIMIT.maxAttempts,
      ),
      false,
    );
  });

  it("slides the window and isolates keys", () => {
    const store: RateLimitStore = new Map();
    const now = 5_000_000;

    for (let i = 0; i < LOGIN_RATE_LIMIT.maxAttempts; i += 1) {
      checkRateLimit(store, "ip:a@test.de", LOGIN_RATE_LIMIT, now);
    }

    assert.equal(
      checkRateLimit(store, "ip:a@test.de", LOGIN_RATE_LIMIT, now + 1),
      false,
    );
    // Another account from the same IP is unaffected.
    assert.equal(
      checkRateLimit(store, "ip:b@test.de", LOGIN_RATE_LIMIT, now + 1),
      true,
    );
    // After the window passes, the key works again.
    assert.equal(
      checkRateLimit(
        store,
        "ip:a@test.de",
        LOGIN_RATE_LIMIT,
        now + LOGIN_RATE_LIMIT.windowMs + 1,
      ),
      true,
    );
  });
});

describe("honest DELETE", () => {
  const config: CrudConfig = {
    table: "tasks",
    toDomain: (row) => row,
    isList: Array.isArray,
    checkCreate: () => ({ message: "unused" }),
    checkUpdate: () => ({ message: "unused" }),
  };
  const db = dbFor({ url: "https://supabase.test", anonKey: "anon" }, "t", "u");

  it("reports missing for a missing-or-foreign id without deleting", async () => {
    let deletes = 0;

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);

      if (init?.method === "DELETE") {
        deletes += 1;
      }

      // dbGetOne: empty list → missing.
      return url.includes("/rest/v1/tasks?") && init?.method !== "DELETE"
        ? jsonResponse([], 200)
        : jsonResponse([], 200);
    }) as typeof fetch;

    const outcome = await crudHandlers(config).remove(db, "no-such-id");

    assert.deepEqual(outcome, { ok: false, missing: true });
    assert.equal(deletes, 0);
    assert.deepEqual(outcomeStatus(outcome), {
      status: "not-found",
      message: "Eintrag nicht gefunden.",
    });
  });

  it("deletes an existing row and reports success", async () => {
    let deletes = 0;

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deletes += 1;

        return new Response(null, { status: 204 });
      }

      return jsonResponse([{ id: "t1", user_id: "u" }], 200);
    }) as typeof fetch;

    const outcome = await crudHandlers(config).remove(db, "t1");

    assert.deepEqual(outcome, { ok: true, data: null });
    assert.equal(deletes, 1);
    assert.deepEqual(outcomeStatus(outcome), {
      status: "ok",
      message: "",
    });
  });
});

describe("401 handling", () => {
  it("navigates to login on GET expiry, preserves edits on mutations", async () => {
    const { apiUnknown } = await import("@/src/lib/db/useRemoteResource");

    globalThis.fetch = (async () =>
      jsonResponse(
        { ok: false, error: { code: "unauthorized", message: "x" } },
        401,
      )) as typeof fetch;

    // Fake browser window: GET navigates away.
    const location = { href: "https://app.test/study", pathname: "/study" };
    (globalThis as { window?: unknown }).window = { location };

    try {
      const get = await apiUnknown("/api/tasks", "GET");

      assert.equal(get.ok, false);
      assert.ok(
        !get.ok && get.error === "Sitzung abgelaufen.",
        "GET keeps the short message",
      );
      assert.equal(location.href, "/login?next=%2Fstudy");

      // Mutations report without navigating (input stays on screen).
      location.href = "https://app.test/study";
      const post = await apiUnknown("/api/tasks", "POST", { id: "t1" });

      assert.equal(post.ok, false);
      assert.ok(
        !post.ok && post.error.includes("Eingabe bleibt erhalten"),
        "mutation promises preserved input",
      );
      assert.equal(post.ok, false);
      assert.ok(!post.ok && post.status === 401);
      assert.equal(location.href, "https://app.test/study");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe("executor idempotency across reloads", () => {
  function memoryStorage(): Storage {
    const data = new Map<string, string>();

    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
      clear: () => data.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  }

  function deps(calls: string[]): ExecutorDeps {
    const saved = new Map<string, Task>();

    return {
      events: [],
      finance: EMPTY_FINANCE,
      calendar: {
        create: async (event) => ({ ok: true, data: event }),
        update: async (id, patch) => ({
          ok: false,
          error: `missing ${id} ${JSON.stringify(patch)}`,
        }),
        remove: async () => ({ ok: true, data: null }),
      },
      transactions: {
        saveTransaction: async (tx) => ({ ok: true, data: tx }),
        deleteTransaction: async () => ({ ok: true, data: null }),
      },
      tasks: {
        saveTask: async (task: Task): Promise<RemoteResult<Task>> => {
          calls.push(task.id);
          saved.set(task.id, task);

          return { ok: true, data: task };
        },
        deleteTask: async () => ({ ok: true, data: null }),
      },
      locale: "de",
    };
  }

  const plan: ActionPlan = {
    type: "tasks.create",
    task: { title: "Bericht schreiben", time: "18:00", priority: "Mittel" },
  };

  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage =
      memoryStorage();
    clearExecutionCache();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    clearExecutionCache();
  });

  it("survives a reload: same key never re-runs", async () => {
    const calls: string[] = [];
    const first = await executePlan(plan, "reload-key-1", deps(calls));

    assert.equal(first.status, "done");
    assert.equal(calls.length, 1);

    // Simulate a reload: memory is gone, disk remains.
    evictExecutionMemory();

    const second = await executePlan(plan, "reload-key-1", deps(calls));

    assert.deepEqual(second, first);
    assert.equal(calls.length, 1);
  });

  it("ignores corrupt or expired disk entries and re-runs honestly", async () => {
    const store = globalThis as unknown as { localStorage: Storage };
    store.localStorage.setItem(
      "jarvis.executor.reports.v1",
      JSON.stringify([
        { key: "bad-shape" },
        {
          key: "stale-key",
          at: Date.now() - 25 * 60 * 60 * 1000,
          report: { status: "done", message: "alt" },
        },
      ]),
    );

    const calls: string[] = [];
    const report = await executePlan(plan, "stale-key", deps(calls));

    assert.equal(report.status, "done");
    assert.equal(calls.length, 1);
  });
});

describe("migration 0016 contract", () => {
  const SQL = readFileSync(
    new URL("../supabase/migrations/0016_link_ownership.sql", import.meta.url),
    "utf8",
  );

  it("is review-only and touches no data", () => {
    assert.ok(SQL.includes("REVIEW-ONLY"));
    assert.ok(!/drop\s+table/i.test(SQL));
    assert.ok(!/delete\s+from/i.test(SQL));
    assert.ok(!/truncate/i.test(SQL));
  });

  it("hardens every link-bearing table", () => {
    for (const policy of [
      "study_review_events_insert_own",
      "quiz_questions_insert_own",
      "quiz_questions_update_own",
      "study_entries_insert_own",
      "study_entries_update_own",
      "study_summaries_insert_own",
      "study_summaries_update_own",
      "conversation_messages_insert_own",
      "finance_transactions_insert_own",
      "finance_transactions_update_own",
      "lifestyle_saved_insert_own",
      "lecture_sessions_insert_own",
      "lecture_recordings_insert_own",
      "transcript_segments_insert_own",
      "lecture_insights_insert_own",
      "lecture_source_links_insert_own",
      "processing_jobs_insert_own",
      "retrieval_chunks_insert_own",
      "lecture_study_guides_insert_own",
      "lecture_flashcards_insert_own",
      "lecture_card_reviews_insert_own",
      "lecture_exam_attempts_insert_own",
      "lecture_tutor_threads_insert_own",
      "lecture_tutor_messages_insert_own",
    ]) {
      assert.ok(
        SQL.includes(policy),
        `missing hardened policy ${policy}`,
      );
    }

    // Every ownership subquery scopes to the caller.
    const subqueries = SQL.match(/user_id = auth\.uid\(\)/g) ?? [];
    assert.ok(subqueries.length >= 24);
  });
});
