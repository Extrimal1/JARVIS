import {
  createMessage,
  createThread,
  type ConversationMessage,
  type ConversationModule,
  type ConversationThread,
} from "@/src/lib/conversation";
import type { ListResource } from "@/src/lib/db/useRemoteResource";
import type { AssistantLocale } from "./actions";
import {
  runAgent,
  type AgentChat,
  type AgentData,
  type AgentMessage,
  type AgentOutcome,
  type AgentStores,
  type AsyncReadTool,
} from "./agent";
import type { ToolPermission } from "./registry";

/**
 * Shared conversation engine: persistent, resumable turns for every
 * J.A.R.V.I.S. module. Dashboard, Assistant, Study, Lecture, Finance,
 * Lifestyle, Memory, and Daily Briefing all run turns through
 * `sendConversationTurn` — no duplicate chat implementations, no
 * second AI provider.
 *
 * One turn: resolve (or create) the thread, load its recent messages,
 * truncate history to the context budget, run the agent loop with
 * that history, then persist the exact new transcript (user turn,
 * assistant envelopes, tool results — in `seq` order) so the next
 * turn, a page reload, or another device resumes identically.
 *
 * Client-safe and storage-agnostic: persistence arrives as the same
 * list resources the module hooks return (localStorage XOR cloud
 * API), inference as an `AgentChat`. Tool execution keeps every
 * Phase 1 guarantee (validation, bounds, duplicate protection,
 * confirmations surface to the caller, never auto-confirmed).
 */

export type ThreadResource = Pick<
  ListResource<ConversationThread>,
  "items" | "create" | "update" | "remove" | "loading"
>;

export type MessageResource = Pick<
  ListResource<ConversationMessage>,
  "items" | "create" | "remove" | "loading"
>;

export const HISTORY_DEFAULT_MAX_MESSAGES = 20;

/**
 * Fallback history budget when the caller has no fresher value.
 * Matches `contextBudgetChars()` for the Ollama default 4096-token
 * window; callers that fetched GET /api/llm pass `contextChars`.
 */
export const HISTORY_DEFAULT_MAX_CHARS = 6144;

export const HISTORY_TRUNCATION_NOTE =
  "Ältere Nachrichten wurden aus Platzgründen gekürzt; antworte auf Grundlage des Verlaufs unten.";

export type HistoryBudget = {
  maxMessages?: number;
  maxChars?: number;
};

/** Thread messages in transcript order (seq, then creation order). */
export function threadMessages(
  items: ConversationMessage[],
  threadId: string,
): ConversationMessage[] {
  return items
    .filter((message) => message.threadId === threadId)
    .sort(
      (a, b) =>
        a.seq - b.seq ||
        (a.createdAt < b.createdAt
          ? -1
          : a.createdAt > b.createdAt
            ? 1
            : a.id < b.id
              ? -1
              : 1),
    );
}

export type ConversationHistory = {
  history: AgentMessage[];
  /** True when older messages were cut to fit the budget. */
  truncated: boolean;
};

/**
 * Build the agent history from persisted messages: newest turns
 * first until the message or character budget trips. The newest
 * message always survives (a turn needs its own context); when
 * anything was cut, a short system note leads the history.
 */
export function buildConversationHistory(
  messages: ConversationMessage[],
  budget: HistoryBudget = {},
): ConversationHistory {
  const maxMessages = budget.maxMessages ?? HISTORY_DEFAULT_MAX_MESSAGES;
  const maxChars = budget.maxChars ?? HISTORY_DEFAULT_MAX_CHARS;
  const ordered = [...messages].sort(
    (a, b) =>
      a.seq - b.seq ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0),
  );
  const picked: ConversationMessage[] = [];
  let chars = 0;

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const message = ordered[index];

    if (picked.length > 0) {
      if (picked.length >= maxMessages) break;
      if (chars + message.content.length > maxChars) break;
    }

    picked.unshift(message);
    chars += message.content.length;
  }

  const truncated = picked.length < ordered.length;
  const history: AgentMessage[] = picked.map((message) => ({
    role: message.role,
    content: message.content,
  }));

  if (truncated) {
    history.unshift({ role: "system", content: HISTORY_TRUNCATION_NOTE });
  }

  return { history, truncated };
}

// ------------------------------------------------------------------- turns

