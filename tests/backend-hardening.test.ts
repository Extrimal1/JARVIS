/**
 * Backend hardening tests: Supabase transport retry/timeout behavior,
 * cloud error mapping (migration-pending, unreachable, bad UUID), and
 * migration coverage for every table the API layer touches. PostgREST
 * is mocked — no Supabase required. Local mode needs no cloud calls,
 * so a pending migration only affects cloud mode.
 */
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SupabaseHttpError,
  supaFetchRaw,
} from "@/src/lib/supabase/supabase";
import { failFromUnknown } from "@/src/lib/api/respond";
import { CLOUD_ENABLED } from "@/src/lib/db/mode";

const REAL_FETCH = globalThis.fetch;
const REAL_ERROR = console.error;

const ENV = { url: "https://supabase.test", anonKey: "anon" };

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  console.error = REAL_ERROR;
});

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe("supaFetchRaw retry safety", () => {
  it("retries an idempotent GET once on 503, then succeeds", async () => {
    let calls = 0;

    globalThis.fetch = (async () => {
      calls += 1;

      return calls === 1
        ? jsonResponse({ code: "XX000", message: "bad gateway" }, 503)
        : jsonResponse([{ id: "row-1" }], 200);
    }) as typeof fetch;

    const res = await supaFetchRaw(ENV, "/rest/v1/tasks", { token: "t" });

    assert.equal(res.status, 200);
    assert.equal(calls, 2);
  });

  it("never auto-retries mutations", async () => {
    let calls = 0;

    globalThis.fetch = (async () => {
      calls += 1;

      return jsonResponse({ code: "XX000", message: "bad gateway" }, 503);
    }) as typeof fetch;

    await assert.rejects(
      supaFetchRaw(ENV, "/rest/v1/tasks", { method: "POST", body: {} }),
      (error: unknown) =>
        error instanceof SupabaseHttpError && error.status === 503,
    );
    assert.equal(calls, 1);
  });

  it("does not retry non-transient GET failures", async () => {
    let calls = 0;

    globalThis.fetch = (async () => {
      calls += 1;

      return jsonResponse({ code: "PGRST116", message: "no rows" }, 400);
    }) as typeof fetch;

    await assert.rejects(
      supaFetchRaw(ENV, "/rest/v1/tasks"),
      (error: unknown) =>
        error instanceof SupabaseHttpError && error.status === 400,
    );
    assert.equal(calls, 1);
  });

  it("maps network failure to a status-0 error after one GET retry", async () => {
    let calls = 0;

    globalThis.fetch = (async () => {
      calls += 1;

      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const error = await supaFetchRaw(ENV, "/rest/v1/tasks").then(
      () => null,
      (caught: unknown) => caught,
    );

    assert.ok(error instanceof SupabaseHttpError);
    assert.equal(error.status, 0);
    assert.equal(error.code, "NETWORK_ERROR");
    assert.equal(calls, 2);
  });

  it("aborts a hanging GET and reports TIMEOUT", async () => {
    let calls = 0;

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls += 1;

      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });

      throw new Error("unreachable");
    }) as typeof fetch;

    const error = await supaFetchRaw(ENV, "/rest/v1/tasks", {
      timeoutMs: 25,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    assert.ok(error instanceof SupabaseHttpError);
    assert.equal(error.status, 0);
    assert.equal(error.code, "TIMEOUT");
    assert.equal(calls, 2);
  });

  it("carries the PostgREST error code on failures", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ code: "23505", message: "duplicate key" }, 409)) as typeof fetch;

    const error = await supaFetchRaw(ENV, "/rest/v1/tasks", {
      method: "POST",
      body: {},
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    assert.ok(error instanceof SupabaseHttpError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "23505");
  });
});

