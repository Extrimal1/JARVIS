/**
 * Central Ollama LLM service — the single integration point for all
 * model inference in J.A.R.V.I.S.
 *
 * - `chatWithOllama`: general chat completions over POST /api/chat
 *   (non-streaming; streaming arrives with the conversation engine).
 * - `checkOllamaModel`: lightweight availability probe (GET /api/tags).
 * - Shared env resolution, per-request timeouts, one transient retry,
 *   and the shared error taxonomy (`ProviderError`).
 *
 * Every NLU adapter and every future module reuses this service — no
 * separate Ollama integrations. Failures surface as `ProviderError`
 * with actionable German messages (model name included, never URLs
 * or keys).
 *
 * SERVER-ONLY: reads server env (base URL, model name, limits).
 */

export type ProviderCode =
  | "not-configured"
  | "unreachable"
  | "model-not-found"
  | "upstream"
  | "malformed"
  | "invalid-plan"
  | "cancelled";

export class ProviderError extends Error {
  code: ProviderCode;

  constructor(code: ProviderCode, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

// ------------------------------------------------------------------- env

export const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";

export const OLLAMA_DEFAULT_TIMEOUT_MS = 45_000;

const OLLAMA_DEFAULT_NUM_PREDICT = 800;

const MODEL_CHECK_TIMEOUT_MS = 5_000;

const RETRY_DELAY_MS = 400;

/**
 * Normalize the Ollama base URL: trim whitespace, fall back to the
 * loopback default when blank (never emit a relative "/api/chat" URL),
 * strip trailing slashes, and tolerate a pasted "/api" or "/api/chat"
 * suffix so the request URL is always "{base}/api/chat".
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();

  if (trimmed === "") return OLLAMA_DEFAULT_BASE_URL;

  return trimmed
    .replace(/\/+$/, "")
    .replace(/\/(api\/chat|api)$/, "")
    .replace(/\/+$/, "");
}

export function ollamaEnv(): { baseUrl: string; model: string } | null {
  const model = (process.env.OLLAMA_MODEL ?? "").trim();

  if (model === "") return null;

  return { baseUrl: normalizeBaseUrl(process.env.OLLAMA_BASE_URL), model };
}

/** Positive-int env knob; null when unset or invalid (caller default wins). */
function envInt(name: string): number | null {
  const raw = process.env[name];

  if (raw === undefined) return null;

  const value = Number.parseInt(raw.trim(), 10);

  return Number.isInteger(value) && value > 0 ? value : null;
}

const OLLAMA_DEFAULT_NUM_CTX = 4096;

/** Tokens reserved for system prompt, tools, and the fresh answer. */
const CONTEXT_HEADROOM_TOKENS = 2048;

/**
 * History budget in characters, derived from the configured Ollama
 * context window (`OLLAMA_NUM_CTX`, Ollama default 4096). Heuristic:
 * ~3 chars per token after headroom, minimum 4000 chars. The
 * conversation service truncates older turns to fit.
 */
export function contextBudgetChars(): number {
  const numCtx = envInt("OLLAMA_NUM_CTX") ?? OLLAMA_DEFAULT_NUM_CTX;

  return Math.max(4000, (numCtx - CONTEXT_HEADROOM_TOKENS) * 3);
}

// ------------------------------------------------------------------ chat

export type LlmRole = "system" | "user" | "assistant" | "tool";

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

export type LlmChatOptions = {
  /** Default: OLLAMA_MODEL (server env owns the model, never the client). */
  model?: string;
  /** Default: normalized OLLAMA_BASE_URL. */
  baseUrl?: string;
  /** "json" constrains Ollama to JSON output; omit for free text. */
  format?: "json";
  /** Default false: thinking models must answer, not ruminate. */
  think?: boolean;
  /** Default 0 (deterministic engine). */
  temperature?: number;
  /** Default OLLAMA_NUM_PREDICT or 800. */
  numPredict?: number;
  /** Default OLLAMA_NUM_CTX; unset = Ollama server default. */
  numCtx?: number;
  /** Default OLLAMA_CHAT_TIMEOUT_MS or 45 s. */
  timeoutMs?: number;
  /** Transient-failure retries. Default 1 (first call warms the model). */
  retries?: number;
  /** Extra cancellation (request abort); combined with the timeout. */
  signal?: AbortSignal;
};

export type LlmChatResult = {
  content: string;
  model: string;
};

export const LLM_NOT_CONFIGURED_MESSAGE =
  "Kein KI-Modell konfiguriert. Setze OLLAMA_MODEL auf dem Server oder nutze das lokale Regelwerk (ASSISTANT_PROVIDER=heuristic).";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new ProviderError("cancelled", "Abgebrochen.");
  }
}

