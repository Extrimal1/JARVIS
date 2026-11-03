import { NextResponse } from "next/server";
import { fail, failFromUnknown, ok } from "@/src/lib/api/respond";
import { composeBriefing } from "@/src/lib/briefing/compose";
import { toPushPayload } from "@/src/lib/briefing/format";
import {
  isBriefingDue,
  localDateInTimezone,
} from "@/src/lib/briefing/schedule";
import {
  loadBriefingInput,
  rowToSettings,
  serviceDbFor,
  serviceEnv,
} from "@/src/lib/briefing/serverData";
import {
  sendPush,
  vapidEnv,
  type PushSubscription,
} from "@/src/lib/push/webpush";
import { dbDeleteWhere, dbList, dbUpdate } from "@/src/lib/supabase/db";
import { supaFetch } from "@/src/lib/supabase/supabase";

/**
 * POST /api/briefing/dispatch — server-side scheduler entrypoint.
 * Hit every 5–15 minutes by an external cron (cron-job.org, Supabase
 * pg_cron, or Vercel Cron); the PC need not run. Auth: exactly
 * `Authorization: Bearer <CRON_SECRET>`. For every user whose local
 * time reached their schedule and who was not served yet today:
 * compose from real data, push to all devices, audit in briefing_log.
 */

const MAX_USERS_PER_RUN = 100;

type SettingsRow = Record<string, unknown> & { user_id: string };

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";

  if (secret === "") return false;

  const header = request.headers.get("authorization") ?? "";

  if (!header.startsWith("Bearer ")) return false;

  const presented = header.slice("Bearer ".length);

  if (presented.length !== secret.length) return false;

  let diff = 0;

  for (let index = 0; index < secret.length; index += 1) {
    diff |= secret.charCodeAt(index) ^ presented.charCodeAt(index);
  }

  return diff === 0;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    if (!authorized(request)) {
      return fail("unauthorized", "Ungültiges Cron-Secret.", 401);
    }

    const env = serviceEnv();

    if (env === null) {
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

    const now = new Date();
    const rows = await supaFetch<SettingsRow[]>(
      env,
      "/rest/v1/briefing_settings?enabled=eq.true&select=user_id,enabled,time,timezone,city,interests,last_sent_date",
      { token: env.anonKey },
    );

    let checked = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const row of rows.slice(0, MAX_USERS_PER_RUN)) {
      checked += 1;

      const stored = rowToSettings(row);

      if (!isBriefingDue(stored.settings, now, stored.lastSentDate)) {
        continue;
      }

      const db = serviceDbFor(row.user_id);

      if (db === null) {
        failed += 1;
        continue;
      }

      const todayLocal = localDateInTimezone(now, stored.settings.timezone);

      try {
        const subs = await dbList<SubscriptionRow>(db, "push_subscriptions", {
          select: "id,endpoint,p256dh,auth",
        });

        if (subs.length === 0) {
          skipped += 1;
          await supaFetch(env, "/rest/v1/briefing_log", {
            method: "POST",
            token: env.anonKey,
            body: [
              {
                user_id: row.user_id,
                sent_date: todayLocal,
                status: "skipped",
                detail: "Kein Gerät registriert.",
              },
            ],
          });
          continue;
        }

        const briefing = composeBriefing(
          await loadBriefingInput(db, stored, now),
        );
        const body = JSON.stringify(toPushPayload(briefing));

        let delivered = 0;
        let gone = 0;

        for (const sub of subs) {
          const subscription: PushSubscription = {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          };
          const result = await sendPush(subscription, body, vapid);

          if (result.gone) {
            gone += 1;
            await dbDeleteWhere(db, "push_subscriptions", [
              `id=eq.${sub.id}`,
            ]).catch(() => undefined);
          } else if (result.ok) {
            delivered += 1;
            await dbUpdate(db, "push_subscriptions", sub.id, {
              last_used_at: now.toISOString(),
            }).catch(() => []);
          }
        }

        const status =
          delivered > 0 ? (gone > 0 || delivered < subs.length ? "partial" : "sent") : "failed";

        if (status === "failed") failed += 1;
        else sent += 1;

        await supaFetch(
          env,
          `/rest/v1/briefing_settings?user_id=eq.${row.user_id}`,
          {
            method: "PATCH",
            token: env.anonKey,
            body: {
              last_sent_date: todayLocal,
              updated_at: now.toISOString(),
            },
          },
        );
        await supaFetch(env, "/rest/v1/briefing_log", {
          method: "POST",
          token: env.anonKey,
          body: [
            {
              user_id: row.user_id,
              sent_date: todayLocal,
              status,
              detail: `${delivered}/${subs.length} zugestellt, ${gone} abgelaufen.`,
            },
          ],
        });
      } catch (error) {
        failed += 1;
        errors.push(
          `user ${row.user_id}: ${error instanceof Error ? error.message : "unknown"}`,
        );
        console.error("[api:briefing/dispatch]", row.user_id, error);

        await supaFetch(env, "/rest/v1/briefing_log", {
          method: "POST",
          token: env.anonKey,
          body: [
            {
              user_id: row.user_id,
              sent_date: todayLocal,
              status: "failed",
              detail: "Zustellung fehlgeschlagen.",
            },
          ],
        }).catch(() => undefined);
      }
    }

    return ok({
      checked,
      sent,
      failed,
      skipped,
      truncated: rows.length > MAX_USERS_PER_RUN,
      errors: errors.slice(0, 10),
    });
  } catch (error) {
    return failFromUnknown("briefing/dispatch", error);
  }
}
