import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { composeBriefing } from "@/src/lib/briefing/compose";
import { toPushPayload } from "@/src/lib/briefing/format";
import {
  loadBriefingInput,
  loadBriefingSettings,
} from "@/src/lib/briefing/serverData";
import {
  sendPush,
  vapidEnv,
  type PushSubscription,
} from "@/src/lib/push/webpush";
import { dbFromAuth, dbList, dbUpdate } from "@/src/lib/supabase/db";

/**
 * POST /api/briefing/test — real delivery test: composes the caller's
 * current briefing and pushes it to the caller's own subscriptions.
 * Returns per-endpoint results. Notifications must never be claimed
 * active before this endpoint reports ok:true for the device.
 */

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export const POST = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const vapid = vapidEnv();

    if (vapid === null) {
      return fail(
        "cloud-not-configured",
        "Push ist nicht konfiguriert (VAPID-Schlüssel fehlen).",
        503,
      );
    }

    const rows = await dbList<SubscriptionRow>(db, "push_subscriptions", {
      select: "id,endpoint,p256dh,auth",
    });

    if (rows.length === 0) {
      return fail(
        "not-found",
        "Kein Gerät registriert. Aktiviere zuerst Push auf deinem Handy.",
        404,
      );
    }

    const stored = await loadBriefingSettings(db);
    const briefing = composeBriefing(await loadBriefingInput(db, stored));
    const payload = toPushPayload(briefing);
    const body = JSON.stringify(payload);

    const results = await Promise.all(
      rows.map(async (row) => {
        const sub: PushSubscription = {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        };
        const sent = await sendPush(sub, body, vapid);

        if (sent.ok && !sent.gone) {
          await dbUpdate(db, "push_subscriptions", row.id, {
            last_used_at: new Date().toISOString(),
          }).catch(() => []);
        }

        let host = "";

        try {
          host = new URL(row.endpoint).host;
        } catch {
          host = "";
        }

        return { host, ...sent };
      }),
    );

    const delivered = results.filter(
      (result) => result.ok && !result.gone,
    ).length;

    return ok({ delivered, total: results.length, results });
  } catch (error) {
    return failFromUnknown("briefing/test", error);
  }
});
