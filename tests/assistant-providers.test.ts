/**
 * Provider tests: heuristic default plus Ollama failure mapping.
 * Ollama tests mock `globalThis.fetch` — no server required.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  heuristicProvider,
  isProviderError,
  ollamaProvider,
  providerStatus,
  selectProvider,
  type ProviderId,
} from "@/src/lib/assistant/providers";
import type { NluContext } from "@/src/lib/assistant/actions";

const CTX: NluContext = {
  todayISO: "2026-10-27",
  nowTime: "10:00",
  timezone: "Europe/Berlin",
  locale: "de",
};

const SAVED_ENV = {
  provider: process.env.ASSISTANT_PROVIDER,
  baseUrl: process.env.OLLAMA_BASE_URL,
  model: process.env.OLLAMA_MODEL,
};

const REAL_FETCH = globalThis.fetch;

type CapturedCall = { url: unknown; init: RequestInit | undefined };

let lastCall: CapturedCall | null = null;

afterEach(() => {
  if (SAVED_ENV.provider === undefined) delete process.env.ASSISTANT_PROVIDER;
  else process.env.ASSISTANT_PROVIDER = SAVED_ENV.provider;

  if (SAVED_ENV.baseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = SAVED_ENV.baseUrl;

  if (SAVED_ENV.model === undefined) delete process.env.OLLAMA_MODEL;
  else process.env.OLLAMA_MODEL = SAVED_ENV.model;

  globalThis.fetch = REAL_FETCH;
  lastCall = null;
});

function mockFetchJson(payload: unknown, status = 200): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    lastCall = { url, init };

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  }) as unknown as typeof fetch;
}

function mockFetchReject(error: unknown): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    lastCall = { url, init };

    throw error;
  }) as unknown as typeof fetch;
}

function mockFetchJsonThrow(): void {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    lastCall = { url, init };

    return {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token in JSON");
      },
    };
  }) as unknown as typeof fetch;
}

function lastRequestBody(): Record<string, unknown> {
  assert.notEqual(lastCall, null);
  assert.notEqual(lastCall?.init?.body, undefined);
  assert.equal(typeof lastCall?.init?.body, "string");

  return JSON.parse(lastCall?.init?.body as string) as Record<string, unknown>;
}

const UNSUPPORTED_JSON = JSON.stringify({
  type: "unsupported",
  message: "Hilfe",
});

describe("provider selection", () => {
  it("defaults to the Ollama engine", () => {
    delete process.env.ASSISTANT_PROVIDER;
    delete process.env.OLLAMA_MODEL;

    assert.equal(selectProvider().id, "ollama");
    assert.deepEqual(providerStatus(), {
      provider: "ollama",
      configured: false,
    });
  });

  it("selects Ollama explicitly and reports missing models", () => {
    process.env.ASSISTANT_PROVIDER = "ollama";
    delete process.env.OLLAMA_MODEL;

    const selected: ProviderId = selectProvider().id;

    assert.equal(selected, "ollama");
    assert.deepEqual(providerStatus(), {
      provider: "ollama",
      configured: false,
    });
  });

  it("uses the heuristic parser only on explicit opt-in", () => {
    process.env.ASSISTANT_PROVIDER = "heuristic";
    delete process.env.OLLAMA_MODEL;

    assert.equal(selectProvider().id, "heuristic");
    assert.deepEqual(providerStatus(), {
      provider: "heuristic",
      configured: true,
    });
  });

  it("falls back to Ollama on unknown values", () => {
    process.env.ASSISTANT_PROVIDER = "mystery-box";

    assert.equal(selectProvider().id, "ollama");
  });
});

describe("heuristic provider", () => {
  it("parses the spec example into a validated plan", async () => {
    const result = await heuristicProvider.parse(
      "Plane morgen um 15:30 Uhr ein einstündiges Treffen mit Max.",
      CTX,
    );

    assert.equal(heuristicProvider.id, "heuristic");
    assert.equal(result.plan.type, "calendar.create");
    assert.equal(result.locale, "de");
  });
});

describe("ollama provider", () => {
  it("fails in German when no model is configured", async () => {
    delete process.env.OLLAMA_MODEL;

    await assert.rejects(
      ollamaProvider.parse("Plane morgen ein Treffen", CTX),
      (error: unknown) => {
        assert.equal(isProviderError(error), true);

        if (!isProviderError(error)) return false;

        assert.equal(error.code, "not-configured");
        assert.match(error.message, /OLLAMA_MODEL/);

        return true;
      },
    );
  });

  it("fails in German when the server is unreachable", async () => {
    process.env.OLLAMA_MODEL = "test-model";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:9";

    await assert.rejects(
      ollamaProvider.parse("Plane morgen ein Treffen", CTX),
      (error: unknown) => {
        assert.equal(isProviderError(error), true);

        if (!isProviderError(error)) return false;

        assert.equal(error.code, "unreachable");
        assert.match(error.message, /nicht erreichbar/);

        return true;
      },
    );
  });

  it("fails in German on malformed model output", async () => {
    process.env.OLLAMA_MODEL = "test-model";
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    mockFetchJson({ message: { content: "kein json {{{" } });

    await assert.rejects(
      ollamaProvider.parse("Plane morgen ein Treffen", CTX),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "malformed");

        return true;
      },
    );
  });

  it("rejects structurally invalid plans (never executes them)", async () => {
    process.env.OLLAMA_MODEL = "test-model";
    mockFetchJson({ message: { content: '{"type":"calendar.teleport"}' } });

    await assert.rejects(
      ollamaProvider.parse("Plane morgen ein Treffen", CTX),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "invalid-plan");
        assert.match(error.message, /nichts ausgeführt/);

        return true;
      },
    );
  });

  it("accepts valid model plans", async () => {
    process.env.OLLAMA_MODEL = "test-model";
    mockFetchJson({
      message: {
        content: JSON.stringify({
          type: "calendar.list",
          from: "2026-10-28",
          to: "2026-10-28",
          label: "morgen",
        }),
      },
    });

    const result = await ollamaProvider.parse("Was habe ich morgen?", CTX);

    assert.equal(result.plan.type, "calendar.list");
  });

  it("sends the exact configured model to POST {base}/api/chat", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    mockFetchJson({
      message: {
        content: JSON.stringify({
          type: "calendar.list",
          from: "2026-10-28",
          to: "2026-10-28",
          label: "morgen",
        }),
      },
    });

    const result = await ollamaProvider.parse("Was habe ich morgen?", CTX);

    assert.equal(result.plan.type, "calendar.list");
    assert.equal(result.locale, "de");
    assert.equal(lastCall?.url, "http://localhost:11434/api/chat");
    assert.equal(lastCall?.init?.method, "POST");

    const body = lastRequestBody();

    assert.equal(body.model, "qwen3.5:4b");
    assert.equal(body.stream, false);
    assert.equal(body.format, "json");
    assert.equal(body.think, false);
    assert.ok(Array.isArray(body.messages));

    const messages = body.messages as Array<{ role: string; content: string }>;

    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "system");
    assert.equal(messages[1]?.role, "user");
    assert.equal(messages[1]?.content, "Was habe ich morgen?");
  });

  it("normalizes base URLs with whitespace and trailing slashes", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    process.env.OLLAMA_BASE_URL = "  http://localhost:11434///  ";
    mockFetchJson({ message: { content: UNSUPPORTED_JSON } });

    await ollamaProvider.parse("Hallo", CTX);

    assert.equal(lastCall?.url, "http://localhost:11434/api/chat");
  });

  it("falls back to the loopback default when the base URL is blank", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    process.env.OLLAMA_BASE_URL = "   ";
    mockFetchJson({ message: { content: UNSUPPORTED_JSON } });

    await ollamaProvider.parse("Hallo", CTX);

    assert.equal(lastCall?.url, "http://127.0.0.1:11434/api/chat");
  });

  it("tolerates a pasted /api/chat suffix in the base URL", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434/api/chat";
    mockFetchJson({ message: { content: UNSUPPORTED_JSON } });

    await ollamaProvider.parse("Hallo", CTX);

    assert.equal(lastCall?.url, "http://localhost:11434/api/chat");
  });

  it("maps HTTP 404 to model-not-found naming the model", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    process.env.OLLAMA_BASE_URL = "http://localhost:11434";
    mockFetchJson({ error: "model 'qwen3.5:4b' not found" }, 404);

    await assert.rejects(
      ollamaProvider.parse("Plane morgen ein Treffen", CTX),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "model-not-found");
        assert.match(error.message, /qwen3\.5:4b/);
        assert.match(error.message, /ollama pull/);

        return true;
      },
    );
  });

  it("maps other HTTP errors to upstream with status and model", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchJson({ error: "boom" }, 500);

    await assert.rejects(
      ollamaProvider.parse("Plane morgen ein Treffen", CTX),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "upstream");
        assert.match(error.message, /500/);
        assert.match(error.message, /qwen3\.5:4b/);

        return true;
      },
    );
  });

  it("maps a rejected fetch to unreachable (mocked, no network)", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchReject(new Error("connect ECONNREFUSED 127.0.0.1:11434"));

    await assert.rejects(
      ollamaProvider.parse("Plane morgen ein Treffen", CTX),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "unreachable");
        assert.match(error.message, /nicht erreichbar/);

        return true;
      },
    );
  });

  it("maps timeouts to unreachable with a retry hint", async () => {
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    mockFetchReject(new DOMException("signal timed out", "TimeoutError"));

    await assert.rejects(
      ollamaProvider.parse("Plane morgen ein Treffen", CTX),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "unreachable");
        assert.match(error.message, /zu lange/);

        return true;
      },
    );
  });

  it("maps a missing message body to malformed", async () => {
    process.env.OLLAMA_MODEL = "test-model";
    mockFetchJson({ done: true });

    await assert.rejects(
      ollamaProvider.parse("Plane morgen ein Treffen", CTX),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "malformed");

        return true;
      },
    );
  });

  it("maps an unparseable envelope to malformed", async () => {
    process.env.OLLAMA_MODEL = "test-model";
    mockFetchJsonThrow();

    await assert.rejects(
      ollamaProvider.parse("Plane morgen ein Treffen", CTX),
      (error: unknown) => {
        if (!isProviderError(error)) return false;

        assert.equal(error.code, "malformed");

        return true;
      },
    );
  });

  it("accepts plans wrapped in markdown fences", async () => {
    process.env.OLLAMA_MODEL = "test-model";
    mockFetchJson({
      message: {
        content: `\`\`\`json\n${JSON.stringify({ type: "finance.list", limit: 5 })}\n\`\`\``,
      },
    });

    const result = await ollamaProvider.parse("Zeig Buchungen", CTX);

    assert.equal(result.plan.type, "finance.list");
  });
});
