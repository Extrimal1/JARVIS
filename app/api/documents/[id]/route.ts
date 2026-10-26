import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  deleteStudyDoc,
  updateStudyDocMeta,
} from "@/src/lib/api/modules/documents";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** PATCH meta / DELETE (row + stored objects). */

export const PATCH = authed(async (request, auth, route) => {
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

    const result = await updateStudyDocMeta(db, id, await readJson(request));

    if (result === null) {
      return fail("not-found", "Dokument nicht gefunden.", 404);
    }

    if ("message" in result) {
      return fail("bad-request", result.message, 400);
    }

    return ok(result);
  } catch (error) {
    return failFromUnknown("documents", error);
  }
});

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

    const deleted = await deleteStudyDoc(db, id);

    if (!deleted) {
      return fail("not-found", "Dokument nicht gefunden.", 404);
    }

    return ok({ deleted: true });
  } catch (error) {
    return failFromUnknown("documents", error);
  }
});