/**
 * Combine the per-request timeout with an optional external signal
 * without relying on `AbortSignal.any` (keeps older Node runtimes
 * working). Abort reasons pass through untouched so TimeoutError
 * (retryable) and AbortError (cancelled) stay distinguishable.
 */
function combinedSignal(
  timeoutMs: number,
  external: AbortSignal | undefined,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);

  if (external === undefined) return timeout;
  if (external.aborted) return external;

  const controller = new AbortController();

  timeout.addEventListener("abort", () => controller.abort(timeout.reason), {
    once: true,
  });
  external.addEventListener("abort", () => controller.abort(external.reason), {
    once: true,
  });

  return controller.signal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function unreachableError(model: string): ProviderError {
  return new ProviderError(
    "unreachable",
    `Das KI-Modell „${model}“ ist nicht erreichbar. Prüfe, ob Ollama läuft und OLLAMA_BASE_URL stimmt.`,
  );
}

function timeoutError(model: string, timeoutMs: number): ProviderError {
  return new ProviderError(
    "unreachable",
    `Das KI-Modell „${model}“ hat zu lange gebraucht (Zeitlimit ${Math.round(timeoutMs / 1000)} Sekunden). Versuche es erneut — beim ersten Aufruf lädt Ollama das Modell noch.`,
  );
}

export async function chatWithOllama(
  messages: LlmMessage[],
  options: LlmChatOptions = {},
): Promise<LlmChatResult> {
  if (messages.length === 0) {
    throw new Error("chatWithOllama: messages must not be empty.");
  }

  const env = ollamaEnv();
  const model = (options.model ?? env?.model ?? "").trim();

  if (model === "") {
    throw new ProviderError("not-configured", LLM_NOT_CONFIGURED_MESSAGE);
  }

  const baseUrl =
    options.baseUrl === undefined
      ? (env?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL)
      : normalizeBaseUrl(options.baseUrl);
  const timeoutMs =
    options.timeoutMs ?? envInt("OLLAMA_CHAT_TIMEOUT_MS") ?? OLLAMA_DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? 1;
  const numCtx = options.numCtx ?? envInt("OLLAMA_NUM_CTX");
  const body = JSON.stringify({
    model,
    stream: false,
    ...(options.format === undefined ? {} : { format: options.format }),
    think: options.think ?? false,
    options: {
      temperature: options.temperature ?? 0,
      num_predict:
        options.numPredict ??
        envInt("OLLAMA_NUM_PREDICT") ??
        OLLAMA_DEFAULT_NUM_PREDICT,
      ...(numCtx === null ? {} : { num_ctx: numCtx }),
    },
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  });

  for (let attempt = 0; ; attempt += 1) {
    const lastAttempt = attempt >= retries;

    throwIfAborted(options.signal);

    let res: Response;

    try {
      res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: combinedSignal(timeoutMs, options.signal),
      });
    } catch (error: unknown) {
      const name =
        error instanceof DOMException || error instanceof Error
          ? error.name
          : "";

      if (name === "AbortError") {
        throw new ProviderError("cancelled", "Abgebrochen.");
      }

      if (!lastAttempt) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (name === "TimeoutError") throw timeoutError(model, timeoutMs);

      throw unreachableError(model);
    }

    if (res.status === 404) {
      throw new ProviderError(
        "model-not-found",
        `Das KI-Modell „${model}“ wurde auf dem Ollama-Server nicht gefunden (404). Prüfe OLLAMA_MODEL auf dem Server oder lade es mit: ollama pull ${model}`,
      );
    }

    if (!res.ok) {
      const retryable = res.status >= 500 && res.status <= 599;

      if (retryable && !lastAttempt) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      throw new ProviderError(
        "upstream",
        `Das KI-Modell „${model}“ meldet einen Fehler (${res.status}). Prüfe den Ollama-Server und OLLAMA_MODEL.`,
      );
    }

    let content: string;

    try {
      const payload = (await res.json()) as {
        message?: { content?: unknown };
      };
      content =
        typeof payload.message?.content === "string"
          ? payload.message.content
          : "";
    } catch {
      throw new ProviderError(
        "malformed",
        "Das KI-Modell hat eine ungültige Antwort geliefert. Versuche es erneut oder formuliere kürzer.",
      );
    }

    return { content, model };
  }
}

