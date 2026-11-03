import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  isPushSubscription,
  type PushSubscription,
} from "@/src/lib/push/webpush";
import {
  dbDeleteWhere,
  dbFromAuth,
  dbInsert,
  dbList,
} from "@/src/lib/supabase/db";

/**
 * Push subscriptions (one row per device endpoint).
 * GET → own subscriptions (endpoint host + dates, never keys).
 * POST { endpoint, keys: { p256dh, auth } } → subscribe/refresh.
 * DELETE ?endpoint= → unsubscribe one device.
 */

type SubscriptionRow = {
  id: string;
  endpoint: string;
  created_at: string;
  last_used_at: string | null;
};

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "";
  }
}

export const GET = authed(async (_request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const rows = await dbList<SubscriptionRow>(db, "push_subscriptions", {
      select: "id,endpoint,created_at,last_used_at",
      order: "created_at.desc",
    });

    return ok(
      rows.map((row) => ({
        id: row.id,
        host: endpointHost(row.endpoint),
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      })),
    );
  } catch (error) {
    return failFromUnknown("briefing/subscriptions", error);
  }
});

export const POST = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const body = await readJson(request);

    if (!isPushSubscription(body)) {
      return fail(
        "bad-request",
        "Ungültige Push-Subscription (https-Endpoint + p256dh/auth erwartet).",
        400,
      );
    }

    const sub = body as PushSubscription;
    const userAgent = request.headers.get("user-agent") ?? "";

    // Refresh-or-insert: unique (user_id, endpoint); a 409 means a
    // concurrent insert won, which is the same desired state.
    await dbDeleteWhere(db, "push_subscriptions", [
      `endpoint=eq.${encodeURIComponent(sub.endpoint)}`,
    ]);
    await dbInsert(db, "push_subscriptions", [
      {
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: userAgent.slice(0, 300),
      },
    ]);

    return ok({ host: endpointHost(sub.endpoint) }, 201);
  } catch (error) {
    return failFromUnknown("briefing/subscriptions", error);
  }
});

export const DELETE = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const endpoint = request.nextUrl.searchParams.get("endpoint") ?? "";

    if (endpoint === "") {
      return fail("bad-request", "Endpoint fehlt.", 400);
    }

    await dbDeleteWhere(db, "push_subscriptions", [
      `endpoint=eq.${encodeURIComponent(endpoint)}`,
    ]);

    return ok({ deleted: true });
  } catch (error) {
    return failFromUnknown("briefing/subscriptions", error);
  }
});
