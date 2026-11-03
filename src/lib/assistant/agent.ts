import { createId } from "@/src/lib/ids";
import type { CalendarEvent } from "@/src/lib/calendar";
import type { FinanceData } from "@/src/lib/finance";
import type { StudyData } from "@/src/lib/study";
import type { Task } from "@/src/lib/tasks";
import type {
  LifestylePreferences,
  OutingPlan,
  Place,
} from "@/src/lib/lifestyle/types";
import type { MemoryEntry } from "@/src/lib/memory";
import type {
  LectureSession,
  LocalRecording,
} from "@/src/lib/lecture/types";
import {
  extractJsonPayload,
  isAssistantPlan,
  type AssistantLocale,
} from "./actions";
import {
  executePlan,
  type ActionPlan,
  type CandidateOption,
  type ExecutorDeps,
  type PendingAction,
  type UndoAction,
} from "./executor";
import {
  ASSISTANT_TOOLS,
  getToolDefinition,
  mayInvoke,
  type ToolPermission,
} from "./registry";
import {
  getApprovedMemory,
  getBriefingToday,
  getCalendarList,
  getExamsNeedingAttention,
  getFinanceList,
  getFinanceMonthSummary,
  getFinanceSummary,
  getLargestTransactions,
  getLectureOverview,
  getLifestylePreferences,
  getOpenTasks,
  getSavedPlaces,
  getStudyDeadlines,
  getStudyProgress,
  getTodayEvents,
  getUpcomingEvents,
  getUpcomingPlans,
  type StudyRetrieval,
  type ToolResult,
} from "./tools";
import {
  citationRepairPrompt,
  findCitations,
  strippedCitationNote,
  stripInvalidCitations,
  validateCitations,
  type CitationSource,
} from "../study/grounding";
import { retrievalInstruction } from "../study/prompts";

/**
 * Bounded tool-calling loop: the client-side half of the central
 * intelligence engine. The LLM proposes, this loop disposes —
 * read tools run against the caller's loaded stores, write tools
 * become validated `AssistantPlan`s executed by the existing
 * executor (confirmations, undo, idempotency included).
 *
 * Client-safe and transport-agnostic: inference arrives through an
 * injected `chat` function (production: POST /api/llm/chat), so
 * this module never touches the network or server env. The model
 * speaks one strict envelope — `{"final": "..."}` or
 * `{"tool": "<id>", "args": {...}}` — anything else is answered
 * with a correction, then aborted honestly.
 *
 * Bounds: max steps, wall-clock budget, consecutive-mistake abort,
 * per-result truncation, and write fingerprints (a repeated write
 * is never executed twice).
 */

export type AgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

/** Inference transport: history in, raw assistant content out. */
export type AgentChat = (messages: AgentMessage[]) => Promise<string>;

/**
 * Server/IDB-backed read tool: the caller fetches owned data (API or
 * local store) and returns a `ToolResult`. Must never throw for
 * domain failures (return `{ok:false}` instead); throws only for
 * aborts, which the loop converts to cancellation.
 */
export type AsyncReadTool = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<ToolResult<unknown>>;

/** Module data the caller already loaded (stores, context snapshot). */
export type AgentData = {
  events: CalendarEvent[];
  finance: FinanceData;
  tasks: Task[];
  study: StudyData;
  places: Place[];
  savedIds: string[];
  plans: OutingPlan[];
  prefs: LifestylePreferences;
  memory: MemoryEntry[];
  /** Lecture library (IndexedDB); absent = tool reports invalid input. */
  sessions?: LectureSession[];
  recordings?: LocalRecording[];
  todayISO: string;
  nowTime: string;
};

export type AgentStores = Pick<
  ExecutorDeps,
  "calendar" | "transactions" | "memories" | "tasks"
>;

export type AgentOptions = {
  chat: AgentChat;
  data: AgentData;
  stores: AgentStores;
  locale: AssistantLocale;
  /** Prior turns (oldest first); capped to keep context bounded. */
  history?: AgentMessage[];
  /** Default ["read", "write"] (writes stay executor-guarded). */
  granted?: ToolPermission[];
  /** LLM round-trips, default 6 (clamped 1–12). */
  maxSteps?: number;
  /** Wall-clock budget, default 180 s (clamped 5–600 s). */
  timeBudgetMs?: number;
  /** Cooperative cancellation, checked between steps. */
  signal?: AbortSignal;
  /**
   * Challenge long finals that used no tools (default true): a small
   * model may skip required tools and invent facts, so the first bare
   * final above `bareFinalChars` gets one "call a tool or repeat"
   * round within the step budget. Short replies (greetings) pass.
   */
  challengeBareFinals?: boolean;
  /** Length that marks a bare final as suspicious, default 200. */
  bareFinalChars?: number;
  /**
   * Async read tools by id (study.retrieve, study.documents). The
   * loop consults these before the sync `runReadTool`; a tool id
   * missing here and there fails as unknown, never silently.
   */
  asyncReads?: Record<string, AsyncReadTool>;
};

export type AgentStep = {
  tool: string;
  ok: boolean;
  summary: string;
};

export type AgentWriteUndo = {
  tool: string;
  undo: UndoAction;
};

/**
 * Machine-readable failure cause for `AgentOutcome` errors (ISSUE 5:
 * error visibility). The UI shows what failed (message), why (cause
 * label), and whether retrying can help (`retryable`).
 *
 * - ollama: the model server failed (unreachable, 5xx, bad payload)
 * - supabase: cloud persistence/backend failed
 * - provider: the engine is misconfigured (model missing, bad env)
 * - format: the request itself was rejected (validation, limits)
 * - network: the browser never reached the server
 * - auth: the session expired (re-login, not retry)
 * - budget: the turn exceeded its step/time budget
 * - model: the model broke the envelope protocol twice
 * - persist: the turn ran but history could not be stored
 * - aborted: the user cancelled the turn
 * - unknown: anything else (custom transports, unexpected throws)
 */
