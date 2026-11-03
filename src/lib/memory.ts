import { createId } from "@/src/lib/ids";
import { parseISODateLocal } from "@/src/lib/calendar";

/**
 * Personal Memory: user-approved preferences, goals, and notes.
 *
 * Nothing is stored automatically. Derived observations (a future
 * feature) must be approved before they count as memory. Concrete
 * secrets (passwords, API keys, private keys, tokens) are NEVER
 * stored: `createMemoryEntry` refuses them and the API validates
 * again server-side. Merely sensitive-looking text (IBAN, long digit
 * runs) only triggers a non-blocking UI warning.
 */

export const MEMORY_STORAGE_KEY = "jarvis-memory";
export const MEMORY_SCHEMA_VERSION = 1;
/**
 * Local kill-switch: "1" (default) = the assistant may use approved
 * memory; "0" = memory stays stored but is invisible to the assistant
 * and the dashboard. Conversation context (this chat) is always
 * temporary and never lands in memory without explicit approval.
 */
export const MEMORY_ENABLED_KEY = "jarvis-memory-enabled";

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
  // Secrets are never stored, no matter the origin or approval state.
  if (detectSecretBlock(`${title}\n${content}`).length > 0) return null;

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

/**
 * Hard secret detection: high-precision patterns that BLOCK a save
 * (page, assistant, and API all refuse). Only concrete credential
 * material matches — merely mentioning "Passwort" or planning to
 * "set up a password manager" never blocks.
 */
const SECRET_BLOCK_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    pattern: /(passwort|password|passwd|pwd)\s*[:=]\s*\S+/i,
    label: "Passwort",
  },
  {
    pattern:
      /(api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*\S+/i,
    label: "API-Schlüssel",
  },
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
    label: "Privater Schlüssel",
  },
  {
    pattern:
      /\b(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|xox[bpas]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{8,})\b/,
    label: "Token",
  },
];

/**
 * Blocking check for concrete secrets. Returns the matched labels;
 * empty means the text may be stored (soft hints still apply).
 */
export function detectSecretBlock(text: string): string[] {
  const found: string[] = [];

  for (const { pattern, label } of SECRET_BLOCK_PATTERNS) {
    pattern.lastIndex = 0;

    if (pattern.test(text) && !found.includes(label)) {
      found.push(label);
    }
  }

  return found;
}

/**
 * Parse the memory kill-switch. Anything but "0" means enabled, so a
 * missing key (fresh profile) defaults to enabled. Pure: the caller
 * passes the stored value.
 */
export function parseMemoryEnabled(stored: string | null): boolean {
  return stored !== "0";
}

/**
 * Read the kill-switch in the browser. Server-side (no window) always
 * returns true — disabling is a local UI control, never a way to hide
 * stored data from its owner.
 */
export function isMemoryEnabledClient(): boolean {
  if (typeof window === "undefined") return true;

  try {
    return parseMemoryEnabled(window.localStorage.getItem(MEMORY_ENABLED_KEY));
  } catch {
    return true;
  }
}

/**
 * Entries visible to the assistant + dashboard: only when enabled, and
 * only the active (approved, unexpired, unarchived) subset.
 */
export function visibleMemory(
  entries: MemoryEntry[],
  todayISO: string,
  enabled: boolean,
): MemoryEntry[] {
  if (!enabled) return [];

  return activeMemory(entries, todayISO);
}
