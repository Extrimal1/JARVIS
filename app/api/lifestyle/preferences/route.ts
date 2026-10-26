import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  getPreferences,
  savePreferences,
} from "@/src/lib/api/modules/lifestyle";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** GET / PUT lifestyle preferences (singleton). */

export const GET = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    return ok(await getPreferences(db));
  } catch (error) {
    return failFromUnknown("lifestyle/preferences", error);
  }
});

export const PUT = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const result = await savePreferences(db, await readJson(request));

    if ("message" in result) {
      return fail("bad-request", result.message, 400);
    }

    return ok(result);
  } catch (error) {
    return failFromUnknown("lifestyle/preferences", error);
  }
});
