import { createId } from "@/src/lib/ids";
import type { AssistantLocale } from "@/src/lib/assistant/actions";

/**
 * Conversation engine data: threads + messages shared by every
 * J.A.R.V.I.S. module (Dashboard, Assistant, Study, Lecture, Finance,
 * Lifestyle, Memory, Daily Briefing).
 *
 * A thread is one reusable conversation (title, language, owning
 * module). Messages keep the exact agent transcript — user turns,
 * assistant envelopes, and tool results in `seq` order — so context
 * survives page reloads and resumes identically in local and cloud
 * mode. No API keys, no secrets, no raw blobs here: tool results
 * are the same summaries the UI could already display.
 */

export const CONVERSATION_THREADS_KEY = "jarvis-conversation-threads";
export const CONVERSATION_MESSAGES_KEY = "jarvis-conversation-messages";
export const CONVERSATION_SCHEMA_VERSION = 1;

export const CONVERSATION_TITLE_MAX = 120;
export const CONVERSATION_CONTENT_MAX = 8000;
export const CONVERSATION_TOOL_NAME_MAX = 64;

export const CONVERSATION_MODULES = [
  "assistant",
  "dashboard",
  "study",
  "lecture",
  "finance",
  "lifestyle",
  "memory",
  "briefing",
] as const;

export type ConversationModule = (typeof CONVERSATION_MODULES)[number];

export const CONVERSATION_ROLES = [
  "user",
  "assistant",
  "tool",
  "system",
] as const;

export type ConversationRole = (typeof CONVERSATION_ROLES)[number];

export type ConversationThread = {
  id: string;
  /** Schema version; must equal CONVERSATION_SCHEMA_VERSION. */
  version: number;
  title: string;
  locale: AssistantLocale;
  module: ConversationModule;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
};

export type ConversationMessage = {
  id: string;
  /** Schema version; must equal CONVERSATION_SCHEMA_VERSION. */
  version: number;
  threadId: string;
  /** Per-thread order; assigned by the conversation service. */
  seq: number;
  role: ConversationRole;
  content: string;
  /** Tool id for tool results, null otherwise. */
  toolName: string | null;
  /** ISO timestamp. */
  createdAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max
  );
}

export function isConversationThread(
  value: unknown,
): value is ConversationThread {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    value.version === CONVERSATION_SCHEMA_VERSION &&
    typeof value.title === "string" &&
    value.title.trim() !== "" &&
    value.title.length <= CONVERSATION_TITLE_MAX &&
    (value.locale === "de" || value.locale === "ru") &&
    typeof value.module === "string" &&
    (CONVERSATION_MODULES as readonly string[]).includes(value.module) &&
    typeof value.createdAt === "string" &&
    value.createdAt !== "" &&
    typeof value.updatedAt === "string" &&
    value.updatedAt !== ""
  );
}

export function isConversationThreadList(
  value: unknown,
): value is ConversationThread[] {
  return Array.isArray(value) && value.every(isConversationThread);
}

export function isConversationMessage(
  value: unknown,
): value is ConversationMessage {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    value.version === CONVERSATION_SCHEMA_VERSION &&
    typeof value.threadId === "string" &&
    value.threadId !== "" &&
    typeof value.seq === "number" &&
    Number.isInteger(value.seq) &&
    value.seq >= 0 &&
    typeof value.role === "string" &&
    (CONVERSATION_ROLES as readonly string[]).includes(value.role) &&
    isNonEmptyString(value.content, CONVERSATION_CONTENT_MAX) &&
    (value.toolName === null ||
      isNonEmptyString(value.toolName, CONVERSATION_TOOL_NAME_MAX)) &&
    typeof value.createdAt === "string" &&
    value.createdAt !== ""
  );
}

export function isConversationMessageList(
  value: unknown,
): value is ConversationMessage[] {
  return Array.isArray(value) && value.every(isConversationMessage);
}

export type NewThreadInput = {
  title: string;
  locale: AssistantLocale;
  module: ConversationModule;
};

export function createThread(
  input: NewThreadInput,
  now: Date = new Date(),
): ConversationThread {
  const at = now.toISOString();
  const title =
    input.title.trim() === "" ? "Unterhaltung" : input.title.trim();

  return {
    id: createId(),
    version: CONVERSATION_SCHEMA_VERSION,
    title: title.slice(0, CONVERSATION_TITLE_MAX),
    locale: input.locale,
    module: input.module,
    createdAt: at,
    updatedAt: at,
  };
}

export type NewMessageInput = {
  threadId: string;
  seq: number;
  role: ConversationRole;
  content: string;
  toolName?: string | null;
};

export function createMessage(
  input: NewMessageInput,
  now: Date = new Date(),
): ConversationMessage {
  return {
    id: createId(),
    version: CONVERSATION_SCHEMA_VERSION,
    threadId: input.threadId,
    seq: input.seq,
    role: input.role,
    content: input.content.slice(0, CONVERSATION_CONTENT_MAX),
    toolName: input.toolName ?? null,
    createdAt: now.toISOString(),
  };
}
