import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import { checkFailed, crudHandlers } from "@/src/lib/api/crud";
import { transactionsConfig } from "@/src/lib/api/modules/finance";
import { dbFromAuth } from "@/src/lib/supabase/db";
import { MAX_BULK_ITEMS } from "@/src/lib/api/modules/uploads";

/** POST { items: Transaction[] } → bulk insert for confirmed imports. */

const handlers = crudHandlers(transactionsConfig);

export const POST = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const body = await readJson(request);

    if (
      typeof body !== "object" ||
      body === null ||
      !Array.isArray((body as Record<string, unknown>).items)
    ) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    const items = (body as { items: unknown[] }).items;

    if (items.length === 0 || items.length > MAX_BULK_ITEMS) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    // Validate everything before writing anything: an invalid item
    // mid-loop would otherwise leave a partial import behind (the loop
    // below has no transaction). checkCreate is read-only (validation +
    // ownership reads), so double-checking is safe.
    for (const item of items) {
      const checked = await transactionsConfig.checkCreate(db, item);

      if (checkFailed(checked)) {
        return fail("bad-request", checked.message, 400);
      }
    }

    let imported = 0;

    for (const item of items) {
      const outcome = await handlers.create(db, item);

      if (!outcome.ok) {
        return fail(
          "bad-request",
          "message" in outcome && typeof outcome.message === "string"
            ? outcome.message
            : "Ungültige Buchung.",
          400,
        );
      }

      imported += 1;
    }

    return ok({ imported }, 201);
  } catch (error) {
    return failFromUnknown("finance/transactions/bulk", error);
  }
});
