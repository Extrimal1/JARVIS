import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  listSavedIds,
  savePlaceId,
  unsavePlaceId,
} from "@/src/lib/api/modules/lifestyle";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** GET ids / POST { placeId } / DELETE ?placeId= — saved places. */

export const GET = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    return ok(await listSavedIds(db));
  } catch (error) {
    return failFromUnknown("lifestyle/saved", error);
  }
});

export const POST = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const result = await savePlaceId(db, await readJson(request));

    if ("message" in result) {
      return fail("bad-request", result.message, 400);
    }

    return ok(result, 201);
  } catch (error) {
    return failFromUnknown("lifestyle/saved", error);
  }
});

export const DELETE = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const placeId = request.nextUrl.searchParams.get("placeId") ?? "";

    if (placeId === "") {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    await unsavePlaceId(db, placeId);

    return ok({ deleted: true });
  } catch (error) {
    return failFromUnknown("lifestyle/saved", error);
  }
});