export type AgentErrorCause =
  | "ollama"
  | "supabase"
  | "provider"
  | "format"
  | "network"
  | "auth"
  | "budget"
  | "model"
  | "persist"
  | "aborted"
  | "unknown";

/** Transport failure with a classified cause + retry hint. */
export class AgentChatError extends Error {
  code: AgentErrorCause;
  retryable: boolean;

  constructor(message: string, code: AgentErrorCause, retryable: boolean) {
    super(message);
    this.name = "AgentChatError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type AgentOutcome =
  | { status: "done"; answer: string; steps: AgentStep[]; undos: AgentWriteUndo[] }
  | {
      status: "confirm";
      summary: string;
      pending: PendingAction;
      note: string;
    }
  | {
      status: "pick";
      question: string;
      options: CandidateOption[];
      plan: ActionPlan;
      note: string;
    }
  | {
      status: "error";
      message: string;
      /** Machine-readable cause; absent on legacy custom outcomes. */
      code?: AgentErrorCause;
      /** False when re-sending cannot help (auth, format, config). */
      retryable?: boolean;
    };

const DEFAULT_MAX_STEPS = 6;
const MAX_HISTORY_MESSAGES = 20;
const TOOL_RESULT_MAX = 4000;
const ANSWER_MAX = 4000;
const DEFAULT_TIME_BUDGET_MS = 180_000;
/** Two consecutive model mistakes end the run (no infinite repair). */
const MAX_MISTAKES = 2;
/** Bare finals longer than this get one tool challenge (when enabled). */
const DEFAULT_BARE_FINAL_CHARS = 200;

const BARE_FINAL_CHALLENGE_DE =
  "Du hast kein Werkzeug aufgerufen. Falls die Frage Fakten (Termine, Aufgaben, Zahlen, Orte, Erinnerungen, Lernstand, Vorlesungen, Dokumente) betrifft, rufe JETZT das passende Werkzeug auf. Nur wenn wirklich keine Fakten nötig sind, wiederhole deine Antwort als {\"final\": \"…\"}.";

const BARE_FINAL_CHALLENGE_RU =
  "Ты не вызвал ни одного инструмента. Если вопрос касается фактов (встречи, задачи, цифры, места, воспоминания, учёба, лекции, документы), вызови СЕЙЧАС подходящий инструмент. Только если факты действительно не нужны, повтори ответ как {\"final\": \"…\"}.";

function bareFinalChallenge(locale: AssistantLocale): string {
  return locale === "ru" ? BARE_FINAL_CHALLENGE_RU : BARE_FINAL_CHALLENGE_DE;
}

const PLACE_CHALLENGE_DE =
  "Diese Frage betrifft Orte, aber du hast lifestyle.placesSearch nicht aufgerufen. Rufe JETZT lifestyle.placesSearch auf (Suchtext, Umgebung, Kategorie) und nenne nur echte Treffer mit Quelle — Orte, Adressen, Öffnungszeiten oder Bewertungen zu erfinden ist VERBOTEN. Nur wenn du erst eine Rückfrage stellen musst (z. B. welche Stadt), wiederhole deine Antwort als {\"final\": \"…\"}.";

const PLACE_CHALLENGE_RU =
  "Этот вопрос касается мест, но ты не вызвал lifestyle.placesSearch. Вызови СЕЙЧАС lifestyle.placesSearch (запрос, окрестность, категория) и называй только настоящие результаты с источником — выдумывать места, адреса, часы работы или оценки ЗАПРЕЩЕНО. Только если сначала нужен уточняющий вопрос (например, какой город), повтори ответ как {\"final\": \"…\"}.";

function placeChallenge(locale: AssistantLocale): string {
  return locale === "ru" ? PLACE_CHALLENGE_RU : PLACE_CHALLENGE_DE;
}

/**
 * True when the user's question is about places/venues. Used for the
 * one-round "call the search tool instead of inventing" challenge —
 * a cheap keyword gate, never a verdict about the answer itself.
 */
export function looksLikePlaceQuery(text: string): boolean {
  return /ort|pl[äa]tz|restaurants?|caf[eé]s?|bars?|kneipe|kinoabend|kino|film|museum|theater|konzert|park|hotel|pension|sehensw[üu]rdig|ausflug|spazier|wander|fitness|gym|veranstaltung|einkauf|shopping|wochenende|weekend|strand|essen\s+gehen|wo\s+kann|in\s+der\s+n[äa]he|umgebung|freizeit|мест|ресторан|кафе|бар|кино|музей|театр|парк|отел|достопримечател|куда\s+сходить|погулять|поесть|выходн|фитнес/i.test(
    text,
  );
}

/**
 * True for the loop's own repair prompts (corrections, challenges).
 * Transports that re-read history (e.g. the heuristic adapter) must
 * skip these when finding the user's actual message.
 */
export function isAgentLoopPrompt(text: string): boolean {
  return (
    text === AGENT_CORRECTION ||
    text === BARE_FINAL_CHALLENGE_DE ||
    text === BARE_FINAL_CHALLENGE_RU ||
    text === PLACE_CHALLENGE_DE ||
    text === PLACE_CHALLENGE_RU
  );
}

// ------------------------------------------------------------ model view
// The registry describes every tool input (including the loaded data
// arrays the client supplies). The model only sets the small params
// below — data always comes from the caller's stores, never from the
// model, so it can neither invent nor leak user data through args.

export const MODEL_PARAMS: Record<string, string> = {
  "calendar.today": "keine",
  "calendar.upcoming": '{"days"?: 0–60, Standard 7}',
  "calendar.list": '{"from"?: "YYYY-MM-DD", "to"?: "YYYY-MM-DD"}',
  "tasks.open": "keine",
  "study.deadlines": "keine",
  "study.progress": "keine",
  "study.attention": '{"withinDays"?: 0–90, Standard 14}',
  "finance.monthSummary": '{"monthKey": "YYYY-MM" (erforderlich)}',
  "finance.largest": '{"monthKey": "YYYY-MM" (erforderlich), "limit"?: 1–20}',
  "finance.list": '{"limit"?: 1–50, Standard 10}',
  "finance.summary": '{"monthKey"?: "YYYY-MM", Standard aktueller Monat}',
  "lifestyle.preferences": "keine",
  "lifestyle.saved": "keine",
  "lifestyle.upcomingPlans": "keine",
  "lifestyle.placesSearch":
    '{"query"?, "near"?, "category"? (nature|food|culture|sport|cinema|date|free), "limit"?: 1–10}',
  "memory.approved": "keine",
  "memory.create":
    '{"entry": {category preferences|goals|study|finance|lifestyle|assistant, title, content}}',
  "lecture.overview": "keine",
  "study.documents": "keine",
  "study.retrieve": '{"query" (erforderlich), "documentId"?, "limit"?: 1–10}',
  "briefing.today": "keine",
  "calendar.create":
    '{"event": {title, date YYYY-MM-DD, start/end HH:MM, type personal|lecture|exam, description, location}}',
  "calendar.update":
    '{"ref": {titleQuery, date?}, "patch": {mind. ein Feld: title?, date?, start?, end?, type?, description?, location?}}',
  "calendar.delete": '{"ref": {titleQuery, date?}}',
  "finance.create":
    '{"transaction": {title, amountCents (ganzzahlig > 0), type income|expense, category, date YYYY-MM-DD, currency EUR, note}}',
  "tasks.create":
    '{"task": {title, time ("HH:MM" oder "Keine Frist"), priority Niedrig|Mittel|Hoch, dueDate? "YYYY-MM-DD"}}',
};

function toolCatalog(granted: ToolPermission[]): string {
  return ASSISTANT_TOOLS.filter((tool) => granted.includes(tool.permission))
    .map(
      (tool) =>
        `- ${tool.id}: ${tool.description} Argumente: ${MODEL_PARAMS[tool.id] ?? "keine"}`,
    )
    .join("\n");
}

export function buildAgentSystemPrompt(input: {
  locale: AssistantLocale;
  todayISO: string;
  nowTime: string;
  granted: ToolPermission[];
}): string {
  const lang = input.locale === "ru" ? "Russisch" : "Deutsch";

  return `Du bist J.A.R.V.I.S., ein persönlicher Assistent. Heute ist ${input.todayISO}, lokale Uhrzeit ${input.nowTime}. Antwortsprache: ${lang}.

Du hast ausschließlich diese Werkzeuge (kein SQL, keine Shell, kein Code, kein direkter Internetzugriff — Live-Daten nur über Werkzeuge wie lifestyle.placesSearch und study.retrieve):

${toolCatalog(input.granted)}

Antworte IMMER mit genau einem JSON-Objekt, ohne Markdown und ohne Fließtext:
- finales Ergebnis: {"final": "<Antwort an den Nutzer>"}
- Werkzeug aufrufen: {"tool": "<id>", "args": {…}}

Regeln: Bei JEDER Frage zu Terminen, Aufgaben, Finanzen, Orten, Erinnerungen, Lernstand, Vorlesungen/Aufnahmen oder Dokumenteninhalten MUSST du zuerst das passende Werkzeug aufrufen — eine finale Antwort ohne vorherigen Werkzeugaufruf ist dann VERBOTEN (erfinde NIEMALS Werte). Für Fragen zu Unterlagen nutze study.retrieve (Dokumente listet study.documents) und belege jede Aussage mit den [Qn]-Quellen aus dem Werkzeugergebnis — Quellen zu erfinden ist VERBOTEN. Findet das Werkzeug nichts, sage ehrlich, dass die Unterlagen nichts enthalten. Für Fragen zu Orten, Ausflügen, Restaurants oder Cafés rufst du IMMER zuerst lifestyle.placesSearch auf und nennst nur echte Treffer (Name, Adresse und Öffnungszeiten nur aus dem Werkzeugergebnis, mit Quellenangabe) — Orte, Adressen, Öffnungszeiten oder Bewertungen zu erfinden ist VERBOTEN. „Merk dir …" speicherst du per memory.create (passende Kategorie wählen), statt es nur zuzusagen. Nur bei Begrüßung, Smalltalk oder Rückfragen darfst du direkt per "final" antworten. Schreib-Werkzeuge nur bei vollständigen Angaben, sonst frage per "final" nach. Deutsche Beträge ("24,50") werden zu Cent. Relative Daten löst du gegen Heute auf. Fasse Tool-Ergebnisse in der finalen Antwort zusammen und sage ehrlich dazu, was erledigt wurde und was nicht. Du darfst zusätzlich ein Feld "thought" mit kurzer Begründung mitsenden.`;
}

export const AGENT_CORRECTION =
  "Ungültig. Antworte mit GENAU einem JSON-Objekt: {\"final\": \"…\"} oder {\"tool\": \"<id>\", \"args\": {…}}. Kein Markdown, kein Fließtext.";

// ------------------------------------------------------------------ parse

type Envelope =
  | { kind: "final"; answer: string }
  | { kind: "tool"; id: string; args: Record<string, unknown> }
  | { kind: "invalid" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(raw: string): Envelope {
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJsonPayload(raw)) as unknown;
  } catch {
    return { kind: "invalid" };
  }

  if (!isRecord(parsed)) return { kind: "invalid" };

  if (typeof parsed.tool === "string") {
    if (
      parsed.args !== undefined &&
      (typeof parsed.args !== "object" ||
        parsed.args === null ||
        Array.isArray(parsed.args))
    ) {
      return { kind: "invalid" };
    }

    return {
      kind: "tool",
      id: parsed.tool,
      args: (parsed.args ?? {}) as Record<string, unknown>,
    };
  }

  if (
    typeof parsed.final === "string" &&
    parsed.final.trim().length > 0 &&
    parsed.tool === undefined
  ) {
    return { kind: "final", answer: parsed.final.trim().slice(0, ANSWER_MAX) };
  }

  return { kind: "invalid" };
}

// ------------------------------------------------------------------ tools

function optionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

function isRealDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));

  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function isIntIn(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function argError(tool: string, field: string, expected: string): string {
  return `${tool}: ungültiges Argument „${field}" (${expected}).`;
}

/**
 * Validate the MODEL-settable args of a read tool against the registry
 * contract (same bounds the tools document). Returns a German error
 * message for the model, or null when the args may execute.
 *
 * Known keys are strict (a wrong type or an out-of-range number fails
 * loudly instead of silently falling back to a default); unknown keys
 * are ignored (the heuristic adapter reuses plan shapes with extra
 * fields like `label`, and extra keys can neither invent nor leak
 * data — every tool picks only its known fields).
 */
export function validateToolArgs(
  tool: string,
  args: Record<string, unknown>,
): string | null {
  // Optional fields accept explicit null as "unset" (the heuristic
  // adapter sends monthKey: null for week-scoped summaries).
  const set = (value: unknown): boolean =>
    value !== undefined && value !== null;

  switch (tool) {
    case "calendar.upcoming":
      if (set(args.days) && !isIntIn(args.days, 0, 60)) {
        return argError(tool, "days", "Ganzzahl 0–60");
      }
      return null;
    case "calendar.list": {
      const from = args.from;
      const to = args.to;

      if (set(from) && (typeof from !== "string" || !isRealDay(from))) {
        return argError(tool, "from", "gültiges Datum YYYY-MM-DD");
      }

      if (set(to) && (typeof to !== "string" || !isRealDay(to))) {
        return argError(tool, "to", "gültiges Datum YYYY-MM-DD");
      }

      if (
        typeof from === "string" &&
        typeof to === "string" &&
        from > to
      ) {
        return argError(tool, "to", "nicht vor „from“");
      }

      return null;
    }
    case "study.attention":
      if (set(args.withinDays) && !isIntIn(args.withinDays, 0, 90)) {
        return argError(tool, "withinDays", "Ganzzahl 0–90");
      }
      return null;
    case "finance.monthSummary":
    case "finance.largest":
      if (
        typeof args.monthKey !== "string" ||
        !MONTH_KEY.test(args.monthKey)
      ) {
        return argError(tool, "monthKey", "Monat als YYYY-MM (erforderlich)");
      }

      if (
        tool === "finance.largest" &&
        set(args.limit) &&
        !isIntIn(args.limit, 1, 20)
      ) {
        return argError(tool, "limit", "Ganzzahl 1–20");
      }

      return null;
    case "finance.list":
      if (set(args.limit) && !isIntIn(args.limit, 1, 50)) {
        return argError(tool, "limit", "Ganzzahl 1–50");
      }
      return null;
    case "finance.summary":
      if (
        set(args.monthKey) &&
        (typeof args.monthKey !== "string" || !MONTH_KEY.test(args.monthKey))
      ) {
        return argError(tool, "monthKey", "Monat als YYYY-MM");
      }
      return null;
    case "lifestyle.placesSearch": {
      for (const field of ["query", "near"] as const) {
        const value = args[field];

        if (
          set(value) &&
          (typeof value !== "string" || value.length > 200)
        ) {
          return argError(tool, field, "Text, max. 200 Zeichen");
        }
      }

      if (
        set(args.category) &&
        (typeof args.category !== "string" ||
          ![
            "nature",
            "food",
            "culture",
            "sport",
            "cinema",
            "date",
            "free",
          ].includes(args.category))
      ) {
        return argError(
          tool,
          "category",
          "eine App-Kategorie (nature, food, culture, sport, cinema, date, free)",
        );
      }

      if (set(args.limit) && !isIntIn(args.limit, 1, 10)) {
        return argError(tool, "limit", "Ganzzahl 1–10");
      }

      return null;
    }
    case "study.retrieve": {
      const query = args.query;

      if (typeof query !== "string" || query.trim() === "" || query.length > 500) {
        return argError(tool, "query", "Suchtext 1–500 Zeichen (erforderlich)");
      }

      if (
        set(args.documentId) &&
        (typeof args.documentId !== "string" || args.documentId.trim() === "")
      ) {
        return argError(tool, "documentId", "Dokument-ID als Text");
      }

      if (set(args.limit) && !isIntIn(args.limit, 1, 10)) {
        return argError(tool, "limit", "Ganzzahl 1–10");
      }

      return null;
    }
    default:
      return null;
  }
}

/** Storage keys the registry requires, mapped to the loaded `AgentData`. */
function hasRequiresKey(key: string, data: AgentData): boolean {
  switch (key) {
    case "jarvis-calendar-events":
      return Array.isArray(data.events);
    case "jarvis-tasks":
      return Array.isArray(data.tasks);
    case "jarvis-study":
      return typeof data.study === "object" && data.study !== null;
    case "jarvis-finance":
      return typeof data.finance === "object" && data.finance !== null;
    case "jarvis-lifestyle-places":
      return Array.isArray(data.places);
    case "jarvis-lifestyle-saved":
      return Array.isArray(data.savedIds);
    case "jarvis-lifestyle-plans":
      return Array.isArray(data.plans);
    case "jarvis-lifestyle-prefs":
      return typeof data.prefs === "object" && data.prefs !== null;
    case "jarvis-memory":
      return Array.isArray(data.memory);
    default:
      return true;
  }
}

/**
 * Enforce the registry `requiresKeys`: the first missing storage key,
 * or null when everything the tool needs is loaded. The tools
 * re-validate contents; this guard catches unloaded modules before a
 * read runs against them.
 */
export function missingRequiresKey(
  tool: string,
  data: AgentData,
): string | null {
  const definition = getToolDefinition(tool);

  if (definition === null) return null;

  for (const key of definition.requiresKeys) {
    if (!hasRequiresKey(key, data)) return key;
  }

  return null;
}

/** Run one read tool: model args + caller-supplied data, never storage. */
function runReadTool(
  id: string,
  args: Record<string, unknown>,
  data: AgentData,
): ToolResult<unknown> {
  switch (id) {
    case "calendar.today":
      return getTodayEvents({ events: data.events, todayISO: data.todayISO });
    case "calendar.upcoming":
      return getUpcomingEvents({
        events: data.events,
        todayISO: data.todayISO,
        days: optionalInt(args.days),
      });
    case "calendar.list":
      return getCalendarList({
        events: data.events,
        todayISO: data.todayISO,
        from: optionalString(args.from),
        to: optionalString(args.to),
      });
    case "tasks.open":
      return getOpenTasks({ tasks: data.tasks, nowTime: data.nowTime });
    case "study.deadlines":
      return getStudyDeadlines({ study: data.study, todayISO: data.todayISO });
    case "study.progress":
      return getStudyProgress({ study: data.study, todayISO: data.todayISO });
    case "study.attention":
      return getExamsNeedingAttention({
        study: data.study,
        todayISO: data.todayISO,
        withinDays: optionalInt(args.withinDays),
      });
    case "finance.monthSummary":
      return getFinanceMonthSummary({
        finance: data.finance,
        monthKey: typeof args.monthKey === "string" ? args.monthKey : "",
      });
    case "finance.largest":
      return getLargestTransactions({
        finance: data.finance,
        monthKey: typeof args.monthKey === "string" ? args.monthKey : "",
        limit: optionalInt(args.limit),
      });
    case "finance.list":
      return getFinanceList({
        finance: data.finance,
        limit: optionalInt(args.limit),
      });
    case "finance.summary":
      return getFinanceSummary({
        finance: data.finance,
        todayISO: data.todayISO,
        monthKey: optionalString(args.monthKey),
      });
    case "lifestyle.preferences":
      return getLifestylePreferences({ preferences: data.prefs });
    case "lifestyle.saved":
      return getSavedPlaces({ places: data.places, savedIds: data.savedIds });
    case "lifestyle.upcomingPlans":
      return getUpcomingPlans({ plans: data.plans, todayISO: data.todayISO });
    case "memory.approved":
      return getApprovedMemory({ memory: data.memory, todayISO: data.todayISO });
    case "lecture.overview":
      return getLectureOverview({
        sessions: data.sessions,
        recordings: data.recordings,
      });
    case "briefing.today":
      return getBriefingToday({
        events: data.events,
        tasks: data.tasks,
        study: data.study,
        finance: data.finance,
        todayISO: data.todayISO,
        nowTime: data.nowTime,
      });
    default:
      return {
        ok: false,
        error: {
          code: "invalid-input",
          message: `Unbekanntes Lese-Werkzeug: ${id}.`,
        },
      };
  }
}

/**
 * Async reads first (caller-owned data: API or local store), then the
 * sync tools. Returns null only when the run was aborted mid-tool.
 *
 * Both paths validate first: model args against the registry contract,
 * then the registry requiresKeys against the loaded data. Failures
 * return honest `ok:false` domain results for the model to report —
 * never silent fallbacks, never throws for bad args.
 */
async function runReadToolAsync(
  id: string,
  args: Record<string, unknown>,
  options: AgentOptions,
): Promise<ToolResult<unknown> | null> {
  const argsError = validateToolArgs(id, args);

  if (argsError !== null) {
    return {
      ok: false,
      error: { code: "invalid-input", message: argsError },
    };
  }

  const missingKey = missingRequiresKey(id, options.data);

  if (missingKey !== null) {
    return {
      ok: false,
      error: {
        code: "not-loaded",
        message: `${id}: benötigte Daten sind nicht geladen (${missingKey}).`,
      },
    };
  }

  const asyncRead = options.asyncReads?.[id];

  if (asyncRead === undefined) {
    return runReadTool(id, args, options.data);
  }

  try {
    return await asyncRead(args, options.signal);
  } catch (error: unknown) {
    if (options.signal?.aborted === true) return null;

    return {
      ok: false,
      error: {
        code: "unavailable",
        message:
          error instanceof Error && error.message !== ""
            ? error.message
            : "Werkzeugaufruf fehlgeschlagen.",
      },
    };
  }
}

function isStudyRetrieval(value: unknown): value is StudyRetrieval {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    Array.isArray(record.sources) &&
    record.sources.every((source) => {
      if (typeof source !== "object" || source === null) return false;

      const item = source as Record<string, unknown>;

      return (
        typeof item.documentId === "string" &&
        typeof item.documentName === "string" &&
        typeof item.refLabel === "string" &&
        typeof item.text === "string" &&
        typeof item.score === "number" &&
        Array.isArray(item.matchedTerms)
      );
    }) &&
    typeof record.totalCandidates === "number" &&
    Array.isArray(record.terms)
  );
}

