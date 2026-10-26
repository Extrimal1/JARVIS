import {
  isMemoryEntry,
  isMemoryEntryList,
  type MemoryEntry,
} from "@/src/lib/memory";
import {
  pickPatch,
  requireId,
  type CheckResult,
  type CrudConfig,
} from "../crud";

function toDomain(row: Record<string, unknown>): unknown {
  const item: Record<string, unknown> = {
    id: row.id,
    version: row.version ?? 1,
    category: row.category,
    title: row.title,
    content: row.content ?? "",
    origin: row.origin ?? "user",
    approved: row.approved ?? true,
    pinned: row.pinned ?? false,
    archived: row.archived ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

  if (typeof row.review_at === "string") item.reviewAt = row.review_at;
  if (typeof row.expires_at === "string") item.expiresAt = row.expires_at;
  if (typeof row.evidence === "string" && row.evidence !== "") {
    item.evidence = row.evidence;
  }

  return item;
}

function toRow(item: MemoryEntry): Record<string, unknown> {
  return {
    id: item.id,
    version: item.version,
    category: item.category,
    title: item.title,
    content: item.content,
    origin: item.origin,
    approved: item.approved,
    pinned: item.pinned,
    archived: item.archived,
    review_at: item.reviewAt ?? null,
    expires_at: item.expiresAt ?? null,
    evidence: item.evidence ?? "",
  };
}

const MEMORY_KEYS = [
  "category",
  "title",
  "content",
  "origin",
  "approved",
  "pinned",
  "archived",
  "reviewAt",
  "expiresAt",
  "evidence",
] as const;

export const memoryConfig: CrudConfig = {
  table: "memory_entries",
  order: "updated_at.desc",
  toDomain,
  isList: isMemoryEntryList,
  checkCreate: (_db, body) => {
    if (!isMemoryEntry(body) || requireId(body) === null) {
      return { message: "Ungültige Erinnerung." };
    }

    if (body.origin === "derived" && (body.evidence ?? "") === "") {
      return { message: "Abgeleitete Einträge brauchen eine Begründung." };
    }

    return { row: toRow(body) };
  },
  checkUpdate: (_db, patch, existing): CheckResult => {
    const picked = pickPatch(patch, MEMORY_KEYS);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isMemoryEntry(merged)) {
      return { message: "Ungültige Änderung." };
    }

    const item = merged as unknown as MemoryEntry;

    if (item.origin === "derived" && (item.evidence ?? "") === "") {
      return { message: "Abgeleitete Einträge brauchen eine Begründung." };
    }

    const row = toRow(item);
    delete row.id;

    return { row };
  },
};
