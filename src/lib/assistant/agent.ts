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
  getCalendarList,
  getExamsNeedingAttention,
  getFinanceList,
  getFinanceMonthSummary,
  getFinanceSummary,
  getLargestTransactions,
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
  todayISO: string;
  nowTime: string;
};

export type AgentStores = Pick<
  ExecutorDeps,
  "calendar" | "transactions"
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
  | { status: "error"; message: string };

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
  "Du hast kein Werkzeug aufgerufen. Falls die Frage Fakten (Termine, Aufgaben, Zahlen, Orte, Erinnerungen, Lernstand, Dokumente) betrifft, rufe JETZT das passende Werkzeug auf. Nur wenn wirklich keine Fakten nötig sind, wiederhole deine Antwort als {\"final\": \"…\"}.";

const BARE_FINAL_CHALLENGE_RU =
  "Ты не вызвал ни одного инструмента. Если вопрос касается фактов (встречи, задачи, цифры, места, воспоминания, учёба, документы), вызови СЕЙЧАС подходящий инструмент. Только если факты действительно не нужны, повтори ответ как {\"final\": \"…\"}.";

function bareFinalChallenge(locale: AssistantLocale): string {
  return locale === "ru" ? BARE_FINAL_CHALLENGE_RU : BARE_FINAL_CHALLENGE_DE;
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
    text === BARE_FINAL_CHALLENGE_RU
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
  "memory.approved": "keine",
  "study.documents": "keine",
  "study.retrieve": '{"query" (erforderlich), "documentId"?, "limit"?: 1–10}',
  "calendar.create":
    '{"event": {title, date YYYY-MM-DD, start/end HH:MM, type personal|lecture|exam, description, location}}',
  "calendar.update":
    '{"ref": {titleQuery, date?}, "patch": {mind. ein Feld: title?, date?, start?, end?, type?, description?, location?}}',
  "calendar.delete": '{"ref": {titleQuery, date?}}',
  "finance.create":
    '{"transaction": {title, amountCents (ganzzahlig > 0), type income|expense, category, date YYYY-MM-DD, currency EUR, note}}',
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

Du hast ausschließlich diese Werkzeuge (kein SQL, keine Shell, kein Code, kein Internet):

${toolCatalog(input.granted)}

Antworte IMMER mit genau einem JSON-Objekt, ohne Markdown und ohne Fließtext:
- finales Ergebnis: {"final": "<Antwort an den Nutzer>"}
- Werkzeug aufrufen: {"tool": "<id>", "args": {…}}

Regeln: Bei JEDER Frage zu Terminen, Aufgaben, Finanzen, Orten, Erinnerungen, Lernstand oder Dokumenteninhalten MUSST du zuerst das passende Werkzeug aufrufen — eine finale Antwort ohne vorherigen Werkzeugaufruf ist dann VERBOTEN (erfinde NIEMALS Werte). Für Fragen zu Unterlagen nutze study.retrieve (Dokumente listet study.documents) und belege jede Aussage mit den [Qn]-Quellen aus dem Werkzeugergebnis — Quellen zu erfinden ist VERBOTEN. Findet das Werkzeug nichts, sage ehrlich, dass die Unterlagen nichts enthalten. Nur bei Begrüßung, Smalltalk oder Rückfragen darfst du direkt per "final" antworten. Schreib-Werkzeuge nur bei vollständigen Angaben, sonst frage per "final" nach. Deutsche Beträge ("24,50") werden zu Cent. Relative Daten löst du gegen Heute auf. Fasse Tool-Ergebnisse in der finalen Antwort zusammen und sage ehrlich dazu, was erledigt wurde und was nicht. Du darfst zusätzlich ein Feld "thought" mit kurzer Begründung mitsenden.`;
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
 */
async function runReadToolAsync(
  id: string,
  args: Record<string, unknown>,
  options: AgentOptions,
): Promise<ToolResult<unknown> | null> {
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
    return truncateJson(result, TOOL_RESULT_MAX);
  }

  if (!isStudyRetrieval(result.data)) {
    return truncateJson(
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

  return truncateJson(
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

function truncateJson(value: unknown, max: number): string {
  const raw = JSON.stringify(value) ?? "null";

  return raw.length > max ? `${raw.slice(0, max)}…gekürzt` : raw;
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
  let citationRepaired = false;
  const citationSources: CitationSource[] = [];
  const undos: AgentWriteUndo[] = [];

  for (let step = 0; step < maxSteps; step += 1) {
    if (options.signal?.aborted === true) {
      return { status: "error", message: "Abgebrochen." };
    }

    if (Date.now() - startedAt > timeBudgetMs) {
      return {
        status: "error",
        message:
          options.locale === "ru"
            ? "Превышен лимит времени. Попробуй ещё раз."
            : "Zeitbudget überschritten. Versuche es erneut.",
      };
    }

    let raw: string;

    try {
      raw = await options.chat(messages);
    } catch (error: unknown) {
      return {
        status: "error",
        message:
          error instanceof Error && error.message !== ""
            ? error.message
            : "Unbekannter Fehler.",
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
        return { status: "error", message: mistakeMessage(options.locale) };
      }

      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: AGENT_CORRECTION });

      continue;
    }

    const definition = getToolDefinition(envelope.id);

    if (definition === null || !mayInvoke(envelope.id, granted)) {
      mistakes += 1;

      if (mistakes >= MAX_MISTAKES) {
        return { status: "error", message: mistakeMessage(options.locale) };
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
        return { status: "error", message: "Abgebrochen." };
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

      if (result.ok) {
        mistakes = 0;
      } else {
        mistakes += 1;

        if (mistakes >= MAX_MISTAKES) {
          return { status: "error", message: mistakeMessage(options.locale) };
        }
      }

      continue;
    }

    // Write tools are proposals: validate the full plan, dedupe by
    // fingerprint, then execute through the existing executor.
    const candidate = { type: envelope.id, ...envelope.args };

    if (!isAssistantPlan(candidate)) {
      mistakes += 1;

      if (mistakes >= MAX_MISTAKES) {
        return { status: "error", message: mistakeMessage(options.locale) };
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
        return { status: "error", message: mistakeMessage(options.locale) };
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
        content: truncateJson(
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
      content: truncateJson({ ok: true, message: report.message }, TOOL_RESULT_MAX),
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
  };
}

// --------------------------------------------------------------- transport

/**
 * Production chat transport: POST the history to /api/llm/chat and
 * return the assistant content. Throws the server's German message
 * on failure so the loop can surface it honestly. An optional
 * signal aborts the request and surfaces as "Abgebrochen."
 */
export function createApiChat(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): AgentChat {
  return async (messages: AgentMessage[]): Promise<string> => {
    if (signal !== undefined && signal.aborted) {
      throw new Error("Abgebrochen.");
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
        throw new Error("Abgebrochen.");
      }

      throw new Error(
        "Keine Verbindung zum Server. Prüfe deine Verbindung und versuche es erneut.",
      );
    }

    if (res.status === 401) {
      throw new Error("Sitzung abgelaufen. Bitte melde dich erneut an.");
    }

    let parsed: unknown = null;

    try {
      parsed = (await res.json()) as unknown;
    } catch {
      throw new Error(`Serverfehler (${res.status}).`);
    }

    if (
      isRecord(parsed) &&
      parsed.ok === true &&
      isRecord(parsed.data) &&
      typeof parsed.data.content === "string"
    ) {
      return parsed.data.content;
    }

    const message =
      isRecord(parsed) &&
      isRecord(parsed.error) &&
      typeof parsed.error.message === "string"
        ? parsed.error.message
        : `Serverfehler (${res.status}).`;

    throw new Error(message);
  };
}
