/**
 * Generated-question handling, shared by the cloud service and the
 * local client path: strict JSON parsing of model output, mapping
 * to labelled `QuizQuestion` records, and regeneration dedup.
 *
 * The parser NEVER repairs model output heuristically: items that
 * fail validation are dropped and counted, and output without any
 * JSON array is a hard error surfaced to the user.
 */

import { createId } from "@/src/lib/ids";
import type { AssistantLocale } from "@/src/lib/assistant/actions";
import type { LlmMessage } from "@/src/lib/assistant/llm";
import type { QuestionKind, QuizQuestion } from "@/src/lib/quiz";
import {
  stripInvalidCitations,
  validateCitations,
} from "@/src/lib/study/grounding";
import { questionsRepairPrompt } from "@/src/lib/study/prompts";
import type { GeneratedQuestionDto } from "@/src/lib/study/protocol";

/** Content-free drop codes: which field failed, never the text. */
export type DropReason =
  | "item"
  | "question"
  | "options"
  | "correctIndex"
  | "correctIndices"
  | "empty";

export class QuestionsParseError extends Error {
  /** Per-item drop codes when JSON existed but nothing was usable. */
  reasons: DropReason[];
  /** False when no JSON existed at all (vs. wrong-shaped JSON). */
  jsonFound: boolean;

  constructor(
    message: string,
    init: { reasons?: DropReason[]; jsonFound?: boolean } = {},
  ) {
    super(message);
    this.name = "QuestionsParseError";
    this.reasons = init.reasons ?? [];
    this.jsonFound = init.jsonFound ?? false;
  }
}

/** Human-readable reason summary, e.g. "correctIndex ×2, options". */
export function summarizeDropReasons(reasons: DropReason[]): string {
  const counts = new Map<string, number>();

  for (const reason of reasons) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  return [...counts]
    .map(([code, count]) => (count > 1 ? `${code} ×${count}` : code))
    .join(", ");
}

export type QuestionSourceLabel = {
  marker: string;
  refLabel: string;
};

export type ParsedQuestions = {
  questions: GeneratedQuestionDto[];
  droppedInvalid: number;
};

/**
 * Citation markers, tolerant in shape but strict in range: "[Q1]",
 * "Q1", any case. Range is always validated against the sources —
 * only resolvable markers survive.
 */
const MARKER_PATTERN = /^\[?Q(\d+)\]?$/i;

/**
 * Locates every top-level balanced [...] or {...} span, respecting
 * JSON string literals and escapes. Unlike first-to-last slicing,
 * bracketed prose around the payload ("Quellen: [Q1].") cannot
 * corrupt the extraction; unbalanced (truncated) tails are skipped.
 * Candidates must still JSON-parse — locating never invents.
 */
function balancedSpans(text: string, open: "[" | "{"): string[] {
  const close = open === "[" ? "]" : "}";
  const spans: string[] = [];
  let from = 0;

  while (from < text.length) {
    const start = text.indexOf(open, from);

    if (start === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const ch = text[i] as string;

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;

        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === open) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;

        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) break;

    spans.push(text.slice(start, end + 1));
    from = end + 1;
  }

  return spans;
}

/** Collects every JSON candidate: raw, fenced, and balanced spans. */
function jsonCandidates(raw: string): string[] {
  const out = [raw];

  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (typeof match[1] === "string") out.push(match[1]);
  }

  out.push(...balancedSpans(raw, "["));
  out.push(...balancedSpans(raw, "{"));

  return out;
}

/**
 * A bare object counts as one question when it carries the core
 * question shape; full validation still happens downstream, so
 * unknown objects keep failing loudly instead of slipping through.
 */
function isSingleQuestion(value: Record<string, unknown>): boolean {
  return (
    typeof value.question === "string" && Array.isArray(value.options)
  );
}

/**
 * Extracts the item array from model output. Accepts a bare array,
 * `{ "questions": [...] }`, a single question object (normalized
 * to one element), and the citation-repair `{ "final": ... }`
 * wrapper; anything else is a hard parse error.
 *
 * Scalar-only arrays (e.g. an `options` list) are deferred: they
 * only count when no real candidate exists, so a single question
 * object is never mistaken for its own options.
 */
