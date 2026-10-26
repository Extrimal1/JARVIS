import type { NextRequest, NextResponse } from "next/server";
import { dbFromAuth } from "@/src/lib/supabase/db";
import { authed, type AuthContext } from "./withAuth";
import { fail, failFromUnknown, ok, readJson } from "./respond";
import {
  crudHandlers,
  outcomeStatus,
  type CrudConfig,
} from "./crud";

/**
 * One-line route bindings for standard collections:
 *   export const { GET, POST } = collectionRoutes(tasksConfig, "tasks");
 */

function noDb(): NextResponse {
  return fail(
    "cloud-not-configured",
    "Cloud-Backend ist nicht konfiguriert.",
    503,
  );
}

export function collectionRoutes(config: CrudConfig, routeName: string) {
  const handlers = crudHandlers(config);

  async function listAll(auth: AuthContext): Promise<NextResponse> {
    const db = dbFromAuth(auth);

    if (db === null) return noDb();

    const outcome = await handlers.list(db);

    if (!outcome.ok) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    return ok(outcome.data);
  }

  async function createOne(
    request: NextRequest,
    auth: AuthContext,
  ): Promise<NextResponse> {
    const db = dbFromAuth(auth);

    if (db === null) return noDb();

    const outcome = await handlers.create(db, await readJson(request));
    const mapped = outcomeStatus(outcome);

    if (mapped.status === "ok" && outcome.ok) {
      return ok(outcome.data, 201);
    }

    if (mapped.status === "not-found") {
      return fail("not-found", mapped.message, 404);
    }

    return fail("bad-request", mapped.message, 400);
  }

  return {
    GET: authed(async (_request, auth) => {
      try {
        return await listAll(auth);
      } catch (error) {
        return failFromUnknown(routeName, error);
      }
    }),
    POST: authed(async (request, auth) => {
      try {
        return await createOne(request, auth);
      } catch (error) {
        return failFromUnknown(routeName, error);
      }
    }),
  };
}

export function itemRoutes(config: CrudConfig, routeName: string) {
  const handlers = crudHandlers(config);

  async function idOf(
    route: { params: Promise<Record<string, string>> },
    key: string,
  ): Promise<string> {
    const params = await route.params;

    return params[key] ?? "";
  }

  return {
    PATCH: authed(
      async (
        request,
        auth,
        route: { params: Promise<Record<string, string>> },
      ) => {
        try {
          const db = dbFromAuth(auth);

          if (db === null) return noDb();

          const outcome = await handlers.update(
            db,
            await idOf(route, "id"),
            await readJson(request),
          );
          const mapped = outcomeStatus(outcome);

          if (mapped.status === "ok" && outcome.ok) {
            return ok(outcome.data);
          }

          if (mapped.status === "not-found") {
            return fail("not-found", mapped.message, 404);
          }

          return fail("bad-request", mapped.message, 400);
        } catch (error) {
          return failFromUnknown(routeName, error);
        }
      },
    ),
    DELETE: authed(
      async (
        _request,
        auth,
        route: { params: Promise<Record<string, string>> },
      ) => {
        try {
          const db = dbFromAuth(auth);

          if (db === null) return noDb();

          const outcome = await handlers.remove(db, await idOf(route, "id"));

          if (!outcome.ok) {
            return fail("bad-request", "Ungültige Anfrage.", 400);
          }

          return ok({ deleted: true });
        } catch (error) {
          return failFromUnknown(routeName, error);
        }
      },
    ),
  };
}
