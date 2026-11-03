import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { composeBriefing } from "@/src/lib/briefing/compose";
import {
  loadBriefingInput,
  loadBriefingSettings,
} from "@/src/lib/briefing/serverData";
import { dbFromAuth } from "@/src/lib/supabase/db";

/**
 * GET /api/briefing — today's briefing composed server-side from the
 * caller's real data (tasks, calendar, study, quiz, finance, weather,
 * news). Cloud only: 503 without backend config.
 */

export const GET = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const stored = await loadBriefingSettings(db);
    const briefing = composeBriefing(await loadBriefingInput(db, stored));

    return ok(briefing);
  } catch (error) {
    return failFromUnknown("briefing", error);
  }
});