function extractItems(raw: string): unknown[] {
  const tried = new Set<string>();
  const queue = jsonCandidates(raw);
  let scalarFallback: unknown[] | null = null;

  while (queue.length > 0) {
    const candidate = queue.shift() as string;

    if (tried.has(candidate)) continue;
    tried.add(candidate);

    let parsed: unknown;

    try {
      parsed = JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }

    if (Array.isArray(parsed)) {
      if (
        parsed.length === 0 ||
        parsed.some((entry) => typeof entry === "object" && entry !== null)
      ) {
        return parsed;
      }

      scalarFallback ??= parsed;
      continue;
    }

    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;

      if (Array.isArray(record.questions)) return record.questions;

      if (isSingleQuestion(record)) return [record];

      if (typeof record.final === "string") {
        queue.push(...jsonCandidates(record.final));
      }
    }
  }

  if (scalarFallback !== null) return scalarFallback;

  throw new QuestionsParseError(
    "Die KI-Antwort enthielt keine lesbaren Fragen (kein JSON gefunden). Bitte versuche es erneut.",
  );
}

function validKind(value: unknown): QuestionKind {
  return value === "multiple" || value === "free" ? value : "single";
}

/** Resolves [Qn] markers to ref labels; unknown markers are dropped. */
function resolveRefs(
  value: unknown,
  sources: QuestionSourceLabel[],
): string[] {
  if (!Array.isArray(value)) return [];

  const labels: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") continue;

    const match = MARKER_PATTERN.exec(entry.trim());

    if (match === null) continue;

    const index = Number.parseInt(match[1] ?? "0", 10) - 1;
    const label = sources[index]?.refLabel;

    if (typeof label === "string" && label !== "" && !labels.includes(label)) {
      labels.push(label);
    }
  }

  return labels;
}

/**
 * Removes fabricated [Qn] markers from a text field (same honesty
 * rule as `resolveRefs`: only markers that resolve to a retrieved
 * source survive; the prose itself is never rewritten).
 */
