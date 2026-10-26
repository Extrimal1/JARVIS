import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { getFinanceDoc } from "@/src/lib/api/modules/finance";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** GET /api/finance → FinanceData assembled from 4 tables. */

export const GET = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    return ok(await getFinanceDoc(db));
  } catch (error) {
    return failFromUnknown("finance", error);
  }
});
