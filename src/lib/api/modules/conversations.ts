import {
  isConversationMessage,
  isConversationMessageList,
  isConversationThread,
  isConversationThreadList,
  type ConversationMessage,
  type ConversationThread,
} from "@/src/lib/conversation";
import { dbGetOne, type DbClient } from "@/src/lib/supabase/db";
import {
  pickPatch,
  requireUuidId,
  type CheckResult,
  type CrudConfig,
} from "../crud";

// ------------------------------------------------------------------ threads

function threadToDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    version: row.version ?? 1,
    title: row.title,
    locale: row.locale,
    module: row.module,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function threadToRow(item: ConversationThread): Record<string, unknown> {
  return {
    id: item.id,
    version: item.version,
    title: item.title,
    locale: item.locale,
    module: item.module,
  };
}

export const conversationThreadsConfig: CrudConfig = {
  table: "conversation_threads",
  order: "updated_at.desc",
  toDomain: threadToDomain,
  isList: isConversationThreadList,
  checkCreate: (_db, body) => {
    if (!isConversationThread(body) || requireUuidId(body) === null) {
      return { message: "Ungültige Konversation." };
    }

    return { row: threadToRow(body) };
  },
  checkUpdate: (_db, patch, existing): CheckResult => {
    const picked = pickPatch(patch, ["title", "updatedAt"]);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    // updatedAt travels through the patch so local and cloud order
    // threads identically; Postgres still stamps its own value.
    delete picked.updatedAt;

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isConversationThread(merged)) {
      return { message: "Ungültige Änderung." };
    }

    const item = merged as unknown as ConversationThread;

    return { row: { title: item.title } };
  },
};

// ----------------------------------------------------------------- messages

function messageToDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    version: row.version ?? 1,
    threadId: row.thread_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    toolName: row.tool_name ?? null,
    createdAt: row.created_at,
  };
}

function messageToRow(item: ConversationMessage): Record<string, unknown> {
  return {
    id: item.id,
    version: item.version,
    thread_id: item.threadId,
    seq: item.seq,
    role: item.role,
    content: item.content,
    tool_name: item.toolName,
  };
}

export const conversationMessagesConfig: CrudConfig = {
  table: "conversation_messages",
  order: "created_at.desc",
  toDomain: messageToDomain,
  isList: isConversationMessageList,
  checkCreate: async (db: DbClient, body) => {
    if (!isConversationMessage(body) || requireUuidId(body) === null) {
      return { message: "Ungültige Nachricht." };
    }

    // Defense in depth: RLS scopes the message row to the user, but
    // the thread reference must ALSO be owned — otherwise a message
    // could attach to a foreign thread. Missing-or-foreign threads
    // uniformly surface as missing (no leaks).
    const thread = await dbGetOne<Record<string, unknown>>(
      db,
      "conversation_threads",
      body.threadId,
    );

    if (thread === null) {
      return { message: "Unbekannte Konversation." };
    }

    return { row: messageToRow(body) };
  },
  checkUpdate: () => ({ message: "Nachrichten sind unveränderlich." }),
};