/**
 * Numbers retrieval sources [Q1]… per turn (stable across repeated
 * calls) and appends the grounding instruction. Anything else
 * passes through truncated, exactly as before.
 */
function toolResultContent(
  id: string,
  result: ToolResult<unknown>,
  locale: AssistantLocale,
  citationSources: CitationSource[],
): string {
  if (id !== "study.retrieve" || !result.ok) {
    return truncateJsonSafe(result, TOOL_RESULT_MAX);
  }

  if (!isStudyRetrieval(result.data)) {
    return truncateJsonSafe(
      { ok: false, error: "Ungültiges Suchergebnis (interner Fehler)." },
      TOOL_RESULT_MAX,
    );
  }

  const sources = result.data.sources.map((source) => {
    const marker = `[Q${citationSources.length + 1}]`;
    citationSources.push({
      marker,
      documentName: source.documentName,
      refLabel: source.refLabel,
    });

    return { marker, ...source };
  });

  return truncateJsonSafe(
    {
      ok: true,
      data: {
        instruction: retrievalInstruction(locale, sources.length === 0),
        sources,
        totalCandidates: result.data.totalCandidates,
        terms: result.data.terms,
      },
    },
    TOOL_RESULT_MAX,
  );
}

/** Canonical JSON (sorted keys) for write fingerprints. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value).sort();

    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

type StringRef = { parent: Record<string, unknown> | unknown[]; key: string | number };

function collectStrings(value: unknown, into: StringRef[]): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];

      if (typeof item === "string") {
        into.push({ parent: value, key: index });
      } else {
        collectStrings(item, into);
      }
    }

    return;
  }

  if (isRecord(value)) {
    for (const key of Object.keys(value)) {
      const item = value[key];

      if (typeof item === "string") {
        into.push({ parent: value, key });
      } else {
        collectStrings(item, into);
      }
    }
  }
}

/** Shorten the single longest string (>= 80 chars); false when none. */
function shrinkLongestString(root: unknown): boolean {
  const refs: StringRef[] = [];
  collectStrings(root, refs);

  let best: StringRef | null = null;
  let bestLength = 80;

  for (const ref of refs) {
    const current = ref.parent[ref.key as never] as unknown;

    if (typeof current === "string" && current.length > bestLength) {
      best = ref;
      bestLength = current.length;
    }
  }

  if (best === null) return false;

  const current = best.parent[best.key as never] as string;
  const half = Math.max(40, Math.floor(current.length / 2));
  (best.parent as Record<string | number, unknown>)[best.key] =
    `${current.slice(0, half)}…gekürzt`;

  return true;
}

