import type { NextRequest } from "next/server";
import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  describePlan,
  isAssistantRequest,
} from "@/src/lib/assistant/actions";
import {
  isProviderError,
  providerStatus,
  selectProvider,
} from "@/src/lib/assistant/providers";
import { CLOUD_ENABLED } from "@/src/lib/db/mode";

/**
 * POST /api/assistant — stateless command understanding.
 *
 * Request: `{ text, todayISO, nowTime, timezone, locale,
 * idempotencyKey }` (all validated). Response: a validated
 * `AssistantPlan` plus an "understood" line. This endpoint NEVER
 * touches user data: no database, no storage, no user id — it only
 * parses text. Execution happens client-side through the existing
 * authenticated stores.
 *
 * GET /api/assistant — provider status for honest UI labeling
 * (provider id + configured flag only; no URLs, no keys).
 *
 * Auth mirrors the app mode: required in cloud mode (same session
 * cookies as every other route), open in local mode where no login
 * exists. Either way the payload carries no user identity.
 */

async function handlePost(request: NextRequest) {
  const body = await readJson(request);

  if (!isAssistantRequest(body)) {
    return fail("bad-request", "Ungültige Anfrage.", 400);
  }

  const provider = selectProvider();

  try {
    const result = await provider.parse(body.text, {
      todayISO: body.todayISO,
      nowTime: body.nowTime,
      timezone: body.timezone,
      locale: body.locale,
    });

    return ok({
      plan: result.plan,
      provider: provider.id,
      understood: describePlan(result.plan, result.locale),
      locale: result.locale,
    });
  } catch (error) {
    if (isProviderError(error)) {
      const status = error.code === "not-configured" ? 503 : 502;

      console.error(`[api:assistant] provider ${error.code}:`, error.message);

      return fail("upstream-error", error.message, status);
    }

    return failFromUnknown("assistant", error);
  }
}

async function handleGet() {
  return ok(providerStatus());
}

export const POST = CLOUD_ENABLED
  ? authed(async (request) => handlePost(request))
  : handlePost;

export const GET = CLOUD_ENABLED
  ? authed(async () => handleGet())
  : handleGet;
