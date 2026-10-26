import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import { completeStudyDocText } from "@/src/lib/api/modules/documents";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** POST { hasText } → signed text-object upload URL (TXT/MD only). */

export const POST = authed(async (request, auth, route) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const params = await route.params;
    const id = params.id ?? "";
    const body = await readJson(request);

    if (
      id === "" ||
      typeof body !== "object" ||
      body === null ||
      (body as Record<string, unknown>).hasText !== true
    ) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    const result = await completeStudyDocText(db, auth.userId, id);

    if (result === null) {
      return fail("not-found", "Dokument nicht gefunden.", 404);
    }

    return ok(result);
  } catch (error) {
    return failFromUnknown("documents/complete", error);
  }
});
