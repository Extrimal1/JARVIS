import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  createStudyDoc,
  listStudyDocs,
  validCreateDoc,
} from "@/src/lib/api/modules/documents";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** GET list / POST create (+ signed upload URL). */

export const GET = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    return ok(await listStudyDocs(db));
  } catch (error) {
    return failFromUnknown("documents", error);
  }
});

export const POST = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const input = validCreateDoc(await readJson(request));

    if (input === null) {
      return fail("bad-request", "Ungültige Datei-Metadaten.", 400);
    }

    try {
      return ok(await createStudyDoc(db, auth.userId, input), 201);
    } catch (error) {
      if (error instanceof Error && error.message === "UNSUPPORTED_KIND") {
        return fail("bad-request", "Dateiformat wird nicht unterstützt.", 400);
      }

      throw error;
    }
  } catch (error) {
    return failFromUnknown("documents", error);
  }
});
