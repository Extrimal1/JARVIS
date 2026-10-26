import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { downloadStudyDoc } from "@/src/lib/api/modules/documents";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** GET signed download URLs (blob + extracted text, short-lived). */

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

    const urls = await downloadStudyDoc(db, id);

    if (urls === null) {
      return fail("not-found", "Dokument nicht gefunden.", 404);
    }

    return ok(urls);
  } catch (error) {
    return failFromUnknown("documents/download", error);
  }
});
