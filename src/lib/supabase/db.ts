import {
  supaFetch,
  supabaseEnv,
  type SupabaseEnv,
} from "./supabase";

/**
 * Typed PostgREST helpers (server-side only). Every call carries the
 * user's access token so RLS applies; callers additionally scope all
 * filters to `user_id` (defense in depth).
 */

export type DbClient = {
  env: SupabaseEnv;
  token: string;
  userId: string;
};

export function dbFor(
  env: SupabaseEnv,
  token: string,
  userId: string,
): DbClient {
  return { env, token, userId };
}

export function dbFromAuth(auth: {
  accessToken: string;
  userId: string;
}): DbClient | null {
  const env = supabaseEnv();

  return env === null ? null : dbFor(env, auth.accessToken, auth.userId);
}

function encode(value: string | number | boolean): string {
  return encodeURIComponent(String(value));
}

function matchParams(
  db: DbClient,
  filters: string[] = [],
): Record<string, string> {
  const params: Record<string, string> = {
    user_id: `eq.${encode(db.userId)}`,
  };

  for (const filter of filters) {
    const dot = filter.indexOf("=");

    if (dot > 0) {
      params[filter.slice(0, dot)] = filter.slice(dot + 1);
    }
  }

  return params;
}

function buildQuery(params: Record<string, string | undefined>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      parts.push(`${key}=${value}`);
    }
  }

  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export type ListOptions = {
  select?: string;
  /** Extra PostgREST filters, e.g. "date=gte.2026-01-01". */
  filters?: string[];
  order?: string;
  limit?: number;
};

/** SELECT rows owned by the user. */
export async function dbList<T>(
  db: DbClient,
  table: string,
  options: ListOptions = {},
): Promise<T[]> {
  const query = buildQuery({
    select: options.select ?? "*",
    ...matchParams(db, options.filters),
    ...(options.order === undefined ? {} : { order: options.order }),
    ...(options.limit === undefined ? {} : { limit: String(options.limit) }),
  });

  return supaFetch<T[]>(db.env, `/rest/v1/${table}${query}`, {
    token: db.token,
  });
}

/** SELECT one owned row by id (null when missing or foreign). */
export async function dbGetOne<T>(
  db: DbClient,
  table: string,
  id: string,
): Promise<T | null> {
  const rows = await dbList<T>(db, table, {
    filters: [`id=eq.${encode(id)}`],
    limit: 1,
  });

  return rows[0] ?? null;
}

/** INSERT rows; `user_id` is forced to the authenticated user. */
export async function dbInsert<T>(
  db: DbClient,
  table: string,
  rows: Record<string, unknown>[],
): Promise<T[]> {
  const owned = rows.map((row) => ({ ...row, user_id: db.userId }));

  return supaFetch<T[]>(db.env, `/rest/v1/${table}`, {
    method: "POST",
    token: db.token,
    headers: { Prefer: "return=representation" },
    body: owned,
  });
}

/** UPDATE one owned row by id. Returns updated rows (empty = missing). */
export async function dbUpdate<T>(
  db: DbClient,
  table: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<T[]> {
  const { user_id: _ignored, id: _idIgnored, ...rest } = patch;
  void _ignored;
  void _idIgnored;

  const query = buildQuery(
    matchParams(db, [`id=eq.${encode(id)}`]),
  );

  return supaFetch<T[]>(db.env, `/rest/v1/${table}${query}`, {
    method: "PATCH",
    token: db.token,
    headers: { Prefer: "return=representation" },
    body: { ...rest, updated_at: new Date().toISOString() },
  });
}

/** DELETE one owned row by id. */
export async function dbDelete(
  db: DbClient,
  table: string,
  id: string,
): Promise<void> {
  const query = buildQuery(matchParams(db, [`id=eq.${encode(id)}`]));

  await supaFetch(db.env, `/rest/v1/${table}${query}`, {
    method: "DELETE",
    token: db.token,
    headers: { Prefer: "return=minimal" },
  });
}

/** DELETE owned rows matching extra filters. */
export async function dbDeleteWhere(
  db: DbClient,
  table: string,
  filters: string[],
): Promise<void> {
  const query = buildQuery(matchParams(db, filters));

  await supaFetch(db.env, `/rest/v1/${table}${query}`, {
    method: "DELETE",
    token: db.token,
    headers: { Prefer: "return=minimal" },
  });
}

/**
 * UPSERT rows (merge-duplicates resolves on the table primary key).
 * For idempotency on non-PK unique targets, insert and treat HTTP 409
 * as already-done instead.
 */
export async function dbUpsert<T>(
  db: DbClient,
  table: string,
  rows: Record<string, unknown>[],
): Promise<T[]> {
  const owned = rows.map((row) => ({ ...row, user_id: db.userId }));

  return supaFetch<T[]>(db.env, `/rest/v1/${table}`, {
    method: "POST",
    token: db.token,
    headers: {
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: owned,
  });
}
