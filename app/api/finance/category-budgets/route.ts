import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  deleteCategoryBudget,
  saveCategoryBudget,
} from "@/src/lib/api/modules/finance";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** PUT { category, cents } / DELETE ?category= — category budgets. */

export const PUT = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const result = await saveCategoryBudget(db, await readJson(request));

    if ("message" in result) {
      return fail("bad-request", result.message, 400);
    }

    return ok(result);
  } catch (error) {
    return failFromUnknown("finance/category-budgets", error);
  }
});

export const DELETE = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const category = request.nextUrl.searchParams.get("category") ?? "";

    if (category === "") {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    await deleteCategoryBudget(db, category);

    return ok({ deleted: true });
  } catch (error) {
    return failFromUnknown("finance/category-budgets", error);
  }
});
