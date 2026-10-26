import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import { dbFromAuth, dbList, dbUpsert } from "@/src/lib/supabase/db";

/** GET / PUT { lectureAutoUpload } — user settings singleton. */

export const GET = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const rows = await dbList<Record<string, unknown>>(db, "user_settings", {
      limit: 1,
    });
    const first = rows[0];

    return ok({
      lectureAutoUpload: first?.lecture_auto_upload === true,
    });
  } catch (error) {
    return failFromUnknown("user/settings", error);
  }
});

export const PUT = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const body = await readJson(request);

    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as Record<string, unknown>).lectureAutoUpload !==
        "boolean"
    ) {
      return fail("bad-request", "Ungültige Einstellungen.", 400);
    }

    const lectureAutoUpload = (body as { lectureAutoUpload: boolean })
      .lectureAutoUpload;

    await dbUpsert(db, "user_settings", [{ lecture_auto_upload: lectureAutoUpload }]);

    return ok({ lectureAutoUpload });
  } catch (error) {
    return failFromUnknown("user/settings", error);
  }
});
