import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { deleteBatchFile } from "@/src/lib/api/modules/uploads";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** DELETE the stored PDF only (confirmed transactions stay). */

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

    const deleted = await deleteBatchFile(db, id);

    if (!deleted) {
      return fail("not-found", "Stapel nicht gefunden.", 404);
    }

    return ok({ deleted: true });
  } catch (error) {
    return failFromUnknown("finance/batches/file", error);
  }
});
