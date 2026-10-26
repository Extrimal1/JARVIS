import {
  dbDelete,
  dbGetOne,
  dbInsert,
  dbList,
  dbUpdate,
  type DbClient,
} from "@/src/lib/supabase/db";

/**
 * Generic CRUD route logic over one user-owned table. Every operation
 * is scoped to the authenticated user (application filter + RLS).
 * Missing-or-foreign rows uniformly surface as "missing" (no leaks).
 * Updates read-merge-validate-write so partial patches are checked
 * against the full domain validator.
 */

export type CheckOk = { row: Record<string, unknown> };
export type CheckFail = { message: string };
export type CheckResult = CheckOk | CheckFail;

export function checkFailed(result: CheckResult): result is CheckFail {
  return !("row" in result);
}

/** Keep only known patch keys; null when the patch isn't an object. */
export function pickPatch(
  patch: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return null;
  }

  const record = patch as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of keys) {
    if (record[key] !== undefined) {
      out[key] = record[key];
    }
  }

  return out;
}

export function requireId(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;

  const id = (body as Record<string, unknown>).id;

  return typeof id === "string" && id.trim() !== "" ? id : null;
}

export type CrudConfig = {
  table: string;
  order?: string;
  /** Map a DB row to the domain shape (validated outbound). */
  toDomain: (row: Record<string, unknown>) => unknown;
  /** Validate outbound domain data (usually the existing isList). */
  isList: (value: unknown) => boolean;
  /** Validate a create body → DB row (user_id added by the factory). */
  checkCreate: (
    db: DbClient,
    body: unknown,
  ) => CheckResult | Promise<CheckResult>;
  /**
   * Merge a patch into the existing domain object, validate the whole,
   * return the DB row. Foreign-key ownership must be re-checked here.
   */
  checkUpdate: (
    db: DbClient,
    patch: unknown,
    existing: unknown,
  ) => CheckResult | Promise<CheckResult>;
};

export type CrudOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; message: string }
  | { ok: false; missing: true };

export function crudHandlers(config: CrudConfig) {
  async function list(db: DbClient): Promise<CrudOutcome<unknown[]>> {
    const rows = await dbList<Record<string, unknown>>(db, config.table, {
      order: config.order,
      limit: 2000,
    });
    const items = rows.map(config.toDomain);

    if (!config.isList(items)) {
      throw new Error(`MAPPING_MISMATCH:${config.table}`);
    }

    return { ok: true, data: items };
  }

  async function create(
    db: DbClient,
    body: unknown,
  ): Promise<CrudOutcome<unknown>> {
    const checked = await config.checkCreate(db, body);

    if (checkFailed(checked)) {
      return { ok: false, message: checked.message };
    }

    const rows = await dbInsert<Record<string, unknown>>(db, config.table, [
      checked.row,
    ]);
    const first = rows[0];

    if (first === undefined) {
      throw new Error(`INSERT_EMPTY:${config.table}`);
    }

    const item = config.toDomain(first);

    if (!config.isList([item])) {
      throw new Error(`MAPPING_MISMATCH:${config.table}`);
    }

    return { ok: true, data: item };
  }

  async function update(
    db: DbClient,
    id: string,
    body: unknown,
  ): Promise<CrudOutcome<unknown>> {
    const current = await dbGetOne<Record<string, unknown>>(
      db,
      config.table,
      id,
    );

    if (current === null) {
      return { ok: false, missing: true };
    }

    const checked = await config.checkUpdate(
      db,
      body,
      config.toDomain(current),
    );

    if (checkFailed(checked)) {
      return { ok: false, message: checked.message };
    }

    const rows = await dbUpdate<Record<string, unknown>>(
      db,
      config.table,
      id,
      checked.row,
    );
    const first = rows[0];

    if (first === undefined) {
      return { ok: false, missing: true };
    }

    const item = config.toDomain(first);

    if (!config.isList([item])) {
      throw new Error(`MAPPING_MISMATCH:${config.table}`);
    }

    return { ok: true, data: item };
  }

  async function remove(
    db: DbClient,
    id: string,
  ): Promise<CrudOutcome<null>> {
    await dbDelete(db, config.table, id);

    return { ok: true, data: null };
  }

  return { list, create, update, remove };
}

/** Map a CrudOutcome to HTTP semantics (caller builds the response). */
export function outcomeStatus(outcome: {
  ok: boolean;
  missing?: true;
  message?: string;
}): { status: "ok" | "bad-request" | "not-found"; message: string } {
  if (outcome.ok) {
    return { status: "ok", message: "" };
  }

  if ("missing" in outcome && outcome.missing === true) {
    return { status: "not-found", message: "Eintrag nicht gefunden." };
  }

  return {
    status: "bad-request",
    message:
      "message" in outcome && typeof outcome.message === "string"
        ? outcome.message
        : "Ungültige Anfrage.",
  };
}
