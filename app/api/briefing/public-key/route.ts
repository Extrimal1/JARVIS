import { NextResponse } from "next/server";
import { fail, ok } from "@/src/lib/api/respond";
import { vapidEnv } from "@/src/lib/push/webpush";

/**
 * GET /api/briefing/public-key — VAPID public key for `pushManager.subscribe`.
 * Public (no login): the key is public by design (RFC 8292) and
 * identifies the server, never the user. 503 until keys are configured.
 */

export async function GET(): Promise<NextResponse> {
  const vapid = vapidEnv();

  if (vapid === null) {
    return fail(
      "cloud-not-configured",
      "Push ist nicht konfiguriert (VAPID-Schlüssel fehlen).",
      503,
    );
  }

  return ok({ publicKey: vapid.publicKey });
}
