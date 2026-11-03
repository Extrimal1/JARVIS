/**
 * Assistant streaming tests: Ollama NDJSON parsing, the streaming LLM
 * service, and the SSE client transport. Everything is mocked — no
 * Ollama server required.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chatStreamWithOllama,
  isProviderError,
  parseOllamaStreamLine,
} from "@/src/lib/assistant/llm";
import { createApiChatStream } from "@/src/lib/assistant/agent";

const SAVED_ENV = {
  model: process.env.OLLAMA_MODEL,
  baseUrl: process.env.OLLAMA_BASE_URL,
};

const REAL_FETCH = globalThis.fetch;

afterEach(() => {
  if (SAVED_ENV.model === undefined) delete process.env.OLLAMA_MODEL;
  else process.env.OLLAMA_MODEL = SAVED_ENV.model;

  if (SAVED_ENV.baseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = SAVED_ENV.baseUrl;

  globalThis.fetch = REAL_FETCH;
});

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = lines.map((line) => `${line}\n`).join("");

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = events.map((event) => `data: ${event}\n\n`).join("");

  return new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-payload so the client proves it reassembles chunks.
      const middle = Math.floor(payload.length / 2);

      controller.enqueue(encoder.encode(payload.slice(0, middle)));
      controller.enqueue(encoder.encode(payload.slice(middle)));
      controller.close();
    },
  });
}

describe("parseOllamaStreamLine", () => {
  it("parses content deltas", () => {
    const chunk = parseOllamaStreamLine(
      '{"model":"qwen3.5:4b","message":{"role":"assistant","content":"Hallo"},"done":false}',
    );

    assert.notEqual(chunk, null);
    assert.equal(chunk?.content, "Hallo");
    assert.equal(chunk?.done, false);
    assert.equal(chunk?.doneReason, null);
  });

  it("parses the final done chunk with stats", () => {
    const chunk = parseOllamaStreamLine(
      '{"model":"qwen3.5:4b","message":{"role":"assistant","content":"!"},"done":true,"done_reason":"stop","eval_count":12}',
    );

    assert.notEqual(chunk, null);
    assert.equal(chunk?.content, "!");
    assert.equal(chunk?.done, true);
    assert.equal(chunk?.doneReason, "stop");
    assert.equal(chunk?.evalCount, 12);
    assert.equal(chunk?.model, "qwen3.5:4b");
  });

  it("ignores blanks and malformed lines", () => {
    assert.equal(parseOllamaStreamLine(""), null);
    assert.equal(parseOllamaStreamLine("   "), null);
    assert.equal(parseOllamaStreamLine("not json"), null);
    assert.equal(parseOllamaStreamLine("[1,2]"), null);
  });
});

describe("chatStreamWithOllama", () => {
  it("sends stream:true and forwards tokens in order", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";

    let seenBody: Record<string, unknown> = {};
    const tokens: string[] = [];

    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seenBody = JSON.parse(init?.body as string) as Record<string, unknown>;

      return {
        ok: true,
        status: 200,
        body: ndjsonStream([
          '{"message":{"content":"{\\"final\\": \\"Hi"},"done":false}',
          '{"message":{"content":"\\"}"},"done":true,"done_reason":"stop","eval_count":5}',
        ]),
      };
    }) as unknown as typeof fetch;

    const result = await chatStreamWithOllama(
      [{ role: "user", content: "Hallo" }],
      { onToken: (delta) => tokens.push(delta) },
    );

    assert.equal(seenBody.stream, true);
    assert.deepEqual(tokens, ['{"final": "Hi', '"}']);
    assert.equal(result.content, '{"final": "Hi"}');
    assert.equal(result.doneReason, "stop");
    assert.equal(result.evalCount, 5);
  });

  it("maps 404 to model-not-found", async () => {
    process.env.OLLAMA_MODEL = "missing:99b";

    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
      body: null,
    })) as unknown as typeof fetch;

    await assert.rejects(
      chatStreamWithOllama([{ role: "user", content: "Hi" }], {
        onToken: () => {},
      }),
      (error: unknown) =>
        isProviderError(error) && error.code === "model-not-found",
    );
  });

  it("rejects an empty stream as malformed", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";

    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: ndjsonStream([]),
    })) as unknown as typeof fetch;

    await assert.rejects(
      chatStreamWithOllama([{ role: "user", content: "Hi" }], {
        onToken: () => {},
      }),
      (error: unknown) =>
        isProviderError(error) && error.code === "malformed",
    );
  });

  it("surfaces cancellation as cancelled", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      chatStreamWithOllama([{ role: "user", content: "Hi" }], {
        onToken: () => {},
        signal: controller.signal,
      }),
      (error: unknown) =>
        isProviderError(error) && error.code === "cancelled",
    );
  });
});

describe("createApiChatStream", () => {
  it("collects SSE tokens into the full envelope", async () => {
    const seen: string[] = [];
    const fetcher = (async () => ({
      ok: true,
      status: 200,
      body: sseStream([
        '{"token":"{\\"final\\": \\"Hallo" }',
        '{"token":"\\"}"}',
        '{"done":true,"model":"qwen3.5:4b","doneReason":"stop","evalCount":3}',
      ]),
    })) as unknown as typeof fetch;

    const chat = createApiChatStream(fetcher, undefined, (delta) =>
      seen.push(delta),
    );
    const content = await chat([{ role: "user", content: "Hi" }]);

    assert.equal(content, '{"final": "Hallo"}');
    assert.deepEqual(seen, ['{"final": "Hallo', '"}']);
  });

  it("throws the server error event message", async () => {
    const fetcher = (async () => ({
      ok: true,
      status: 200,
      body: sseStream(['{"error":"Modell ist müde."}']),
    })) as unknown as typeof fetch;

    await assert.rejects(createApiChatStream(fetcher)([
      { role: "user", content: "Hi" },
    ]), /Modell ist müde/);
  });

  it("maps 401 to the session message", async () => {
    const fetcher = (async () => ({
      ok: false,
      status: 401,
      body: null,
    })) as unknown as typeof fetch;

    await assert.rejects(createApiChatStream(fetcher)([
      { role: "user", content: "Hi" },
    ]), /Sitzung abgelaufen/);
  });

  it("aborts immediately when already cancelled", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      createApiChatStream(fetcher, controller.signal)([
        { role: "user", content: "Hi" },
      ]),
      /Abgebrochen/,
    );
    assert.equal(called, false);
  });
});
