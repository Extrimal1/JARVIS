import { itemRoutes } from "@/src/lib/api/routeFactory";
import {
  batchesConfig,
  deleteBatchCascade,
} from "@/src/lib/api/modules/finance";
import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { dbFromAuth } from "@/src/lib/supabase/db";

export const { PATCH } = itemRoutes(batchesConfig, "finance/batches");

/** DELETE also removes linked transactions and the stored PDF. */
export const DELETE = authed(async (_request, auth, route) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const params = await route.params;
    const id = params.id ?? "";

    if (id === "") {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    return ok(await deleteBatchCascade(db, id));
  } catch (error) {
    return failFromUnknown("finance/batches", error);
  }
});
