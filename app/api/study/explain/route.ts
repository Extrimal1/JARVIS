import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  explainStudyDoc,
  validExplainInput,
} from "@/src/lib/api/modules/studyIntel";
import { isProviderError } from "@/src/lib/assistant/llm";
import { dbFromAuth } from "@/src/lib/supabase/db";

/** POST explain: grounded answer scoped to one owned document. */

export const POST = authed(async (request, auth) => {
  try {
    const db = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const input = validExplainInput(await readJson(request));

    if (input === null) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    try {
      const outcome = await explainStudyDoc(db, input);

      if (!outcome.ok) {
        return fail("not-found", outcome.message, outcome.http);
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
  } catch (error) {
    return failFromUnknown("study", error);
  }
});
