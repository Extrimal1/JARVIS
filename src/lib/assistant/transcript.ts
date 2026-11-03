import {
  extractJsonPayload,
  type ClarifyOption,
} from "./actions";
import { isAgentLoopPrompt } from "./agent";
import { getToolDefinition } from "./registry";
import type { ConversationMessage } from "@/src/lib/conversation";

/**
 * Transcript view-model: turns persisted conversation messages into
 * renderable turns. Pure and total — invalid envelopes are skipped,
 * never rendered as data, so the UI can never present fabricated
 * content as retrieved results.
 *
 * - user messages open a turn;
 * - assistant `{"final"}` envelopes become the answer (plus optional
 *   clarify options from the heuristic adapter);
 * - assistant `{"tool"}` envelopes become activity steps, resolved
 *   to ok/failed when the matching tool result arrives;
 * - loop repair prompts and system notes are model-facing only and
 *   never displayed.
 */

export type ViewStep = {
  tool: string;
  /** Registry title, or the raw id when unknown. */
  label: string;
  /** Null while the result is still missing (live turns). */
  ok: boolean | null;
  /**
   * Tool error message for failed steps (what failed and why), so a
   * red ✗ is never unexplained. Null for successes and pending steps.
   */
  detail: string | null;
};

export type ViewTurn =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      answer: string;
      steps: ViewStep[];
      clarify: ClarifyOption[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(extractJsonPayload(raw)) as unknown;

    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseClarifyOptions(value: unknown): ClarifyOption[] {
  if (!isRecord(value)) return [];

  const options = value.options;

  if (!Array.isArray(options)) return [];

  return options
    .filter(
      (option): option is ClarifyOption =>
        isRecord(option) &&
        typeof option.label === "string" &&
        option.label !== "" &&
        typeof option.text === "string" &&
        option.text !== "",
    )
    .slice(0, 4);
}

function parseToolResult(raw: string): {
  ok: boolean | null;
  detail: string | null;
} {
  const parsed = parseEnvelope(raw);

  if (parsed === null || typeof parsed.ok !== "boolean") {
    return { ok: null, detail: null };
  }

  if (parsed.ok) return { ok: true, detail: null };

  const error = parsed.error;
  const detail =
    typeof error === "string"
      ? error
      : isRecord(error) && typeof error.message === "string"
        ? error.message
        : typeof parsed.gekürzt === "string"
          ? parsed.gekürzt
          : "Unbekannter Fehler.";

  return { ok: false, detail };
}

export function transcriptToTurns(
  messages: ConversationMessage[],
): ViewTurn[] {
  const ordered = [...messages].sort(
    (a, b) =>
      a.seq - b.seq ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0),
  );
  const turns: ViewTurn[] = [];
  let current: Extract<ViewTurn, { kind: "assistant" }> | null = null;

  function flush(): void {
    if (current !== null) {
      turns.push(current);
      current = null;
    }
  }

  for (const message of ordered) {
    if (message.role === "user") {
      if (isAgentLoopPrompt(message.content)) continue;

      flush();
      turns.push({ kind: "user", id: message.id, text: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const envelope = parseEnvelope(message.content);

      if (envelope === null) continue;

      if (typeof envelope.tool === "string") {
        if (current === null) {
          current = {
            kind: "assistant",
            id: message.id,
            answer: "",
            steps: [],
            clarify: [],
          };
        }

        const definition = getToolDefinition(envelope.tool);

        current.steps.push({
          tool: envelope.tool,
          label: definition?.title ?? envelope.tool,
          ok: null,
          detail: null,
        });

        continue;
      }

      if (
        typeof envelope.final === "string" &&
        envelope.final.trim() !== "" &&
        envelope.tool === undefined
      ) {
        if (current === null) {
          current = {
            kind: "assistant",
            id: message.id,
            answer: "",
            steps: [],
            clarify: [],
          };
        }

        current.id = message.id;
        current.answer = envelope.final.trim();
        current.clarify = parseClarifyOptions(envelope.clarify);

        continue;
      }

      continue;
    }

    if (message.role === "tool" && current !== null) {
      const pending = [...current.steps].reverse().find((step) => step.ok === null);

      if (pending !== undefined) {
        const result = parseToolResult(message.content);
        pending.ok = result.ok;
        pending.detail = result.detail;
      }
    }
  }

  flush();

  return turns;
}

/** Deep link for a turn's data, derived from executed tools only. */
export function turnHref(
  steps: ViewStep[],
):
  | "/calendar"
  | "/finance"
  | "/study"
  | "/memory"
  | "/lecture"
  | "/lifestyle"
  | "/#aufgaben"
  | undefined {
  if (steps.some((step) => step.tool === "study.retrieve" || step.tool === "study.documents")) {
    return "/study";
  }

  if (steps.some((step) => step.tool.startsWith("calendar."))) {
    return "/calendar";
  }

  if (steps.some((step) => step.tool.startsWith("finance."))) {
    return "/finance";
  }

  if (steps.some((step) => step.tool === "memory.create")) {
    return "/memory";
  }

  if (steps.some((step) => step.tool.startsWith("lecture."))) {
    return "/lecture";
  }

  if (steps.some((step) => step.tool.startsWith("lifestyle."))) {
    return "/lifestyle";
  }

  if (steps.some((step) => step.tool === "tasks.create")) {
    return "/#aufgaben";
  }

  return undefined;
}