export type ConversationTurn = {
  /** Null starts a new thread (titled from the first message). */
  threadId: string | null;
  text: string;
  locale: AssistantLocale;
  /** Owning module for new threads, default "assistant". */
  module?: ConversationModule;
  chat: AgentChat;
  data: AgentData;
  stores: AgentStores;
  threads: ThreadResource;
  messages: MessageResource;
  history?: HistoryBudget;
  agent?: {
    maxSteps?: number;
    timeBudgetMs?: number;
    granted?: ToolPermission[];
    signal?: AbortSignal;
    challengeBareFinals?: boolean;
    bareFinalChars?: number;
    asyncReads?: Record<string, AsyncReadTool>;
  };
  /** Test seam for deterministic timestamps. */
  now?: Date;
};

export type ConversationTurnResult = {
  /** Null only when even the thread could not be persisted. */
  thread: ConversationThread | null;
  outcome: AgentOutcome;
};

/** Best-effort tool id from an assistant envelope (metadata only). */
function toolIdOf(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw) as unknown;

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { tool?: unknown }).tool === "string"
    ) {
      return (parsed as { tool: string }).tool;
    }
  } catch {
    // Not an envelope — no metadata, never a failure.
  }

  return null;
}

function persistFailed(locale: AssistantLocale, reason: string): AgentOutcome {
  return {
    status: "error",
    message:
      locale === "ru"
        ? `Ответ не сохранён в истории: ${reason}`
        : `Antwort konnte nicht im Verlauf gespeichert werden: ${reason}`,
  };
}

/**
 * Run one persistent turn. The user message is always stored; the
 * agent transcript (assistant envelopes + tool results) is stored
 * for answered, confirming, and disambiguating turns. Failed turns
 * store only the user message, so a retry resumes cleanly.
 *
 * Callers serialize turns per thread (like the assistant busy flag);
 * concurrent turns in one thread may interleave `seq`.
 */
export async function sendConversationTurn(
  turn: ConversationTurn,
): Promise<ConversationTurnResult> {
  const text = turn.text.trim();

  if (text === "") {
    throw new Error("sendConversationTurn: text must not be empty.");
  }

  const now = turn.now ?? new Date();
  let thread: ConversationThread | null =
    turn.threadId === null
      ? null
      : (turn.threads.items.find((item) => item.id === turn.threadId) ?? null);

  if (turn.threadId !== null && thread === null) {
    throw new Error("sendConversationTurn: unknown thread id.");
  }

  if (thread === null) {
    const created = await turn.threads.create(
      createThread(
        {
          title: text.slice(0, 120),
          locale: turn.locale,
          module: turn.module ?? "assistant",
        },
        now,
      ),
    );

    if (!created.ok) {
      return {
        thread: null,
        outcome: persistFailed(turn.locale, created.error),
      };
    }

    thread = created.data;
  }

  const existing = threadMessages(turn.messages.items, thread.id);
  const { history } = buildConversationHistory(existing, turn.history);

  let latest: AgentMessage[] = [];
  const recordingChat: AgentChat = async (messages) => {
    latest = messages;

    return turn.chat(messages);
  };

  const outcome = await runAgent(text, {
    chat: recordingChat,
    data: turn.data,
    stores: turn.stores,
    locale: turn.locale,
    history,
    ...(turn.agent ?? {}),
  });

  // The agent saw [system, ...history, user, ...turn]. Everything
  // past the echoed prefix is the new transcript, in order.
  const fresh = latest.slice(1 + history.length);

  // Failed turns keep only the user message (assistant attempts are
  // repair noise, not history); every other outcome keeps the exact
  // transcript, including the tool call behind a confirmation.
  const keep =
    outcome.status === "error" ? fresh.slice(0, 1) : fresh;

  for (let index = 0; index < keep.length; index += 1) {
    const message = keep[index];
    const previous = index === 0 ? null : keep[index - 1];
    const saved = await turn.messages.create(
      createMessage(
        {
          threadId: thread.id,
          seq: existing.length + index,
          role: message.role,
          content: message.content,
          toolName:
            message.role === "tool" && previous?.role === "assistant"
              ? toolIdOf(previous.content)
              : null,
        },
        now,
      ),
    );

    if (!saved.ok) {
      return { thread, outcome: persistFailed(turn.locale, saved.error) };
    }
  }

  // Best-effort activity bump (thread ordering is cosmetic; the
  // transcript above is the guarantee). Local and cloud order
  // identically: the patch carries the stamp, Postgres re-stamps.
  try {
    await turn.threads.update(thread.id, { updatedAt: now.toISOString() });
  } catch {
    // Bump failures never fail the turn (see comment above).
  }

  const refreshed =
    turn.threads.items.find((item) => item.id === thread.id) ?? thread;

  return { thread: refreshed, outcome };
}
