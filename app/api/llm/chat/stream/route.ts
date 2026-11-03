import { NextResponse, type NextRequest } from "next/server";
import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, readJson } from "@/src/lib/api/respond";
import {
  chatStreamWithOllama,
  isLlmChatRouteRequest,
  isProviderError,
} from "@/src/lib/assistant/llm";
import { CLOUD_ENABLED } from "@/src/lib/db/mode";

/**
 * POST /api/llm/chat/stream — streaming inference as SSE.
 *
 * Same validated request as /api/llm/chat (`{ messages, options? }`;
 * the client never sets model or base URL). Events:
 * `data: {"token":"…"}` per content delta, then
 * `data: {"done":true,"model":"…","doneReason":"…","evalCount":…}`.
 * Failures before the first byte return the usual JSON error (same
 * codes as /api/llm/chat); mid-stream failures emit
 * `data: {"error":"…"}` and close the stream.
 *
 * Like /api/llm/chat this endpoint NEVER touches user data — only
 * inference. Aborting the request cancels the Ollama read.
 *
 * Auth mirrors the app mode: required in cloud mode (same session
 * cookies as every other route), open in local mode where no login
 * exists. Either way the payload carries no user identity.
 */

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function handlePost(request: NextRequest) {
  const body = await readJson(request);

  if (!isLlmChatRouteRequest(body)) {
    return fail("bad-request", "Ungültige Anfrage.", 400);
  }

  const options = body.options ?? {};
  const encoder = new TextEncoder();
  const abort = request.signal;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown): void => {
        controller.enqueue(encoder.encode(sse(payload)));
      };

      try {
        const result = await chatStreamWithOllama(body.messages, {
          ...options,
          signal: abort,
          onToken: (delta) => send({ token: delta }),
        });

        // Opt-in diagnostics: metadata only, never prompts/content.
        if (process.env.LLM_DEBUG === "1") {
          console.log(
            `[api:llm:stream] done model=${result.model} doneReason=${result.doneReason ?? "?"} eval=${result.evalCount ?? "?"} outChars=${result.content.length} msgs=${body.messages.length}`,
          );
        }

        send({
          done: true,
          model: result.model,
          doneReason: result.doneReason,
          evalCount: result.evalCount,
        });
        controller.close();
      } catch (error: unknown) {
        if (isProviderError(error)) {
          if (error.code !== "cancelled") {
            console.error(`[api:llm:stream] provider ${error.code}:`, error.message);
          }

          send({ error: error.message });
        } else {
          console.error("[api:llm:stream] unexpected:", error);
          send({ error: "Unbekannter Fehler." });
        }

        controller.close();
      }
    },
    cancel() {
      // Client disconnected; the request signal aborts the Ollama read.
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function guardedPost(request: NextRequest) {
  try {
    return await handlePost(request);
  } catch (error) {
    return failFromUnknown("llm-stream", error);
  }
}

export const POST = CLOUD_ENABLED
  ? authed(async (request) => guardedPost(request))
  : guardedPost;

// NOTE: no `export const dynamic` — POST-only routes are always
// dynamic, and the export is incompatible with `cacheComponents`.