// ---------------------------------------------------------- availability

export type OllamaModelStatus = {
  /** Configured model name, or null when OLLAMA_MODEL is missing. */
  model: string | null;
  /** False when unconfigured, unreachable, or the tag is not installed. */
  available: boolean;
};

/**
 * Check whether the configured model is installed and the server
 * answers. Never throws: every failure maps to `available: false`
 * so status endpoints stay honest instead of 500ing.
 */
export async function checkOllamaModel(options: {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
} = {}): Promise<OllamaModelStatus> {
  const env = ollamaEnv();
  const model = (options.model ?? env?.model ?? "").trim();

  if (model === "") return { model: null, available: false };

  const baseUrl =
    options.baseUrl === undefined
      ? (env?.baseUrl ?? OLLAMA_DEFAULT_BASE_URL)
      : normalizeBaseUrl(options.baseUrl);

  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? MODEL_CHECK_TIMEOUT_MS),
    });

    if (!res.ok) return { model, available: false };

    const payload = (await res.json()) as {
      models?: { name?: unknown }[];
    };

    if (!Array.isArray(payload.models)) return { model, available: false };

    const names = new Set(
      payload.models
        .map((entry) => entry.name)
        .filter((name): name is string => typeof name === "string"),
    );
    const available =
      names.has(model) ||
      (!model.includes(":") && names.has(`${model}:latest`));

    return { model, available };
  } catch {
    return { model, available: false };
  }
}

// ------------------------------------------------------- route contract

export type LlmChatRouteOptions = {
  format?: "json";
  think?: boolean;
  temperature?: number;
  numPredict?: number;
  numCtx?: number;
  timeoutMs?: number;
  retries?: number;
};

export type LlmChatRouteRequest = {
  messages: LlmMessage[];
  options?: LlmChatRouteOptions;
};

export const LLM_MESSAGE_MAX = 8000;

export const LLM_MESSAGES_MAX = 32;

function isLlmRole(value: unknown): value is LlmRole {
  return (
    value === "system" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedInt(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function isRouteOptions(value: unknown): value is LlmChatRouteOptions {
  if (!isRecord(value)) return false;

  for (const key of Object.keys(value)) {
    const item = value[key];

    switch (key) {
      case "format":
        if (item !== "json") return false;
        break;
      case "think":
        if (typeof item !== "boolean") return false;
        break;
      case "temperature":
        if (typeof item !== "number" || item < 0 || item > 2) return false;
        break;
      case "numPredict":
        if (!isBoundedInt(item, 1, 8192)) return false;
        break;
      case "numCtx":
        if (!isBoundedInt(item, 512, 131072)) return false;
        break;
      case "timeoutMs":
        if (!isBoundedInt(item, 1000, 180000)) return false;
        break;
      case "retries":
        if (!isBoundedInt(item, 0, 3)) return false;
        break;
      default:
        return false;
    }
  }

  return true;
}

/**
 * Validate the POST /api/llm/chat body. The client may tune sampling
 * and budgets, but never the model or base URL (server env owns them).
 */
export function isLlmChatRouteRequest(
  value: unknown,
): value is LlmChatRouteRequest {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.messages)) return false;
  if (value.messages.length < 1 || value.messages.length > LLM_MESSAGES_MAX) {
    return false;
  }

  for (const message of value.messages) {
    if (!isRecord(message)) return false;
    if (!isLlmRole(message.role)) return false;
    if (typeof message.content !== "string") return false;
    if (message.content.trim().length === 0) return false;
    if (message.content.length > LLM_MESSAGE_MAX) return false;
  }

  return value.options === undefined || isRouteOptions(value.options);
}
