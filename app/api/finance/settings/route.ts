import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import { saveSettings } from "@/src/lib/api/modules/finance";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** PUT /api/finance/settings { monthlyBudgetCents } */

export const PUT = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const result = await saveSettings(db, await readJson(request));

    if ("message" in result) {
      return fail("bad-request", result.message, 400);
    }

    return ok(result);
  } catch (error) {
    return failFromUnknown("finance/settings", error);
  }
});
