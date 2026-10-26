import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  createStatementUpload,
  validStatementUpload,
} from "@/src/lib/api/modules/uploads";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** POST batch meta → { batch, uploadUrl } for the statement PDF. */

export const POST = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const input = validStatementUpload(await readJson(request));

    if (input === null) {
      return fail("bad-request", "Ungültige Stapel-Metadaten.", 400);
    }

    return ok(await createStatementUpload(db, auth.userId, input), 201);
  } catch (error) {
    return failFromUnknown("finance/statement-upload", error);
  }
});
