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
  const anonKey = process.env.SUPABASE_ANON_KEY ?? "";

  if (url === "" || anonKey === "") return null;

  return { url, anonKey };
}

export class SupabaseHttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SupabaseHttpError";
    this.status = status;
  }
}

async function parseErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();

    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;

      if (typeof record.message === "string") return record.message;
      if (typeof record.error_description === "string") {
        return record.error_description;
      }
      if (typeof record.error === "string") return record.error;
    }
  } catch {
    // Fall through to the generic message below.
  }

  return `Supabase request failed (${res.status}).`;
}

export type SupaInit = {
  method?: string;
  /** User access token; all data calls require it (RLS). */
  token?: string;
  body?: unknown;
  binary?: BodyInit;
  contentType?: string;
  headers?: Record<string, string>;
};

/** Raw fetch; throws SupabaseHttpError unless `res.ok`. */
export async function supaFetchRaw(
  env: SupabaseEnv,
  path: string,
  init: SupaInit = {},
): Promise<Response> {
  const res = await fetch(`${env.url}${path}`, {
    method: init.method ?? "GET",
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

  if (!res.ok) {
    throw new SupabaseHttpError(res.status, await parseErrorMessage(res));
  }

  return res;
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
