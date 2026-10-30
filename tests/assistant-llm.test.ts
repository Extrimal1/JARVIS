/**
 * Central LLM service tests: wire format, retries, availability probe,
 * and route-body validation. Ollama is mocked — no server required.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chatWithOllama,
  checkOllamaModel,
  isLlmChatRouteRequest,
  isProviderError,
  normalizeBaseUrl,
  type LlmMessage,
} from "@/src/lib/assistant/llm";

const SAVED_ENV = {
  model: process.env.OLLAMA_MODEL,
  baseUrl: process.env.OLLAMA_BASE_URL,
  numPredict: process.env.OLLAMA_NUM_PREDICT,
  numCtx: process.env.OLLAMA_NUM_CTX,
  timeout: process.env.OLLAMA_CHAT_TIMEOUT_MS,
};

const REAL_FETCH = globalThis.fetch;

type CapturedCall = { url: unknown; init: RequestInit | undefined };

let calls: CapturedCall[] = [];

afterEach(() => {
  for (const [key, value] of [
    ["OLLAMA_MODEL", SAVED_ENV.model],
    ["OLLAMA_BASE_URL", SAVED_ENV.baseUrl],
    ["OLLAMA_NUM_PREDICT", SAVED_ENV.numPredict],
    ["OLLAMA_NUM_CTX", SAVED_ENV.numCtx],
    ["OLLAMA_CHAT_TIMEOUT_MS", SAVED_ENV.timeout],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  globalThis.fetch = REAL_FETCH;
  calls = [];
});

type MockBehavior =
  | { kind: "json"; payload: unknown; status: number }
  | { kind: "throw"; error: unknown }
  | { kind: "jsonThrow" };

function mockFetchSequence(behaviors: MockBehavior[]): void {
  let index = 0;

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    const behavior = behaviors[Math.min(index, behaviors.length - 1)];

    index += 1;

    if (behavior.kind === "throw") throw behavior.error;

    if (behavior.kind === "jsonThrow") {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      };
    }

    return {
      ok: behavior.status >= 200 && behavior.status < 300,
      status: behavior.status,
      json: async () => behavior.payload,
    };
  }) as unknown as typeof fetch;
}

function mockFetchJson(payload: unknown, status = 200): void {
  mockFetchSequence([{ kind: "json", payload, status }]);
}

function lastBody(): Record<string, unknown> {
  const last = calls[calls.length - 1];

  assert.notEqual(last, undefined);
  assert.equal(typeof last?.init?.body, "string");

  return JSON.parse(last?.init?.body as string) as Record<string, unknown>;
}

const USER_MESSAGE: LlmMessage[] = [{ role: "user", content: "Hallo" }];

const CHAT_OK = {
  model: "qwen3.5:4b",
  message: { role: "assistant", content: '{"final": "Hallo!"}' },
  done: true,
};

describe("normalizeBaseUrl", () => {
  it("trims, defaults blanks, and tolerates /api suffixes", () => {
    assert.equal(
      normalizeBaseUrl("  http://localhost:11434///  "),
      "http://localhost:11434",
    );
    assert.equal(normalizeBaseUrl("   "), "http://127.0.0.1:11434");
    assert.equal(normalizeBaseUrl(undefined), "http://127.0.0.1:11434");
    assert.equal(
      normalizeBaseUrl("http://localhost:11434/api/chat"),
      "http://localhost:11434",
    );
  });
});

describe("chatWithOllama", () => {
  it("sends an Ollama-compatible body and returns content", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    mockFetchJson(CHAT_OK);

    const result = await chatWithOllama(USER_MESSAGE, {
      format: "json",
      think: false,
      temperature: 0,
      numPredict: 800,
    });

    assert.equal(result.content, '{"final": "Hallo!"}');
    assert.equal(result.model, "qwen3.5:4b");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "http://127.0.0.1:11434/api/chat");
    assert.equal(calls[0]?.init?.method, "POST");

    const body = lastBody();

    assert.equal(body.model, "qwen3.5:4b");
    assert.equal(body.stream, false);
    assert.equal(body.format, "json");
    assert.equal(body.think, false);
    assert.deepEqual(body.options, { temperature: 0, num_predict: 800 });
    assert.deepEqual(body.messages, [{ role: "user", content: "Hallo" }]);
  });

  it("omits format for free text and honors context env knobs", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    process.env.OLLAMA_NUM_PREDICT = "512";
    process.env.OLLAMA_NUM_CTX = "8192";
    mockFetchJson(CHAT_OK);

    await chatWithOllama(USER_MESSAGE);

    const body = lastBody();

    assert.equal("format" in body, false);
    assert.deepEqual(body.options, {
      temperature: 0,
      num_predict: 512,
      num_ctx: 8192,
    });
  });

  it("ignores invalid numeric env knobs", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    process.env.OLLAMA_NUM_PREDICT = "viel";
    process.env.OLLAMA_NUM_CTX = "-4";
    mockFetchJson(CHAT_OK);

    await chatWithOllama(USER_MESSAGE);

    assert.deepEqual(lastBody().options, {
      temperature: 0,
      num_predict: 800,
    });
  });

  it("fails as not-configured without a model", async () => {
    delete process.env.OLLAMA_MODEL;
    mockFetchJson(CHAT_OK);

    await assert.rejects(
      chatWithOllama(USER_MESSAGE),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "not-configured");
        assert.match(error.message, /OLLAMA_MODEL/);

        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it("rejects empty message lists without calling Ollama", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson(CHAT_OK);

    await assert.rejects(chatWithOllama([]), /messages must not be empty/);
    assert.equal(calls.length, 0);
  });

  it("retries a transient 500 once, then succeeds", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchSequence([
      { kind: "json", payload: { error: "boom" }, status: 500 },
      { kind: "json", payload: CHAT_OK, status: 200 },
    ]);

    const result = await chatWithOllama(USER_MESSAGE);

    assert.equal(result.content, '{"final": "Hallo!"}');
    assert.equal(calls.length, 2);
  });

  it("maps a tired 500 to upstream with status and model", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({ error: "boom" }, 500);

    await assert.rejects(
      chatWithOllama(USER_MESSAGE, { retries: 0 }),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "upstream");
        assert.match(error.message, /500/);
        assert.match(error.message, /qwen3\.5:4b/);

        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  it("never retries a 404 and names the model with a pull hint", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({ error: "not found" }, 404);

    await assert.rejects(
      chatWithOllama(USER_MESSAGE),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "model-not-found");
        assert.match(error.message, /qwen3\.5:4b/);
        assert.match(error.message, /ollama pull/);

        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  it("never retries a 400", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({ error: "bad" }, 400);

    await assert.rejects(
      chatWithOllama(USER_MESSAGE),
      (error: unknown) =>
        isProviderError(error) && error.code === "upstream",
    );
    assert.equal(calls.length, 1);
  });

  it("retries network failures, then reports unreachable", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchSequence([
      { kind: "throw", error: new TypeError("fetch failed") },
      { kind: "throw", error: new TypeError("fetch failed") },
    ]);

    await assert.rejects(
      chatWithOllama(USER_MESSAGE),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "unreachable");
        assert.match(error.message, /nicht erreichbar/);

        return true;
      },
    );
    assert.equal(calls.length, 2);
  });

  it("maps timeouts to unreachable with a retry hint", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchSequence([
      { kind: "throw", error: new DOMException("timed out", "TimeoutError") },
      { kind: "throw", error: new DOMException("timed out", "TimeoutError") },
    ]);

    await assert.rejects(
      chatWithOllama(USER_MESSAGE),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "unreachable");
        assert.match(error.message, /zu lange/);

        return true;
      },
    );
  });

  it("maps unparseable envelopes to malformed without retry", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchSequence([{ kind: "jsonThrow" }]);

    await assert.rejects(
      chatWithOllama(USER_MESSAGE),
      (error: unknown) =>
        isProviderError(error) && error.code === "malformed",
    );
    assert.equal(calls.length, 1);
  });

  it("honors a pre-aborted signal as cancelled", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson(CHAT_OK);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      chatWithOllama(USER_MESSAGE, { signal: controller.signal }),
      (error: unknown) =>
        isProviderError(error) && error.code === "cancelled",
    );
    assert.equal(calls.length, 0);
  });
});

describe("checkOllamaModel", () => {
  const TAGS = {
    models: [{ name: "qwen3.5:4b" }, { name: "llama3.1:latest" }],
  };

  it("reports installed models as available", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson(TAGS);

    assert.deepEqual(await checkOllamaModel(), {
      model: "qwen3.5:4b",
      available: true,
    });
    assert.equal(calls[0]?.url, "http://127.0.0.1:11434/api/tags");
  });

  it("accepts the implicit :latest tag", async () => {
    process.env.OLLAMA_MODEL = "llama3.1";
    mockFetchJson(TAGS);

    assert.deepEqual(await checkOllamaModel(), {
      model: "llama3.1",
      available: true,
    });
  });

  it("reports missing models as unavailable without throwing", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({ models: [{ name: "other:1b" }] });

    assert.deepEqual(await checkOllamaModel(), {
      model: "qwen3.5:4b",
      available: false,
    });
  });

  it("never throws on network failures or bad shapes", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";

    mockFetchSequence([
      { kind: "throw", error: new TypeError("fetch failed") },
    ]);
    assert.deepEqual(await checkOllamaModel(), {
      model: "qwen3.5:4b",
      available: false,
    });

    mockFetchJson({ nope: true });
    assert.deepEqual(await checkOllamaModel(), {
      model: "qwen3.5:4b",
      available: false,
    });

    mockFetchJson(TAGS, 500);
    assert.deepEqual(await checkOllamaModel(), {
      model: "qwen3.5:4b",
      available: false,
    });
  });

  it("reports a null model when unconfigured", async () => {
    delete process.env.OLLAMA_MODEL;
    mockFetchJson(TAGS);

    assert.deepEqual(await checkOllamaModel(), {
      model: null,
      available: false,
    });
    assert.equal(calls.length, 0);
  });
});

describe("isLlmChatRouteRequest", () => {
  const valid = {
    messages: [{ role: "user", content: "Hallo" }],
    options: { format: "json", think: false, temperature: 0 },
  };

  it("accepts minimal and full valid bodies", () => {
    assert.equal(isLlmChatRouteRequest(valid), true);
    assert.equal(
      isLlmChatRouteRequest({ messages: [{ role: "user", content: "Hi" }] }),
      true,
    );
    assert.equal(
      isLlmChatRouteRequest({
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "u" },
          { role: "assistant", content: "a" },
          { role: "tool", content: "t" },
        ],
        options: {
          numPredict: 100,
          numCtx: 4096,
          timeoutMs: 5000,
          retries: 0,
        },
      }),
      true,
    );
  });

  it("rejects malformed messages", () => {
    assert.equal(isLlmChatRouteRequest({}), false);
    assert.equal(isLlmChatRouteRequest({ messages: [] }), false);
    assert.equal(
      isLlmChatRouteRequest({
        messages: Array.from({ length: 33 }, () => ({
          role: "user",
          content: "x",
        })),
      }),
      false,
    );
    assert.equal(
      isLlmChatRouteRequest({ messages: [{ role: "root", content: "x" }] }),
      false,
    );
    assert.equal(
      isLlmChatRouteRequest({ messages: [{ role: "user", content: "  " }] }),
      false,
    );
    assert.equal(
      isLlmChatRouteRequest({
        messages: [{ role: "user", content: "x".repeat(8001) }],
      }),
      false,
    );
  });

  it("rejects bad options and client-owned model selection", () => {
    assert.equal(
      isLlmChatRouteRequest({
        messages: [{ role: "user", content: "x" }],
        options: { model: "evil:1b" },
      }),
      false,
    );
    assert.equal(
      isLlmChatRouteRequest({
        messages: [{ role: "user", content: "x" }],
        options: { baseUrl: "http://evil/" },
      }),
      false,
    );
    assert.equal(
      isLlmChatRouteRequest({
        messages: [{ role: "user", content: "x" }],
        options: { temperature: 5 },
      }),
      false,
    );
    assert.equal(
      isLlmChatRouteRequest({
        messages: [{ role: "user", content: "x" }],
        options: { retries: 9 },
      }),
      false,
    );
    assert.equal(
      isLlmChatRouteRequest({
        messages: [{ role: "user", content: "x" }],
        options: "json",
      }),
      false,
    );
  });
});
