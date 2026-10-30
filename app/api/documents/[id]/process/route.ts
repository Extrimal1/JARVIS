import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { processStudyDoc } from "@/src/lib/api/modules/studyIntel";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** POST process: extract → chunk → store (idempotent, re-process safe). */

export const POST = authed(async (_request, auth, route) => {
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

    const outcome = await processStudyDoc(db, auth.userId, id);

    if (!outcome.ok) {
      return fail(
        outcome.http === 404 ? "not-found" : "upstream-error",
        outcome.message,
        outcome.http,
      );
    }

    return ok(outcome.response);
  } catch (error) {
    return failFromUnknown("study", error);
  }
});