/**
 * Serialize a tool result within `max` chars, ALWAYS as valid JSON.
 * Long payloads shrink inside their longest string fields first (with
 * a visible …gekürzt marker); when that cannot fit, a small shape
 * summary preserves the `ok` flag and any error message. The old raw
 * slice cut JSON mid-object, which downstream parsers (and the
 * heuristic adapter) could not read at all.
 */
export function truncateJsonSafe(value: unknown, max: number): string {
  const raw = JSON.stringify(value) ?? "null";

  if (raw.length <= max) return raw;

  const clone: unknown = JSON.parse(raw) as unknown;

  for (let round = 0; round < 12; round += 1) {
    const current = JSON.stringify(clone) ?? "null";

    if (current.length <= max) return current;
    if (!shrinkLongestString(clone)) break;
  }

  const shrunk = JSON.stringify(clone) ?? "null";

  if (shrunk.length <= max) return shrunk;

  if (isRecord(value)) {
    const summary: Record<string, unknown> = {
      gekürzt: "Ergebnis zu lang für eine Antwort. Bitte Frage eingrenzen.",
    };

    if (typeof value.ok === "boolean") summary.ok = value.ok;
    if (value.error !== undefined) summary.error = value.error;

    return JSON.stringify(summary);
  }

  if (Array.isArray(value)) {
    return JSON.stringify({
      gekürzt: "Ergebnis zu lang für eine Antwort. Bitte Frage eingrenzen.",
      anzahl: value.length,
    });
  }

  return JSON.stringify({
    gekürzt: "Ergebnis zu lang für eine Antwort. Bitte Frage eingrenzen.",
  });
}

