import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { downloadBatchFile } from "@/src/lib/api/modules/uploads";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** GET signed statement-PDF URL for one batch. */

export const GET = authed(async (_request, auth, route) => {
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

    const url = await downloadBatchFile(db, id);

    if (url === null) {
      return fail("not-found", "PDF nicht gefunden.", 404);
    }

    return ok({ url });
  } catch (error) {
    return failFromUnknown("finance/batches/download", error);
  }
});
