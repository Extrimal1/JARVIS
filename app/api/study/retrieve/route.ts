import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  retrieveStudyChunks,
  validRetrieveInput,
} from "@/src/lib/api/modules/studyIntel";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** POST retrieve: keyword search over owned chunks (ranked excerpts). */

export const POST = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const input = validRetrieveInput(await readJson(request));

    if (input === null) {
      return fail("bad-request", "Ungültige Suchanfrage.", 400);
    }

    return ok(await retrieveStudyChunks(db, input));
  } catch (error) {
    return failFromUnknown("study", error);
  }
});