// ------------------------------------------------------------------- loop

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return min;

  return Math.min(max, Math.max(min, value));
}

function mistakeMessage(locale: AssistantLocale): string {
  return locale === "ru"
    ? "Модель дважды ответила неверно. Попробуй короче сформулировать."
    : "Das Modell hat zweimal ungültig geantwortet. Formuliere kürzer und versuche es erneut.";
}

/**
 * Run one user turn: propose via the model, execute via the registry
 * and executor, repeat until the model answers or a bound trips.
 * Confirmations and disambiguations return to the caller — the loop
 * never confirms on the user's behalf.
 */
export async function runAgent(
  text: string,
  options: AgentOptions,
): Promise<AgentOutcome> {
  const granted = options.granted ?? ["read", "write"];
  const maxSteps = clampInt(options.maxSteps ?? DEFAULT_MAX_STEPS, 1, 12);
  const timeBudgetMs = clampInt(
    options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
    5000,
    600000,
  );
  const startedAt = Date.now();
  const steps: AgentStep[] = [];
  const seenWrites = new Set<string>();
  const messages: AgentMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt({
        locale: options.locale,
        todayISO: options.data.todayISO,
        nowTime: options.data.nowTime,
        granted,
      }),
    },
    ...(options.history ?? []).slice(-MAX_HISTORY_MESSAGES),
    { role: "user", content: text },
  ];

  let mistakes = 0;
  let challenged = false;
  let placeChallenged = false;
  let citationRepaired = false;
  const citationSources: CitationSource[] = [];
  const undos: AgentWriteUndo[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    if (options.signal?.aborted === true) {
      return { status: "error", message: "Abgebrochen.", code: "aborted", retryable: true };
    }

    if (Date.now() - startedAt > timeBudgetMs) {
      return {
        status: "error",
        message:
          options.locale === "ru"
            ? "Превышен лимит времени. Попробуй ещё раз."
            : "Zeitbudget überschritten. Versuche es erneut.",
        code: "budget",
        retryable: true,
      };
    }

    let raw: string;

    try {
      raw = await options.chat(messages);
    } catch (error: unknown) {
      if (error instanceof AgentChatError) {
        return {
          status: "error",
          message: error.message,
          code: error.code,
          retryable: error.retryable,
        };
      }

      return {
        status: "error",
        message:
          error instanceof Error && error.message !== ""
            ? error.message
            : "Unbekannter Fehler.",
        code: "unknown",
        retryable: true,
      };
    }

    const envelope = parseEnvelope(raw);

    if (envelope.kind === "final") {
      const bareThreshold =
        options.bareFinalChars ?? DEFAULT_BARE_FINAL_CHARS;

      if (
        (options.challengeBareFinals ?? true) &&
        !challenged &&
        granted.length > 0 &&
        steps.length === 0 &&
        envelope.answer.length > bareThreshold
      ) {
        challenged = true;
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: bareFinalChallenge(options.locale),
        });

        continue;
      }

      // Place follow-up: a suspiciously long answer to a place question
      // without a live search gets ONE "call the tool, never invent"
      // round. Short finals pass (they are usually clarifying
      // questions like "which city?").
      if (
        (options.challengeBareFinals ?? true) &&
        !placeChallenged &&
        granted.includes("read") &&
        steps.every((entry) => entry.tool !== "lifestyle.placesSearch") &&
        looksLikePlaceQuery(text) &&
        envelope.answer.length > bareThreshold
      ) {
        placeChallenged = true;
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: placeChallenge(options.locale),
        });

        continue;
      }

      // Citation integrity: every [Qn] must resolve to a source
      // retrieved this turn. One repair round, then fabricated
      // markers are stripped with a visible honesty note.
      const needsCitationCheck =
        citationSources.length > 0 ||
        findCitations(envelope.answer).length > 0;
      const citationCheck = needsCitationCheck
        ? validateCitations(envelope.answer, citationSources.length)
        : { ok: true as const };

      if (!citationCheck.ok && !citationRepaired) {
        citationRepaired = true;
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: citationRepairPrompt(
            options.locale,
            citationCheck.invalid,
            citationSources,
          ),
        });

        continue;
      }

      let answer = envelope.answer;

      if (!citationCheck.ok) {
        answer = `${stripInvalidCitations(envelope.answer, citationCheck.invalid)}\n\n${strippedCitationNote(options.locale, citationCheck.invalid, citationSources)}`;
      }

      // Terminal envelopes join the transcript (persistence slices
      // the full turn, including this last assistant message).
      messages.push({ role: "assistant", content: raw });

      return { status: "done", answer, steps, undos };
    }

    if (envelope.kind === "invalid") {
      mistakes += 1;

      if (mistakes >= MAX_MISTAKES) {
        return {
          status: "error",
          message: mistakeMessage(options.locale),
          code: "model",
          retryable: true,
        };
      }

      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: AGENT_CORRECTION });

      continue;
    }

    const definition = getToolDefinition(envelope.id);

    if (definition === null || !mayInvoke(envelope.id, granted)) {
      mistakes += 1;

      if (mistakes >= MAX_MISTAKES) {
        return {
          status: "error",
          message: mistakeMessage(options.locale),
          code: "model",
          retryable: true,
        };
      }

      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "tool",
        content: JSON.stringify({
          ok: false,
          error: `Unbekanntes oder nicht erlaubtes Werkzeug: ${envelope.id}.`,
        }),
      });

      continue;
    }

    if (definition.permission === "read") {
      const result = await runReadToolAsync(
        envelope.id,
        envelope.args,
        options,
      );

      if (result === null) {
        return {
          status: "error",
          message: "Abgebrochen.",
          code: "aborted",
          retryable: true,
        };
      }

      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "tool",
        content: toolResultContent(
          envelope.id,
          result,
          options.locale,
          citationSources,
        ),
      });
      steps.push({
        tool: envelope.id,
        ok: result.ok,
        summary: result.ok ? "gelesen" : result.error.message,
      });

      // A failed read is honest domain data (missing date, invalid
      // input, provider unavailable) — the model reports it, so it
      // must NOT count as a model mistake. Only protocol violations
      // (bad envelopes, unknown tools, invalid write plans) abort
      // the run; a stuck model still hits the step budget.
      if (result.ok) {
        mistakes = 0;
      }

      continue;
    }

    // Write tools are proposals: validate the full plan, dedupe by
    // fingerprint, then execute through the existing executor.
    const candidate = { type: envelope.id, ...envelope.args };

    if (!isAssistantPlan(candidate)) {
      mistakes += 1;

      if (mistakes >= MAX_MISTAKES) {
        return {
          status: "error",
          message: mistakeMessage(options.locale),
          code: "model",
          retryable: true,
        };
      }

      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "tool",
        content: JSON.stringify({
          ok: false,
          error:
            "Ungültiger Schreib-Plan (Pflichtfelder prüfen, keine Werte erfinden).",
        }),
      });

      continue;
    }

    const fingerprint = `${envelope.id}:${stableStringify(candidate)}`;

    if (seenWrites.has(fingerprint)) {
      mistakes += 1;

      if (mistakes >= MAX_MISTAKES) {
        return {
          status: "error",
          message: mistakeMessage(options.locale),
          code: "model",
          retryable: true,
        };
      }

      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "tool",
        content: JSON.stringify({
          ok: false,
          error: "Diese Aktion wurde bereits ausgeführt und wird nicht wiederholt.",
        }),
      });

      continue;
    }

    seenWrites.add(fingerprint);
    mistakes = 0;

    const report = await executePlan(
      candidate as ActionPlan,
      createId(),
      {
        events: options.data.events,
        finance: options.data.finance,
        calendar: options.stores.calendar,
        transactions: options.stores.transactions,
        memories: options.stores.memories,
        tasks: options.stores.tasks,
        locale: options.locale,
      },
    );

    if (report.status === "confirm") {
      messages.push({ role: "assistant", content: raw });

      return {
        status: "confirm",
        summary: report.summary,
        pending: report.pending,
        note:
          options.locale === "ru"
            ? "Подтверди действие, чтобы продолжить."
            : "Bitte bestätige die Aktion, um fortzufahren.",
      };
    }

    if (report.status === "pick") {
      messages.push({ role: "assistant", content: raw });

      return {
        status: "pick",
        question: report.question,
        options: report.options,
        plan: candidate as ActionPlan,
        note:
          options.locale === "ru"
            ? "Выбери, что имелось в виду."
            : "Bitte wähle aus, was gemeint war.",
      };
    }

    if (report.status === "error") {
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "tool",
        content: truncateJsonSafe(
          { ok: false, error: report.message },
          TOOL_RESULT_MAX,
        ),
      });
      steps.push({ tool: envelope.id, ok: false, summary: report.message });

      continue;
    }

    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "tool",
      content: truncateJsonSafe({ ok: true, message: report.message }, TOOL_RESULT_MAX),
    });
    steps.push({ tool: envelope.id, ok: true, summary: report.message });

    if (report.undo !== undefined) {
      undos.push({ tool: envelope.id, undo: report.undo });
    }
  }

  return {
    status: "error",
    message:
      options.locale === "ru"
        ? "Слишком много шагов. Уточни запрос и попробуй ещё раз."
        : "Zu viele Schritte für diese Anfrage. Präzisiere sie und versuche es erneut.",
    code: "budget",
    retryable: true,
  };
}

