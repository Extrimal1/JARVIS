import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  generationLockKey,
  releaseGenerationLock,
  summarizeNextSpan,
  tryAcquireGenerationLock,
  validSummaryBatchInput,
} from "@/src/lib/api/modules/studyIntel";
import { isProviderError } from "@/src/lib/assistant/llm";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** POST summarize/batch: next persisted span of a summary draft. */

export const POST = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const input = validSummaryBatchInput(await readJson(request));

    if (input === null) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    const lockKey = generationLockKey(
      `summary:${auth.userId}`,
      input.documentId,
    );

    if (!tryAcquireGenerationLock(lockKey)) {
      return fail(
        "conflict",
        "Für dieses Dokument läuft bereits eine Zusammenfassung.",
        409,
      );
    }

    try {
      try {
        const outcome = await summarizeNextSpan(db, input);

        if (!outcome.ok) {
          return fail(
            outcome.http === 404 ? "not-found" : "conflict",
            outcome.message,
            outcome.http,
          );
        }

        return ok(outcome.response);
      } catch (error) {
        if (isProviderError(error)) {
          const status = error.code === "not-configured" ? 503 : 502;

          console.error(`[api:study] provider ${error.code}:`, error.message);

          return fail("upstream-error", error.message, status);
        }

        throw error;
      }
    } finally {
      releaseGenerationLock(lockKey);
    }
  } catch (error) {
    return failFromUnknown("study", error);
  }
});
