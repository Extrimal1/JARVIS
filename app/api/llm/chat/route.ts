import type { NextRequest } from "next/server";
import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  chatWithOllama,
  isLlmChatRouteRequest,
  isProviderError,
} from "@/src/lib/assistant/llm";
import { CLOUD_ENABLED } from "@/src/lib/db/mode";

/**
 * POST /api/llm/chat — the reusable inference endpoint every module
 * uses (via the agent loop, never directly from UI event handlers).
 *
 * Request: `{ messages: [{ role, content }], options? }` (validated;
 * the client may tune sampling and budgets but never the model or
 * base URL). Response: `{ content, model }`. This endpoint NEVER
 * touches user data: no database, no storage, no user id — it only
 * runs inference. Tool execution happens client-side in the agent
 * loop through the existing authorized stores.
 *
 * Auth mirrors the app mode: required in cloud mode (same session
 * cookies as every other route), open in local mode where no login
 * exists. Either way the payload carries no user identity.
 */

async function handlePost(request: NextRequest) {
  const body = await readJson(request);

  if (!isLlmChatRouteRequest(body)) {
    return fail("bad-request", "Ungültige Anfrage.", 400);
  }

  try {
    const result = await chatWithOllama(body.messages, body.options ?? {});

    // Opt-in local diagnosis for structured generations only:
    // generated output, capped, never prompts or user data.
    if (
      process.env.STUDY_DEBUG_RAW === "1" &&
      body.options?.format === "json"
    ) {
      console.log(
        `[api:llm] DEBUG raw json response (${result.content.length} chars): ${result.content.slice(0, 1000)}`,
      );
    }

    // Opt-in inference diagnostics: metadata only (model, finish
    // reason, token count, sizes) — never prompts, never content.
    if (process.env.LLM_DEBUG === "1") {
      console.log(
        `[api:llm] chat model=${result.model} done=${result.doneReason ?? "?"} eval=${result.evalCount ?? "?"} outChars=${result.content.length} msgs=${body.messages.length}`,
      );
    }

    return ok({
      content: result.content,
      model: result.model,
      doneReason: result.doneReason,
      evalCount: result.evalCount,
      thinkingChars: result.thinkingChars,
    });
  } catch (error) {
    if (isProviderError(error)) {
      if (error.code === "cancelled") {
        return fail("bad-request", error.message, 400);
      }

      const status = error.code === "not-configured" ? 503 : 502;

      console.error(`[api:llm] provider ${error.code}:`, error.message);

      return fail("upstream-error", error.message, status);
    }

    return failFromUnknown("llm", error);
  }
}

export const POST = CLOUD_ENABLED
  ? authed(async (request) => handlePost(request))
  : handlePost;
