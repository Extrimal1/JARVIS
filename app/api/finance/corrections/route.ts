import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  listCorrections,
  saveCorrections,
  validCorrections,
} from "@/src/lib/api/modules/finance";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** GET list / PUT { items[] } — categorization corrections. */

export const GET = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    return ok(await listCorrections(db));
  } catch (error) {
    return failFromUnknown("finance/corrections", error);
  }
});

export const PUT = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const items = validCorrections(await readJson(request));

    if (items === null) {
      return fail("bad-request", "Ungültige Korrekturen.", 400);
    }

    await saveCorrections(db, items);

    return ok(items);
  } catch (error) {
    return failFromUnknown("finance/corrections", error);
  }
});
