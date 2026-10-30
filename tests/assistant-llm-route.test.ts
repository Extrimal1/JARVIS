/**
 * LLM route tests: the real `/api/llm` handlers run with a minimal
 * `next/server` stand-in (local mode: no login required). Ollama is
 * mocked — no server required.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GET } from "@/app/api/llm/route";
import { POST } from "@/app/api/llm/chat/route";

const SAVED_ENV = {
  provider: process.env.ASSISTANT_PROVIDER,
  baseUrl: process.env.OLLAMA_BASE_URL,
  model: process.env.OLLAMA_MODEL,
};

const REAL_FETCH = globalThis.fetch;

let calls: { url: unknown }[] = [];

afterEach(() => {
  if (SAVED_ENV.provider === undefined) delete process.env.ASSISTANT_PROVIDER;
  else process.env.ASSISTANT_PROVIDER = SAVED_ENV.provider;

  if (SAVED_ENV.baseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = SAVED_ENV.baseUrl;

  if (SAVED_ENV.model === undefined) delete process.env.OLLAMA_MODEL;
  else process.env.OLLAMA_MODEL = SAVED_ENV.model;

  globalThis.fetch = REAL_FETCH;
  calls = [];
});

function mockFetchJson(payload: unknown, status = 200): void {
  globalThis.fetch = (async (url: unknown) => {
    calls.push({ url });

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  }) as unknown as typeof fetch;
}

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
    new Request("http://localhost/api/llm/chat", {
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

describe("GET /api/llm", () => {
  it("reports provider, configured, and availability without secrets", async () => {
    process.env.ASSISTANT_PROVIDER = "ollama";
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({ models: [{ name: "qwen3.5:4b" }] });

    const response = await callGet(NO_PARAMS);
    const envelope = (await response.json()) as Envelope;

    assert.equal(response.status, 200);
    assert.equal(envelope.ok, true);

    if (!envelope.ok) return;

    assert.equal(envelope.data.provider, "ollama");
    assert.equal(envelope.data.configured, true);
    assert.equal(envelope.data.available, true);
    assert.equal(typeof envelope.data.contextChars, "number");
    assert.equal("model" in envelope.data, false);
    assert.equal("baseUrl" in envelope.data, false);
  });

  it("reports unavailable models honestly instead of 500ing", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({ models: [{ name: "other:1b" }] });

    const response = await callGet(NO_PARAMS);
    const envelope = (await response.json()) as Envelope;

    assert.equal(response.status, 200);
    assert.equal(envelope.ok, true);

    if (!envelope.ok) return;

    assert.equal(envelope.data.available, false);
  });
});

describe("POST /api/llm/chat", () => {
  it("runs inference and returns content plus model", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({
      model: "qwen3.5:4b",
      message: { content: '{"final": "Hallo!"}' },
      done: true,
    });

    const { status, envelope } = await postJson({
      messages: [{ role: "user", content: "Hallo" }],
      options: { format: "json" },
    });

    assert.equal(status, 200);
    assert.equal(envelope.ok, true);

    if (!envelope.ok) return;

    assert.equal(envelope.data.content, '{"final": "Hallo!"}');
    assert.equal(envelope.data.model, "qwen3.5:4b");
  });

  it("rejects invalid bodies with 400 (never 500s on garbage)", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({});

    for (const bad of [
      {},
      { messages: [] },
      { messages: [{ role: "root", content: "x" }] },
      { messages: [{ role: "user", content: "x" }], options: { model: "e" } },
      null,
      "nope",
    ]) {
      const { status, envelope } = await postJson(bad);

      assert.equal(status, 400);
      assert.equal(envelope.ok, false);
    }

    assert.equal(calls.length, 0);
  });

  it("rejects malformed JSON safely", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({});

    const response = await callPost(
      new Request("http://localhost/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{oops",
      }),
      NO_PARAMS,
    );

    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
  });

  it("maps a missing model to 503, not 500", async () => {
    delete process.env.OLLAMA_MODEL;
    mockFetchJson({});

    const { status, envelope } = await postJson({
      messages: [{ role: "user", content: "Hallo" }],
    });

    assert.equal(status, 503);
    assert.equal(envelope.ok, false);

    if (envelope.ok) return;

    assert.match(envelope.error.message, /OLLAMA_MODEL/);
    assert.equal(calls.length, 0);
  });

  it("maps Ollama 404s to 502 with the model name", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({ error: "not found" }, 404);

    const { status, envelope } = await postJson({
      messages: [{ role: "user", content: "Hallo" }],
    });

    assert.equal(status, 502);
    assert.equal(envelope.ok, false);

    if (envelope.ok) return;

    assert.match(envelope.error.message, /qwen3\.5:4b/);
  });
});
