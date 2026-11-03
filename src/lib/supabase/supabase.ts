/**
 * Minimal Supabase REST plumbing (SERVER-ONLY — import only from API
 * routes or server code). Zero dependencies: plain fetch against the
 * stable Auth / PostgREST / Storage HTTP APIs, so no SDK install is
 * required. The browser never calls Supabase directly and never sees
 * tokens; RLS is enforced by Supabase on every request.
 *
 * Endpoint shapes follow the public Supabase HTTP API. Re-verify them
 * against a live project during setup (see docs/SETUP.md); every
 * endpoint lives in exactly one function below, so drift is a one-line
 * fix.
 */

export type SupabaseEnv = {
  url: string;
  anonKey: string;
};

export function supabaseEnv(): SupabaseEnv | null {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";

  if (url === "" || anonKey === "") return null;

  return { url, anonKey };
}

export class SupabaseHttpError extends Error {
  status: number;
  /**
   * PostgREST/PG error code when Supabase sent one (e.g. PGRST205 for a
   * table missing from the schema cache, 22P02 for malformed UUIDs).
   * Status 0 with NETWORK_ERROR/TIMEOUT means the request never got a
   * response (network failure or timeout).
   */
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "SupabaseHttpError";
    this.status = status;
    this.code = code;
  }
}

type ParsedError = { message: string; code?: string };

async function parseError(res: Response): Promise<ParsedError> {
  const fallback = `Supabase request failed (${res.status}).`;

  try {
    const body: unknown = await res.json();

    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      const code =
        typeof record.code === "string" ? record.code : undefined;

      if (typeof record.message === "string") {
        return { message: record.message, code };
      }
      if (typeof record.error_description === "string") {
        return { message: record.error_description, code };
      }
      if (typeof record.error === "string") {
        return { message: record.error, code };
      }
      if (code !== undefined) return { message: fallback, code };
    }
  } catch {
    // Fall through to the generic message below.
  }

  return { message: fallback };
}

export type SupaInit = {
  method?: string;
  /** User access token; all data calls require it (RLS). */
  token?: string;
  body?: unknown;
  binary?: BodyInit;
  contentType?: string;
  headers?: Record<string, string>;
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15000;
const RETRY_DELAY_MS = 250;
/** Transient gateway statuses worth one idempotent retry. */
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  );
}

async function singleFetch(
  env: SupabaseEnv,
  path: string,
  init: SupaInit,
  method: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  let res: Response;

  try {
    res = await fetch(`${env.url}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        apikey: env.anonKey,
        ...(init.token === undefined
          ? {}
          : { Authorization: `Bearer ${init.token}` }),
        ...(init.binary !== undefined || init.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...(init.contentType === undefined
          ? {}
          : { "Content-Type": init.contentType }),
        ...init.headers,
      },
      body:
        init.binary ??
        (init.body === undefined ? undefined : JSON.stringify(init.body)),
    });
  } catch (error) {
    // Network failure or timeout: no response was received.
    throw new SupabaseHttpError(
      0,
      isAbort(error)
        ? "Supabase request timed out."
        : "Supabase request failed (network).",
      isAbort(error) ? "TIMEOUT" : "NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const parsed = await parseError(res);

    throw new SupabaseHttpError(res.status, parsed.message, parsed.code);
  }

  return res;
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof SupabaseHttpError &&
    (error.status === 0 || RETRYABLE_STATUSES.has(error.status))
  );
}

/**
 * Raw fetch; throws SupabaseHttpError unless `res.ok`. Idempotent
 * GETs are retried once on network failure, timeout, or a transient
 * 502/503/504. Mutations are never auto-retried — a retry could
 * double-apply, so callers rely on client-generated UUIDs plus the
 * HTTP 409 conflict path instead.
 */
export async function supaFetchRaw(
  env: SupabaseEnv,
  path: string,
  init: SupaInit = {},
): Promise<Response> {
  const method = init.method ?? "GET";
  const attempts = method === "GET" ? 2 : 1;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await singleFetch(env, path, init, method);
    } catch (error) {
      lastError = error;

      if (attempt === attempts || !isRetryable(error)) break;

      await sleep(RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

/** JSON fetch; 204/empty bodies resolve to undefined. */
export async function supaFetch<T>(
  env: SupabaseEnv,
  path: string,
  init: SupaInit = {},
): Promise<T> {
  const res = await supaFetchRaw(env, path, init);

  if (res.status === 204) return undefined as T;

  const text = await res.text();

  if (text === "") return undefined as T;

  return JSON.parse(text) as T;
}
