import { authed } from "@/src/lib/api/withAuth";
import { ok } from "@/src/lib/api/respond";
import {
  checkOllamaModel,
  contextBudgetChars,
} from "@/src/lib/assistant/llm";
import { providerStatus } from "@/src/lib/assistant/providers";
import { CLOUD_ENABLED } from "@/src/lib/db/mode";

/**
 * GET /api/llm — honest engine status for the central LLM service:
 * provider id, configured flag, live model availability, and the
 * history budget in characters (derived from OLLAMA_NUM_CTX).
 * Secret-free: no URLs, no keys, no model internals.
 *
 * Auth mirrors the app mode, like every other route.
 */

async function handleGet() {
  const status = providerStatus();
  const model = await checkOllamaModel();

  return ok({
    provider: status.provider,
    configured: status.configured,
    available: model.available,
    contextChars: contextBudgetChars(),
  });
}

export const GET = CLOUD_ENABLED ? authed(async () => handleGet()) : handleGet;