// --------------------------------------------------------------- transport

export type ClassifiedServerError = {
  message: string;
  code: AgentErrorCause;
  retryable: boolean;
};

/**
 * Classify a failed inference response from its status + typed error
 * envelope (`{ ok:false, error:{ code, message } }`). The server's
 * German message is preserved verbatim; the code decides the cause
 * label and whether re-sending can help. Exported for tests.
 */
export function classifyServerError(
  status: number,
  parsed: unknown,
): ClassifiedServerError {
  const fallback = `Serverfehler (${status}).`;
  const errorRecord =
    isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
  const message =
    errorRecord !== null && typeof errorRecord.message === "string"
      ? errorRecord.message
      : fallback;
  const code =
    errorRecord !== null && typeof errorRecord.code === "string"
      ? errorRecord.code
      : null;

  switch (code) {
    case "unauthorized":
      return { message, code: "auth", retryable: false };
    case "bad-request":
    case "not-found":
    case "conflict":
    case "payload-too-large":
      return { message, code: "format", retryable: false };
    case "upstream-error":
    case "worker-unavailable":
      return { message, code: "ollama", retryable: true };
    case "migration-pending":
      return { message, code: "supabase", retryable: true };
    case "cloud-not-configured":
      return { message, code: "provider", retryable: false };
    default:
      break;
  }

  if (status === 401) return { message, code: "auth", retryable: false };
  if (status === 400) return { message, code: "format", retryable: false };
  if (status === 503 || status === 502) {
    return { message, code: "ollama", retryable: true };
  }

  return { message, code: "unknown", retryable: true };
}

