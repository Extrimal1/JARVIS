import { createId } from "@/src/lib/ids";
import { parseISODateLocal } from "@/src/lib/calendar";

/**
 * Personal Memory: user-approved preferences, goals, and notes.
 *
 * Nothing is stored automatically. Derived observations (a future
 * feature) must be approved before they count as memory. Sensitive
 * content is never auto-stored; the UI warns when user-entered text
 * merely looks sensitive (IBAN, password) without blocking the save.
 */

export const MEMORY_STORAGE_KEY = "jarvis-memory";
export const MEMORY_SCHEMA_VERSION = 1;

export const MEMORY_CATEGORIES = [
  "preferences",
  "goals",
  "study",
  "finance",
  "lifestyle",
  "assistant",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preferences: "Vorlieben",
  goals: "Ziele",
  study: "Studium",
  finance: "Finanzen",
  lifestyle: "Freizeit",
  assistant: "Assistent",
};

export type MemoryOrigin = "user" | "derived";

export type MemoryEntry = {
  id: string;
  /** Schema version; must equal MEMORY_SCHEMA_VERSION. */
  version: number;
  category: MemoryCategory;
  title: string;
  content: string;
  origin: MemoryOrigin;
  /** Derived entries count only after explicit approval. */
  approved: boolean;
  pinned: boolean;
  archived: boolean;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Optional local dates (YYYY-MM-DD). */
  reviewAt?: string;
  expiresAt?: string;
  /** Required for derived entries: why the system believes this. */
  evidence?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptionalDate(value: unknown): boolean {
  if (value === undefined || value === "") return true;

  return typeof value === "string" && parseISODateLocal(value) !== null;
}

export function isMemoryEntry(value: unknown): value is MemoryEntry {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    value.version === MEMORY_SCHEMA_VERSION &&
    typeof value.category === "string" &&
    (MEMORY_CATEGORIES as readonly string[]).includes(value.category) &&
    typeof value.title === "string" &&
    value.title.trim() !== "" &&
    typeof value.content === "string" &&
    (value.origin === "user" || value.origin === "derived") &&
    typeof value.approved === "boolean" &&
    typeof value.pinned === "boolean" &&
    typeof value.archived === "boolean" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    isOptionalDate(value.reviewAt) &&
    isOptionalDate(value.expiresAt) &&
    (value.evidence === undefined || typeof value.evidence === "string")
  );
}

export function isMemoryEntryList(value: unknown): value is MemoryEntry[] {
  return Array.isArray(value) && value.every(isMemoryEntry);
}

export type NewMemoryInput = {
  category: MemoryCategory;
  title: string;
  content: string;
  origin: MemoryOrigin;
  reviewAt?: string;
  expiresAt?: string;
  evidence?: string;
};

export function createMemoryEntry(
  input: NewMemoryInput,
  now: Date = new Date(),
): MemoryEntry | null {
  const title = input.title.trim();
  const content = input.content.trim();

  if (title === "" || content === "") return null;
  if (title.length > 120 || content.length > 2000) return null;

  const reviewAt = input.reviewAt?.trim() || undefined;
  const expiresAt = input.expiresAt?.trim() || undefined;

  if (!isOptionalDate(reviewAt) || !isOptionalDate(expiresAt)) return null;
  if (input.origin === "derived" && (input.evidence ?? "").trim() === "") {
    return null;
  }

  const iso = now.toISOString();

  return {
    id: createId(),
    version: MEMORY_SCHEMA_VERSION,
    category: input.category,
    title,
    content,
    origin: input.origin,
    approved: input.origin === "user",
    pinned: false,
    archived: false,
    createdAt: iso,
    updatedAt: iso,
    ...(reviewAt === undefined ? {} : { reviewAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(input.evidence === undefined || input.evidence.trim() === ""
      ? {}
      : { evidence: input.evidence.trim() }),
  };
}

export function isExpired(entry: MemoryEntry, todayISO: string): boolean {
  return entry.expiresAt !== undefined && entry.expiresAt < todayISO;
}

export function needsReview(entry: MemoryEntry, todayISO: string): boolean {
  return (
    entry.reviewAt !== undefined &&
    entry.reviewAt <= todayISO &&
    !isExpired(entry, todayISO)
  );
}

/**
 * Active memory: approved (user entries are, derived need approval),
 * not archived, not expired. Only active entries reach tools/context.
 */
export function isActiveMemory(entry: MemoryEntry, todayISO: string): boolean {
  if (entry.archived) return false;
  if (!entry.approved) return false;
  if (isExpired(entry, todayISO)) return false;

  return true;
}

export function activeMemory(
  entries: MemoryEntry[],
  todayISO: string,
): MemoryEntry[] {
  return entries
    .filter((entry) => isActiveMemory(entry, todayISO))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

      return b.updatedAt.localeCompare(a.updatedAt);
    });
}

/**
 * Where an entry is actually used, computed — never stored.
 * Pinned active entries surface in the Daily Briefing ("Gemerkt");
 * assistant-category entries are reserved for the future assistant.
 */
export function usageOf(entry: MemoryEntry, todayISO: string): string[] {
  const usage: string[] = [];

  if (entry.pinned && isActiveMemory(entry, todayISO)) {
    usage.push("Tagesbriefing");
  }

  if (entry.category === "assistant" && isActiveMemory(entry, todayISO)) {
    usage.push("Assistent (vorgemerkt)");
  }

  return usage;
}

const SENSITIVE_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bDE\d{20}\b/, label: "IBAN" },
  { pattern: /passwort\s*[:=]/i, label: "Passwort" },
  { pattern: /\b\d{10,}\b/, label: "lange Zahlenfolge" },
];

/**
 * Non-blocking hint when text merely looks sensitive. Returns the
 * matched labels; empty means nothing suspicious was found.
 */
export function detectSensitiveHint(text: string): string[] {
  const found: string[] = [];

  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    if (pattern.test(text) && !found.includes(label)) {
      found.push(label);
    }
  }

  return found;
}