function cleanCitations(text: string, sourceCount: number): string {
  const check = validateCitations(text, sourceCount);

  return check.ok ? text : stripInvalidCitations(text, check.invalid);
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function validIndices(
  value: unknown,
  optionCount: number,
): number[] | null {
  if (!Array.isArray(value)) return null;

  const indices = [
    ...new Set(
      value.filter(
        (index): index is number =>
          typeof index === "number" &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < optionCount,
      ),
    ),
  ];

  return indices.length > 0 ? indices : null;
}

/**
 * Validates one generated item. Accepts the documented field names
 * plus the minimal aliases models emit in practice (`type`,
 * `correctAnswer`, `sourceRefs`); types and ranges stay strict, so
 * unknown shapes still fail loudly instead of slipping through.
 */
function validItem(
  value: unknown,
  sources: QuestionSourceLabel[],
  reasons: DropReason[],
): GeneratedQuestionDto | null {
  const fail = (reason: DropReason): null => {
    reasons.push(reason);

    return null;
  };

  if (typeof value !== "object" || value === null) return fail("item");

  const record = value as Record<string, unknown>;

  if (typeof record.question !== "string") return fail("question");

  const question = cleanCitations(
    record.question.trim(),
    sources.length,
  ).trim();

  if (question.length < 10 || question.length > 500) {
    return fail("question");
  }

  if (!Array.isArray(record.options)) return fail("options");

  const kind = validKind(record.kind ?? record.type);
  // Single answer: primary name wins, alias fills in; an array
  // answer only counts for "multiple" (handled below).
  const singleRaw =
    intOrNull(record.correctIndex) ?? intOrNull(record.correctAnswer);

  // Drop empty options, remapping the correct index honestly.
  const kept: string[] = [];
  let correctIndex = -1;

  for (const [index, option] of record.options.entries()) {
    if (typeof option !== "string") return fail("options");

    const text = cleanCitations(option.trim(), sources.length).trim();

    if (text === "") continue;
    if (text.length > 200) return fail("options");

    if (singleRaw !== null && index === singleRaw) {
      correctIndex = kept.length;
    }

    kept.push(text);
  }

  if (kept.length < 2) return fail("options");

  // Multi-answer: primary name wins, array alias fills in — but
  // only for "multiple". Single kinds keep an optional valid list
  // from the primary name as extra information.
  const multiIndices =
    kind === "multiple"
      ? (validIndices(record.correctIndices, kept.length) ??
        validIndices(
          Array.isArray(record.correctAnswer) ? record.correctAnswer : null,
          kept.length,
        ))
      : validIndices(record.correctIndices, kept.length);

  if (kind === "multiple") {
    if (multiIndices === null) return fail("correctIndices");

    // First correct index stays the single-choice answer for players
    // that only understand one correct option.
    correctIndex = multiIndices[0] as number;
  } else if (singleRaw === null || correctIndex < 0) {
    return fail("correctIndex");
  }

  const item: GeneratedQuestionDto = {
    question,
    options: kept,
    correctIndex,
    explanation:
      typeof record.explanation === "string"
        ? cleanCitations(record.explanation.trim(), sources.length).slice(
            0,
            1000,
          )
        : "",
    kind,
    refs: resolveRefs(record.refs ?? record.sourceRefs, sources),
  };

  if (multiIndices !== null) item.correctIndices = multiIndices;

  if (typeof record.gradingCriteria === "string") {
    const criteria = cleanCitations(
      record.gradingCriteria.trim(),
      sources.length,
    );

    if (criteria !== "") item.gradingCriteria = criteria.slice(0, 1000);
  }

  return item;
}

export function parseGeneratedQuestions(
  raw: string,
  sources: QuestionSourceLabel[],
): ParsedQuestions {
  const items = extractItems(raw);

  if (items.length === 0) {
    throw new QuestionsParseError(
      "Die KI hat keine Fragen zu diesem Dokument erstellt. Bitte versuche es erneut.",
      { jsonFound: true, reasons: ["empty"] },
    );
  }

  const questions: GeneratedQuestionDto[] = [];
  const seen = new Set<string>();
  const reasons: DropReason[] = [];
  let droppedInvalid = 0;

  for (const item of items) {
    const valid = validItem(item, sources, reasons);

    if (valid === null) {
      droppedInvalid += 1;
      continue;
    }

    const key = questionKey(valid.question);

    if (seen.has(key)) {
      droppedInvalid += 1;
      continue;
    }

    seen.add(key);
    questions.push(valid);
  }

  if (questions.length === 0) {
    throw new QuestionsParseError(
      `Die KI hat ${items.length} ${items.length === 1 ? "Frage" : "Fragen"} geliefert, aber keine war gültig (Probleme: ${summarizeDropReasons(reasons)}). Bitte versuche es erneut.`,
      { jsonFound: true, reasons },
    );
  }

  return { questions, droppedInvalid };
}

/** Single LLM call seam (cloud direct call or local /api/llm/chat). */
export type QuestionGenerationCall = (
  messages: LlmMessage[],
) => Promise<string>;

export type RepairedQuestions = ParsedQuestions & {
  /** True when the repair round produced the accepted output. */
  repaired: boolean;
  /** Length of the last model response in characters. */
  responseChars: number;
};

/**
 * Parses one generation, with exactly one controlled repair round
 * when the first response is malformed. The repair asks the model
 * to correct its own output as JSON-only; the repaired text goes
 * through the same strict parser. No heuristic fallback exists:
 * two malformed answers are an honest error, never invented or
 * silently dropped questions.
 */
export async function parseQuestionsWithRepair(
  call: QuestionGenerationCall,
  messages: LlmMessage[],
  sources: QuestionSourceLabel[],
  locale: AssistantLocale,
): Promise<RepairedQuestions> {
  const first = await call(messages);

  let firstFailure: QuestionsParseError | null = null;

  try {
    return {
      ...parseGeneratedQuestions(first, sources),
      repaired: false,
      responseChars: first.length,
    };
  } catch (error: unknown) {
    if (!(error instanceof QuestionsParseError)) throw error;

    firstFailure = error;
  }

  const second = await call([
    ...messages,
    {
      role: "assistant",
      content: first.trim() === "" ? "(keine Antwort)" : first,
    },
    {
      role: "user",
      content: questionsRepairPrompt(
        locale,
        sources.length,
        firstFailure.reasons,
      ),
    },
  ]);

  try {
    return {
      ...parseGeneratedQuestions(second, sources),
      repaired: true,
      responseChars: second.length,
    };
  } catch (error: unknown) {
    if (!(error instanceof QuestionsParseError)) throw error;

    const detail =
      error.reasons.length > 0
        ? ` (Probleme: ${summarizeDropReasons(error.reasons)})`
        : "";

    throw new QuestionsParseError(
      `Die KI-Antwort konnte auch nach einem Korrekturversuch nicht gelesen werden${detail}. Bitte versuche es erneut.`,
      { jsonFound: error.jsonFound, reasons: error.reasons },
    );
  }
}

/**
 * Token exhaustion: the model stopped before producing usable
 * content (done_reason length) or answered with thinking only.
 * Unlike malformed output this never enters the repair flow — a
 * longer repair prompt would only exhaust the budget further.
 */
export class QuestionsTruncatedError extends Error {
  doneReason: string | null;
  evalCount: number | null;
  thinkingChars: number;

  constructor(
    message: string,
    meta: { doneReason: string | null; evalCount: number | null; thinkingChars: number },
  ) {
    super(message);
    this.name = "QuestionsTruncatedError";
    this.doneReason = meta.doneReason;
    this.evalCount = meta.evalCount;
    this.thinkingChars = meta.thinkingChars;
  }
}

/**
 * Rejects incomplete generations before parsing. Shape facts only
 * (never response text): lengths and completion status that also
 * feed the server diagnostics.
 */
export function assertCompleteQuestions(meta: {
  content: string;
  doneReason: string | null;
  evalCount: number | null;
  thinkingChars: number;
}): void {
  if (meta.doneReason === "length") {
    throw new QuestionsTruncatedError(
      `Die KI-Antwort wurde abgeschnitten (Token-Limit erreicht, done_reason=length${meta.evalCount === null ? "" : `, ${meta.evalCount} Tokens`}). Bitte versuche es erneut.`,
      meta,
    );
  }

  if (meta.content.trim() === "") {
    const thinking =
      meta.thinkingChars > 0
        ? ` (nur Denkausgabe: ${meta.thinkingChars} Zeichen, keine Fragen)`
        : "";

    throw new QuestionsTruncatedError(
      `Die KI hat eine leere Antwort geliefert${thinking}. Bitte versuche es erneut.`,
      meta,
    );
  }
}

/** Normalized comparison key (case/whitespace-insensitive). */
export function questionKey(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export type GeneratedQuestionMeta = {
  documentId: string;
  subject: string;
  newId?: () => string;
};

/**
 * Maps validated DTOs to labelled AI records with fresh review
 * state. Ids are UUID-safe for the cloud `uuid` primary keys.
 */
export function toQuizQuestions(
  items: GeneratedQuestionDto[],
  meta: GeneratedQuestionMeta,
): QuizQuestion[] {
  const nextId = meta.newId ?? createId;

  return items.map((item) => ({
    id: nextId(),
    subject: meta.subject,
    examId: null,
    topicId: null,
    question: item.question,
    options: item.options,
    correctIndex: item.correctIndex,
    explanation: item.explanation,
    kind: item.kind,
    ...(item.correctIndices === undefined
      ? {}
      : { correctIndices: item.correctIndices }),
    ...(item.gradingCriteria === undefined
      ? {}
      : { gradingCriteria: item.gradingCriteria }),
    documentId: meta.documentId,
    source: "ai" as const,
    sourceRefs: item.refs,
    lastReviewedAt: null,
    nextReviewAt: null,
    reviewCount: 0,
    successCount: 0,
    streak: 0,
    difficulty: 3,
    reviewStatus: "new" as const,
  }));
}

/**
 * Drops candidates that already exist for the same document
 * (regeneration-safe); identical text from another document stays,
 * because it is linked to different source material.
 */
export function filterNewQuestions(
  existing: QuizQuestion[],
  candidates: QuizQuestion[],
): { fresh: QuizQuestion[]; skipped: number } {
  const seen = new Set(
    existing.map(
      (item) => `${item.documentId ?? ""}::${questionKey(item.question)}`,
    ),
  );
  const fresh: QuizQuestion[] = [];
  let skipped = 0;

  for (const candidate of candidates) {
    const key = `${candidate.documentId ?? ""}::${questionKey(candidate.question)}`;

    if (seen.has(key)) {
      skipped += 1;
      continue;
    }

    seen.add(key);
    fresh.push(candidate);
  }

  return { fresh, skipped };
}