function abortChatError(): AgentChatError {
  return new AgentChatError("Abgebrochen.", "aborted", true);
}

function networkChatError(): AgentChatError {
  return new AgentChatError(
    "Keine Verbindung zum Server. Prüfe deine Verbindung und versuche es erneut.",
    "network",
    true,
  );
}

/**
 * Production chat transport: POST the history to /api/llm/chat and
 * return the assistant content. Failures throw an `AgentChatError`
 * carrying the server's German message plus a classified cause and
 * retry hint, so the loop can surface all three honestly. An
 * optional signal aborts the request and surfaces as "Abgebrochen."
 */
export function createApiChat(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): AgentChat {
  return async (messages: AgentMessage[]): Promise<string> => {
    if (signal !== undefined && signal.aborted) {
      throw abortChatError();
    }

    let res: Response;

    try {
      res = await fetcher("/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          options: { format: "json", think: false, temperature: 0 },
        }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      if (signal !== undefined && signal.aborted) {
        throw abortChatError();
      }

      throw networkChatError();
    }

    if (res.status === 401) {
      throw new AgentChatError(
        "Sitzung abgelaufen. Bitte melde dich erneut an.",
        "auth",
        false,
      );
    }

    let parsed: unknown = null;

    try {
      parsed = (await res.json()) as unknown;
    } catch {
      const classified = classifyServerError(res.status, null);

      throw new AgentChatError(
        classified.message,
        classified.code,
        classified.retryable,
      );
    }

    if (
      isRecord(parsed) &&
      parsed.ok === true &&
      isRecord(parsed.data) &&
      typeof parsed.data.content === "string"
    ) {
      return parsed.data.content;
    }

    const classified = classifyServerError(res.status, parsed);

    throw new AgentChatError(
      classified.message,
      classified.code,
      classified.retryable,
    );
  };
}

