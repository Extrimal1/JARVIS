import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  BRIEFING_TIMEZONE_DEFAULT,
  isBriefingSettings,
  type BriefingSettings,
} from "@/src/lib/briefing/schedule";
import {
  loadBriefingSettings,
  rowToSettings,
} from "@/src/lib/briefing/serverData";
import { dbFromAuth, dbUpsert } from "@/src/lib/supabase/db";

/**
 * GET / PUT /api/briefing/settings — delivery schedule singleton
 * { enabled, time, timezone, city, interests }. PUT validates strictly;
 * invalid bodies are 400 (never stored half-valid).
 */

export const GET = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const stored = await loadBriefingSettings(db);

    return ok({ ...stored.settings, lastSentDate: stored.lastSentDate });
  } catch (error) {
    return failFromUnknown("briefing/settings", error);
  }
});

export const PUT = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const body = await readJson(request);

    if (!isBriefingSettings(body)) {
      return fail(
        "bad-request",
        "Ungültige Briefing-Einstellungen (enabled, time HH:MM, timezone, city, interests erwartet).",
        400,
      );
    }

    const settings = body as BriefingSettings;
    const rows = await dbUpsert<Record<string, unknown>>(
      db,
      "briefing_settings",
      [
        {
          enabled: settings.enabled,
          time: settings.time,
          timezone: settings.timezone,
          city: settings.city,
          interests: settings.interests.slice(0, 500),
        },
      ],
    );

    const stored = rows[0] === undefined ? null : rowToSettings(rows[0]);

    return ok({
      ...(stored?.settings ?? { ...settings, timezone: settings.timezone || BRIEFING_TIMEZONE_DEFAULT }),
      lastSentDate: stored?.lastSentDate ?? null,
    });
  } catch (error) {
    return failFromUnknown("briefing/settings", error);
  }
});
