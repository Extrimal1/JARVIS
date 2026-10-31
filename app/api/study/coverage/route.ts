import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { getStudyCoverage } from "@/src/lib/api/modules/studyIntel";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** GET coverage: per-document coverage snapshot for the Study UI. */

export const GET = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const documentId = request.nextUrl.searchParams.get("documentId");

    if (documentId === null || documentId === "") {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    const outcome = await getStudyCoverage(db, documentId);

    if (!outcome.ok) {
      return fail("not-found", outcome.message, outcome.http);
    }

    return ok(outcome.coverage);
  } catch (error) {
    return failFromUnknown("study", error);
  }
});