/**
 * Streaming production transport: POST the history to
 * /api/llm/chat/stream (SSE) and collect the assistant content.
 * Tokens stream in as they generate (first byte fast, abort cuts
 * the stream immediately); the loop still parses the COMPLETE
 * envelope, so partial JSON never executes anything. `onToken`
 * observes progress (optional); failures throw the server's German
 * message, like the non-streaming transport.
 */
export function createApiChatStream(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  onToken?: (delta: string) => void,
): AgentChat {
  return async (messages: AgentMessage[]): Promise<string> => {
    if (signal !== undefined && signal.aborted) {
      throw abortChatError();
    }

    let res: Response;

    try {
      res = await fetcher("/api/llm/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          options: { format: "json", think: false, temperature: 0 },
        }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      if (signal !== undefined && signal.aborted) {
        throw abortChatError();
      }

      throw networkChatError();
    }

    if (res.status === 401) {
      throw new AgentChatError(
        "Sitzung abgelaufen. Bitte melde dich erneut an.",
        "auth",
        false,
      );
    }

    if (!res.ok || res.body === null) {
      throw await streamError(res);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          for (const line of event.split("\n")) {
            const payload = line.startsWith("data:") ? line.slice(5).trim() : "";

            if (payload === "") continue;

            let parsed: unknown = null;

            try {
              parsed = JSON.parse(payload) as unknown;
            } catch {
              continue;
            }

            if (!isRecord(parsed)) continue;

            if (typeof parsed.token === "string") {
              content += parsed.token;
              onToken?.(parsed.token);
            } else if (typeof parsed.error === "string") {
              // Mid-stream failures come from the Ollama read itself.
              throw new AgentChatError(parsed.error, "ollama", true);
            }
            // {"done":true,...} carries no text; loop ends at stream end.
          }
        }

        if (signal !== undefined && signal.aborted) {
          throw abortChatError();
        }
      }
    } catch (error: unknown) {
      try {
        await reader.cancel();
      } catch {
        // Teardown only; the original error below is what matters.
      }

      if (error instanceof AgentChatError) throw error;

      throw error instanceof Error && error.message !== ""
        ? new AgentChatError(error.message, "unknown", true)
        : new AgentChatError("Unbekannter Fehler.", "unknown", true);
    }

    if (content === "") {
      throw new AgentChatError(
        "Das KI-Modell hat eine leere Antwort geliefert. Versuche es erneut.",
        "model",
        true,
      );
    }

    return content;
  };
}

async function streamError(res: Response): Promise<AgentChatError> {
  let parsed: unknown = null;

  try {
    parsed = (await res.json()) as unknown;
  } catch {
    // Fall through with null; the classifier emits the status message.
  }

  const classified = classifyServerError(res.status, parsed);

  return new AgentChatError(
    classified.message,
    classified.code,
    classified.retryable,
  );
}
