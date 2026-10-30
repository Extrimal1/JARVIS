/**
 * Conversation persistence tests: CRUD handlers scope every query to
 * the authenticated user, message creates verify thread ownership
 * (cross-user attaches rejected), and the migration ships RLS.
 * PostgREST is mocked — no Supabase required. Live RLS enforcement
 * additionally needs a provisioned project (see report).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { crudHandlers } from "@/src/lib/api/crud";
import {
  conversationMessagesConfig,
  conversationThreadsConfig,
} from "@/src/lib/api/modules/conversations";
import type { DbClient } from "@/src/lib/supabase/db";

const REAL_FETCH = globalThis.fetch;

type SeenCall = { url: string; method: string; body: unknown };

let seen: SeenCall[] = [];

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  seen = [];
});

function mockPostgrest(payloads: unknown[]): void {
  let index = 0;

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const payload = payloads[Math.min(index, payloads.length - 1)];
    index += 1;

    let body: unknown;

    try {
      body =
        init?.body === undefined ? undefined : JSON.parse(init.body as string);
    } catch {
      body = init?.body;
    }

    seen.push({ url: String(url), method: init?.method ?? "GET", body });

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
    };
  }) as unknown as typeof fetch;
}

const DB: DbClient = {
  env: { url: "https://test.supabase.co", anonKey: "anon" },
  token: "token-1",
  userId: "user-1",
};

const THREAD_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MESSAGE_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const THREAD_ROW = {
  id: THREAD_ID,
  user_id: "user-1",
  version: 1,
  title: "Hallo",
  locale: "de",
  module: "assistant",
  created_at: "2026-10-30T12:00:00.000Z",
  updated_at: "2026-10-30T12:00:00.000Z",
};

const MESSAGE_ROW = {
  id: MESSAGE_ID,
  user_id: "user-1",
  version: 1,
  thread_id: THREAD_ID,
  seq: 0,
  role: "user",
  content: "Hallo",
  tool_name: null,
  created_at: "2026-10-30T12:00:00.000Z",
};

const THREAD_INPUT = {
  id: THREAD_ID,
  version: 1,
  title: "Hallo",
  locale: "de",
  module: "assistant",
  createdAt: "2026-10-30T12:00:00.000Z",
  updatedAt: "2026-10-30T12:00:00.000Z",
};

const MESSAGE_INPUT = {
  id: MESSAGE_ID,
  version: 1,
  threadId: THREAD_ID,
  seq: 0,
  role: "user",
  content: "Hallo",
  toolName: null,
  createdAt: "2026-10-30T12:00:00.000Z",
};

describe("conversation threads CRUD", () => {
  const handlers = crudHandlers(conversationThreadsConfig);

  it("scopes lists to the authenticated user", async () => {
    mockPostgrest([[]]);

    const outcome = await handlers.list(DB);

    assert.equal(outcome.ok, true);
    assert.equal(seen.length, 1);
    assert.match(seen[0]?.url ?? "", /\/rest\/v1\/conversation_threads\?/);
    assert.match(seen[0]?.url ?? "", /user_id=eq\.user-1/);
  });

  it("forces user_id on insert and maps the row back", async () => {
    mockPostgrest([[THREAD_ROW]]);

    const outcome = await handlers.create(DB, {
      ...THREAD_INPUT,
      user_id: "user-2",
    });

    assert.equal(outcome.ok, true);
    assert.equal(seen[0]?.method, "POST");

    const body = seen[0]?.body as Record<string, unknown>[];

    assert.equal(body[0]?.user_id, "user-1");
    assert.equal(body[0]?.title, "Hallo");

    if (!outcome.ok) return;

    assert.equal(
      (outcome.data as { id?: unknown }).id,
      THREAD_ID,
    );
  });

  it("rejects invalid threads and non-UUID ids without querying", async () => {
    mockPostgrest([[]]);

    assert.deepEqual(await handlers.create(DB, { nope: true }), {
      ok: false,
      message: "Ungültige Konversation.",
    });
    assert.deepEqual(
      await handlers.create(DB, { ...THREAD_INPUT, id: "legacy-1" }),
      { ok: false, message: "Ungültige Konversation." },
    );
    assert.equal(seen.length, 0);
  });

  it("merges title patches and reports missing threads", async () => {
    mockPostgrest([[THREAD_ROW], [{ ...THREAD_ROW, title: "Neu" }]]);

    const outcome = await handlers.update(DB, THREAD_ID, { title: "Neu" });

    assert.equal(outcome.ok, true);

    if (!outcome.ok) return;

    assert.equal((outcome.data as { title?: unknown }).title, "Neu");
    assert.match(seen[1]?.url ?? "", /user_id=eq\.user-1/);

    mockPostgrest([[]]);

    assert.deepEqual(await handlers.update(DB, THREAD_ID, { title: "x" }), {
      ok: false,
      missing: true,
    });
  });

  it("scopes deletes to the authenticated user", async () => {
    mockPostgrest([[]]);

    const outcome = await handlers.remove(DB, THREAD_ID);

    assert.equal(outcome.ok, true);
    assert.equal(seen[0]?.method, "DELETE");
    assert.match(seen[0]?.url ?? "", /user_id=eq\.user-1/);
    assert.match(seen[0]?.url ?? "", new RegExp(`id=eq\\.${THREAD_ID}`));
  });
});

describe("conversation messages CRUD", () => {
  const handlers = crudHandlers(conversationMessagesConfig);

  it("rejects attaches to foreign or missing threads", async () => {
    // dbGetOne finds no owned thread (missing-or-foreign is uniform).
    mockPostgrest([[]]);

    const outcome = await handlers.create(DB, MESSAGE_INPUT);

    assert.deepEqual(outcome, {
      ok: false,
      message: "Unbekannte Konversation.",
    });
    assert.equal(seen.length, 1);
    assert.match(seen[0]?.url ?? "", /\/rest\/v1\/conversation_threads\?/);
    assert.match(seen[0]?.url ?? "", /user_id=eq\.user-1/);
  });

  it("inserts messages only into owned threads", async () => {
    mockPostgrest([[THREAD_ROW], [MESSAGE_ROW]]);

    const outcome = await handlers.create(DB, MESSAGE_INPUT);

    assert.equal(outcome.ok, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]?.method, "POST");

    const body = seen[1]?.body as Record<string, unknown>[];

    assert.equal(body[0]?.user_id, "user-1");
    assert.equal(body[0]?.thread_id, THREAD_ID);
  });

  it("rejects invalid messages without querying", async () => {
    mockPostgrest([[]]);

    assert.deepEqual(
      await handlers.create(DB, { ...MESSAGE_INPUT, role: "root" }),
      { ok: false, message: "Ungültige Nachricht." },
    );
    assert.deepEqual(
      await handlers.create(DB, { ...MESSAGE_INPUT, id: "legacy-9" }),
      { ok: false, message: "Ungültige Nachricht." },
    );
    assert.equal(seen.length, 0);
  });

  it("treats messages as immutable", async () => {
    mockPostgrest([[MESSAGE_ROW]]);

    assert.deepEqual(
      await handlers.update(DB, MESSAGE_ID, { content: " adjusted" }),
      { ok: false, message: "Nachrichten sind unveränderlich." },
    );
  });

  it("scopes lists to the authenticated user", async () => {
    mockPostgrest([[]]);

    await handlers.list(DB);

    assert.match(seen[0]?.url ?? "", /\/rest\/v1\/conversation_messages\?/);
    assert.match(seen[0]?.url ?? "", /user_id=eq\.user-1/);
  });
});

describe("0005_conversations migration", () => {
  const sql = readFileSync(
    new URL("../supabase/migrations/0005_conversations.sql", import.meta.url),
    "utf8",
  );

  function count(pattern: RegExp): number {
    return sql.match(pattern)?.length ?? 0;
  }

  it("creates both tables with ownership and order columns", () => {
    assert.match(sql, /create table public\.conversation_threads/);
    assert.match(sql, /create table public\.conversation_messages/);
    assert.match(
      sql,
      /user_id uuid not null references auth\.users \(id\) on delete cascade/,
    );
    assert.match(
      sql,
      /thread_id uuid not null references public\.conversation_threads \(id\) on delete cascade/,
    );
    assert.match(sql, /seq integer not null/);
    assert.match(
      sql,
      /role text not null check \(role in \('user', 'assistant', 'tool', 'system'\)\)/,
    );
    assert.match(
      sql,
      /create index conversation_messages_thread_idx on public\.conversation_messages \(thread_id, seq\)/,
    );
  });

  it("enables RLS with owner-only policies on both tables", () => {
    assert.equal(
      count(/alter table public\.conversation_\w+ enable row level security/g),
      2,
    );
    assert.equal(count(/for select to authenticated/g), 2);
    assert.equal(count(/for insert to authenticated/g), 2);
    assert.equal(count(/for update to authenticated/g), 2);
    assert.equal(count(/for delete to authenticated/g), 2);
    assert.ok(count(/auth\.uid\(\) = user_id/g) >= 8);
  });

  it("stores no secrets or API keys", () => {
    assert.doesNotMatch(sql, /api[_-]?key/i);
    assert.doesNotMatch(sql, /secret/i);
    assert.doesNotMatch(sql, /password/i);
    assert.doesNotMatch(sql, /token/i);
  });
});
