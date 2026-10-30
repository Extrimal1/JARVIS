/**
 * Route-glue tests: the real `/api/assistant` handlers run with a
 * minimal `next/server` stand-in (local mode: no login required).
 * Cloud-mode auth gating reuses the tested `authed()` wrapper and is
 * verified by inspection, not here (it needs a live Supabase).
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "@/app/api/assistant/route";

// The engine default is Ollama; these glue tests pin the explicit
// heuristic opt-in for deterministic, network-free parsing.
const SAVED_PROVIDER = process.env.ASSISTANT_PROVIDER;

beforeEach(() => {
  process.env.ASSISTANT_PROVIDER = "heuristic";
});

afterEach(() => {
  if (SAVED_PROVIDER === undefined) delete process.env.ASSISTANT_PROVIDER;
  else process.env.ASSISTANT_PROVIDER = SAVED_PROVIDER;
});

const BODY = {
  text: "Plane morgen um 15:30 Uhr ein einstündiges Treffen mit Max.",
  todayISO: "2026-10-27",
  nowTime: "10:00",
  timezone: "Europe/Berlin",
  locale: "de",
  idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
};

type Envelope =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

const callPost = POST as unknown as (
  request: Request,
  route: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const callGet = GET as unknown as (
  route: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const NO_PARAMS = { params: Promise.resolve({}) };

async function postJson(body: unknown): Promise<{
  status: number;
  envelope: Envelope;
}> {
  const response = await callPost(
    new Request("http://localhost/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    NO_PARAMS,
  );

  return {
    status: response.status,
    envelope: (await response.json()) as Envelope,
  };
}

describe("GET /api/assistant", () => {
  it("reports the provider status without secrets", async () => {
    const response = await callGet(NO_PARAMS);
    const envelope = (await response.json()) as Envelope;

    assert.equal(response.status, 200);
    assert.equal(envelope.ok, true);

    if (!envelope.ok) return;

    assert.equal(envelope.data.provider, "heuristic");
    assert.equal(envelope.data.configured, true);
    assert.equal("baseUrl" in envelope.data, false);
    assert.equal("model" in envelope.data, false);
  });
});

describe("POST /api/assistant", () => {
  it("parses a command into a validated plan envelope", async () => {
    const { status, envelope } = await postJson(BODY);

    assert.equal(status, 200);
    assert.equal(envelope.ok, true);

    if (!envelope.ok) return;

    const data = envelope.data;
    const plan = data.plan as { type: string; event: { title: string } };

    assert.equal(data.provider, "heuristic");
    assert.equal(typeof data.understood, "string");
    assert.equal(plan.type, "calendar.create");
    assert.equal(plan.event.title, "Treffen mit Max");
  });

  it("rejects invalid bodies with 400 (never 500s on garbage)", async () => {
    for (const bad of [{}, { text: "" }, null, "nope"]) {
      const { status, envelope } = await postJson(bad);

      assert.equal(status, 400);
      assert.equal(envelope.ok, false);
    }
  });

  it("rejects malformed JSON safely", async () => {
    const response = await callPost(
      new Request("http://localhost/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{oops",
      }),
      NO_PARAMS,
    );

    assert.equal(response.status, 400);
  });
});
