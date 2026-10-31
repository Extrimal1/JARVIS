/**
 * Summary row mapping + CRUD validation: DB rows map to the
 * draft/active domain shape and back; creates/updates require a
 * valid shape, a UUID id, and an owned document.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkFailed } from "@/src/lib/api/crud";
import {
  summariesConfig,
  summaryRowToDomain,
  summaryToDbRow,
} from "@/src/lib/api/modules/summaries";
import { dbFor } from "@/src/lib/supabase/db";
import type { SummaryRecord } from "@/src/lib/study/protocol";

const DB = dbFor(
  { url: "https://supabase.test", anonKey: "anon" },
  "token",
  "user-1",
);

const realFetch = globalThis.fetch;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    user_id: "user-1",
    document_id: "doc-1",
    status: "partial",
    active_final_md: "",
    active_final_refs: [],
    active_completed_at: null,
    draft_generation_id: "11111111-1111-4111-8111-111111111111",
    draft_planned: [{ key: "slide:1-2", label: "Folien 1–2", order: 0 }],
    draft_spans: [],
    draft_preview_md: "",
    draft_preview_refs: [],
    draft_started_at: "2026-10-31T09:00:00.000Z",
    ...overrides,
  };
}

function record(overrides: Partial<SummaryRecord> = {}): SummaryRecord {
  return {
    id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    documentId: "doc-1",
    status: "partial",
    active: null,
    draft: {
      generationId: "11111111-1111-4111-8111-111111111111",
      plannedSpans: [{ key: "slide:1-2", label: "Folien 1–2", order: 0 }],
      spans: [],
      preview: null,
      startedAt: "2026-10-31T09:00:00.000Z",
    },
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);

    if (url.startsWith("https://supabase.test/rest/v1/study_documents")) {
      return new Response(JSON.stringify([{ id: "doc-1" }]), { status: 200 });
    }

    throw new Error(`unstubbed fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("summary row mapping", () => {
  it("maps rows to draft/active domain state and back", () => {
    const domain = summaryRowToDomain(row()) as SummaryRecord;

    assert.equal(domain.documentId, "doc-1");
    assert.equal(domain.status, "partial");
    assert.equal(domain.active, null);
    assert.equal(domain.draft?.generationId, "11111111-1111-4111-8111-111111111111");

    const active = summaryRowToDomain(
      row({
        status: "complete",
        active_final_md: "Final.",
        active_final_refs: ["Folien 1–2"],
        active_completed_at: "2026-10-31T10:00:00.000Z",
        draft_generation_id: null,
      }),
    ) as SummaryRecord;

    assert.equal(active.status, "complete");
    assert.equal(active.active?.text, "Final.");
    assert.equal(active.draft, null);

    const back = summaryToDbRow(domain);

    assert.equal(back.document_id, "doc-1");
    assert.equal(
      back.draft_generation_id,
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("creates only valid owned summaries", async () => {
    const ok = await summariesConfig.checkCreate(DB, record());

    assert.equal(checkFailed(ok), false);

    const badId = await summariesConfig.checkCreate(
      DB,
      record({ id: "nope" }),
    );

    assert.equal(checkFailed(badId), true);

    const empty = await summariesConfig.checkCreate(
      DB,
      record({ active: null, draft: null, status: "none" }),
    );

    assert.equal(checkFailed(empty), true);
  });

  it("updates merge patches and forbid document moves", async () => {
    const existing = record();
    const ok = await summariesConfig.checkUpdate(
      DB,
      { status: "complete" },
      existing,
    );

    assert.equal(checkFailed(ok), false);

    if (!checkFailed(ok)) {
      assert.equal(ok.row.status, "complete");
      assert.ok(!("document_id" in ok.row));
    }

    const moved = await summariesConfig.checkUpdate(
      DB,
      { documentId: "doc-2" },
      existing,
    );

    assert.equal(checkFailed(moved), false);

    if (!checkFailed(moved)) {
      assert.ok(!("document_id" in moved.row));
    }
  });
});
