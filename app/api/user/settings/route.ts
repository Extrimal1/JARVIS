import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import { dbFromAuth, dbList, dbUpsert } from "@/src/lib/supabase/db";

/** GET / PUT { lectureAutoUpload, memoryEnabled? } — user settings singleton. */

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
      // Absent (pre-migration databases) counts as enabled.
      memoryEnabled: first?.memory_enabled !== false,
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
        "boolean" ||
      ((body as Record<string, unknown>).memoryEnabled !== undefined &&
        typeof (body as Record<string, unknown>).memoryEnabled !== "boolean")
    ) {
      return fail("bad-request", "Ungültige Einstellungen.", 400);
    }

    const input = body as {
      lectureAutoUpload: boolean;
      memoryEnabled?: boolean;
    };
    // Only send `memory_enabled` when the client sets it, so
    // lecture-only clients keep working on pre-migration databases.
    const row: Record<string, unknown> = {
      lecture_auto_upload: input.lectureAutoUpload,
    };

    if (input.memoryEnabled !== undefined) {
      row.memory_enabled = input.memoryEnabled;
    }

    await dbUpsert(db, "user_settings", [row]);

    return ok({
      lectureAutoUpload: input.lectureAutoUpload,
      ...(input.memoryEnabled === undefined
        ? {}
        : { memoryEnabled: input.memoryEnabled }),
    });
  } catch (error) {
    return failFromUnknown("user/settings", error);
  }
});