describe("failFromUnknown cloud errors", () => {
  async function mapped(error: unknown): Promise<{
    status: number;
    body: unknown;
  }> {
    console.error = () => {};
    const res = (await failFromUnknown("test", error)) as Response;

    return { status: res.status, body: await res.json() };
  }

  it("maps a missing table (PGRST205) to migration-pending", async () => {
    const { status, body } = await mapped(
      new SupabaseHttpError(
        404,
        "Could not find the table 'public.tasks' in the schema cache.",
        "PGRST205",
      ),
    );

    assert.equal(status, 503);
    assert.deepEqual(body, {
      ok: false,
      error: {
        code: "migration-pending",
        message:
          "Cloud-Tabelle fehlt (Supabase-Migration ausstehend). Bitte wende die Migrationen in supabase/migrations an.",
      },
    });
  });

  it("maps a missing column (PGRST204) to migration-pending", async () => {
    const { status, body } = await mapped(
      new SupabaseHttpError(
        400,
        "Could not find the 'topic_data' column in the schema cache.",
        "PGRST204",
      ),
    );

    assert.equal(status, 503);
    assert.equal(
      (body as { error: { code: string } }).error.code,
      "migration-pending",
    );
  });

  it("detects migration drift by message when no code is present", async () => {
    const { status, body } = await mapped(
      new SupabaseHttpError(
        404,
        'relation "public.study_summaries" does not exist',
      ),
    );

    assert.equal(status, 503);
    assert.equal(
      (body as { error: { code: string } }).error.code,
      "migration-pending",
    );
  });

  it("maps malformed UUIDs (22P02) to a clear bad-request", async () => {
    const { status, body } = await mapped(
      new SupabaseHttpError(
        400,
        'invalid input syntax for type uuid: "legacy-1"',
        "22P02",
      ),
    );

    assert.equal(status, 400);
    assert.deepEqual(body, {
      ok: false,
      error: { code: "bad-request", message: "Ungültige ID (UUID erwartet)." },
    });
  });

  it("maps unreachable cloud to a clear upstream-error", async () => {
    const { status, body } = await mapped(
      new SupabaseHttpError(0, "Supabase request failed (network).", "NETWORK_ERROR"),
    );

    assert.equal(status, 502);
    assert.deepEqual(body, {
      ok: false,
      error: {
        code: "upstream-error",
        message:
          "Cloud-Backend nicht erreichbar. Bitte Verbindung prüfen und erneut versuchen.",
      },
    });
  });

  it("keeps existing mappings (conflict, unauthorized, fallback)", async () => {
    const conflict = await mapped(new SupabaseHttpError(409, "duplicate"));
    assert.equal(conflict.status, 409);

    const expired = await mapped(new SupabaseHttpError(401, "expired"));
    assert.equal(expired.status, 401);

    const fallback = await mapped(new Error("boom"));
    assert.equal(fallback.status, 502);
    assert.equal(
      (fallback.body as { error: { code: string } }).error.code,
      "upstream-error",
    );
  });
});

describe("migration coverage for API tables", () => {
  const MIGRATIONS_URL = new URL("../supabase/migrations/", import.meta.url);
  const MODULES_URL = new URL("../src/lib/api/modules/", import.meta.url);

  const combinedSql = readdirSync(MIGRATIONS_URL)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => readFileSync(new URL(name, MIGRATIONS_URL), "utf8"))
    .join("\n");

  /** Every table the API layer reads or writes (configs + direct calls). */
  const EXPECTED_TABLES = [
    "tasks",
    "calendar_events",
    "study_entries",
    "quiz_questions",
    "finance_import_batches",
    "finance_transactions",
    "finance_settings",
    "category_budgets",
    "savings_goals",
    "finance_category_corrections",
    "lifestyle_places",
    "lifestyle_events",
    "lifestyle_saved",
    "lifestyle_plans",
    "lifestyle_preferences",
    "memory_entries",
    "study_documents",
    "user_settings",
    "lecture_sessions",
    "lecture_recordings",
    "transcript_segments",
    "lecture_insights",
    "lecture_source_links",
    "processing_jobs",
    "retrieval_chunks",
    "conversation_threads",
    "conversation_messages",
    "study_summaries",
    "study_review_events",
  ];

  it("ships CREATE TABLE + RLS + owner policies for every API table", () => {
    assert.ok(EXPECTED_TABLES.length > 0);

    for (const table of EXPECTED_TABLES) {
      assert.match(
        combinedSql,
        new RegExp(`create table public\\.${table}\\b`),
        `missing CREATE TABLE for ${table} (migration pending?)`,
      );
      assert.match(
        combinedSql,
        new RegExp(
          `alter table public\\.${table} enable row level security`,
        ),
        `missing RLS enable for ${table}`,
      );

      const policies =
        combinedSql.match(
          new RegExp(`create policy .+ on public\\.${table}\\b`, "g"),
        ) ?? [];

      // study_review_events is append-only (select+insert); the rest
      // carry the full select/insert/update/delete owner set.
      assert.ok(
        policies.length >= 2,
        `expected owner policies for ${table}, found ${policies.length}`,
      );
    }
  });

  it("covers every CrudConfig table declared in API modules", () => {
    const declared = new Set<string>();

    for (const name of readdirSync(MODULES_URL)) {
      if (!name.endsWith(".ts")) continue;

      const source = readFileSync(new URL(name, MODULES_URL), "utf8");

      for (const match of source.matchAll(/table: "(\w+)"/g)) {
        const table = match[1];

        if (table !== undefined) declared.add(table);
      }
    }

    assert.ok(declared.size > 0);

    for (const table of declared) {
      assert.ok(
        EXPECTED_TABLES.includes(table),
        `API module table "${table}" has no migration coverage entry`,
      );
    }
  });
});

describe("local-first default", () => {
  it("derives the backend mode from the env flag only", () => {
    assert.equal(typeof CLOUD_ENABLED, "boolean");
    assert.equal(CLOUD_ENABLED, process.env.NEXT_PUBLIC_CLOUD_ENABLED === "1");
  });
});
