/**
 * Topic extraction, merging, and tree editing for exam prep.
 * Pure domain logic shared by the cloud service and the local
 * mirror: the model proposes grounded topics per sweep span,
 * merging folds overlaps across spans and documents, and the
 * tree ops keep user edits lossless (questions are reassigned,
 * never deleted).
 */

import {
  jaccardSimilarity,
  parseRefLabels,
  spansOverlap,
  type ParsedCoverageUnit,
} from "@/src/lib/study/coverage";
import type { LlmMessage } from "@/src/lib/assistant/llm";
import type { GroundedSource } from "@/src/lib/study/prompts";
import type { Entry, TopicSourceRef } from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";

/** Near-duplicate topic names merge (same threshold as questions). */
export const TOPIC_MERGE_THRESHOLD = 0.85;

/** Max topics requested per span (keeps JSON small and parseable). */
export const TOPICS_PER_SPAN = 6;

/** Model output tokens for one extraction span. */
export const TOPIC_EXTRACT_NUM_PREDICT = 2000;

/** Extraction spans per request (bounded like question batches). */
export const MAX_EXTRACT_SPANS = 6;

export type ExtractedFormula = {
  text: string;
  variables: string[];
};

export type ExtractedTopic = {
  name: string;
  summary: string;
  concepts: string[];
  formulas: ExtractedFormula[];
  examples: string[];
  prerequisites: string[];
  /** Broader topic name for tree nesting (may be absent). */
  parent: string | null;
  /** Validated source labels overlapping usable units. */
  refs: string[];
};

export type TopicParseResult = {
  topics: ExtractedTopic[];
  droppedInvalid: number;
  droppedUngrounded: number;
};

export class TopicsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicsParseError";
  }
}

// ---------------------------------------------------------------- prompts

function sourcesBlock(sources: GroundedSource[]): string {
  return sources
    .map(
      (source) =>
        `- ${source.marker} ${source.refLabel} (${source.documentName}):\n${source.text}`,
    )
    .join("\n\n");
}

/**
 * Strict JSON extraction contract: only topics stated in the
 * sources, every topic with marker refs, no invented content.
 */
export function topicExtractionPrompt(
  locale: string,
  documentName: string,
  spanLabel: string,
  sources: GroundedSource[],
): LlmMessage[] {
  const german = locale.toLowerCase().startsWith("de");
  const system = german
    ? "Du extrahierst Lernthemen aus Studienmaterial. Antworte NUR mit gültigem JSON, ohne Erklärungstext und ohne Markdown."
    : "You extract study topics from course material. Reply ONLY with valid JSON, no explanations and no Markdown.";
  const user = german
    ? [
        `Dokument: ${documentName}`,
        `Abschnitt: ${spanLabel}`,
        "",
        "Quellen:",
        sourcesBlock(sources),
        "",
        `Fasse den Abschnitt in höchstens ${TOPICS_PER_SPAN} Lernthemen zusammen.`,
        "Regeln:",
        "- Jedes Thema muss im Quelltext stehen — erfinde keine Themen.",
        "- refs enthält NUR die Markierungen ([Q1], [Q2], …) der Quellen, die das Thema belegen.",
        "- parent nennt das übergeordnete Thema, wenn der Abschnitt eine Untergliederung zeigt, sonst null.",
        "- prerequisites nennt nur Themennamen aus dem Material, keine Erklärungen.",
        "",
        "Antwortschema:",
        '{"topics": [{"name": "Thema", "summary": "Kurzbeschreibung", "concepts": ["Begriff"], "formulas": [{"text": "Formel", "variables": ["x"]}], "examples": ["Beispiel"], "prerequisites": ["Vormthema"], "parent": null, "refs": ["[Q1]"]}]}',
      ].join("\n")
    : [
        `Document: ${documentName}`,
        `Span: ${spanLabel}`,
        "",
        "Sources:",
        sourcesBlock(sources),
        "",
        `Summarize the span in at most ${TOPICS_PER_SPAN} study topics.`,
        "Rules:",
        "- Every topic must be stated in the sources — invent no topics.",
        "- refs contains ONLY the markers ([Q1], [Q2], …) of the sources proving the topic.",
        "- parent names the broader topic when the span shows a subdivision, else null.",
        "- prerequisites names only topic names from the material, no explanations.",
        "",
        "Response schema:",
        '{"topics": [{"name": "Topic", "summary": "Short description", "concepts": ["Term"], "formulas": [{"text": "Formula", "variables": ["x"]}], "examples": ["Example"], "prerequisites": ["Prior topic"], "parent": null, "refs": ["[Q1]"]}]}',
      ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// ------------------------------------------------------------------ parser

function balancedSpans(text: string, open: "[" | "{"): string[] {
  const close = open === "[" ? "]" : "}";
  const spans: string[] = [];
  let from = 0;

  while (from < text.length) {
    const start = text.indexOf(open, from);

    if (start === -1) break;

    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;

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

function jsonCandidates(raw: string): string[] {
  const out = [raw];

  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (typeof match[1] === "string") out.push(match[1]);
  }

  out.push(...balancedSpans(raw, "["));
  out.push(...balancedSpans(raw, "{"));

  return out;
}

function isSingleTopic(value: Record<string, unknown>): boolean {
  return typeof value.name === "string" && value.name.trim() !== "";
}

function extractItems(raw: string): unknown[] {
  const tried = new Set<string>();

  for (const candidate of jsonCandidates(raw)) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);

    let parsed: unknown;

    try {
      parsed = JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }

    if (Array.isArray(parsed)) return parsed;

    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;

      if (Array.isArray(record.topics)) return record.topics;

      if (isSingleTopic(record)) return [record];
    }
  }

  throw new TopicsParseError(
    "Die KI-Antwort enthielt keine lesbaren Themen (kein JSON gefunden). Bitte versuche es erneut.",
  );
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function formulaList(value: unknown): ExtractedFormula[] {
  if (!Array.isArray(value)) return [];

  const out: ExtractedFormula[] = [];

  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() !== "") {
      out.push({ text: entry.trim(), variables: [] });
      continue;
    }

    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;

      if (typeof record.text === "string" && record.text.trim() !== "") {
        out.push({
          text: record.text.trim(),
          variables: stringList(record.variables),
        });
      }
    }
  }

  return out;
}

/**
 * Tolerant ref items: strings as-is, bare numbers as 1-based
 * source markers ([Qn]). Anything else is ignored — tolerant
 * input, strict grounding (validated below, never invented).
 */
function refItems(refs: unknown): string[] {
  if (typeof refs === "string") {
    const trimmed = refs.trim();

    return trimmed === "" ? [] : [trimmed];
  }

  if (typeof refs === "number") {
    return Number.isInteger(refs) && refs > 0 ? [`[Q${refs}]`] : [];
  }

  if (!Array.isArray(refs)) return [];

  const out: string[] = [];

  for (const entry of refs) {
    if (typeof entry === "string" && entry.trim() !== "") {
      out.push(entry.trim());
    } else if (
      typeof entry === "number" &&
      Number.isInteger(entry) &&
      entry > 0
    ) {
      out.push(`[Q${entry}]`);
    }
  }

  return out;
}

/**
 * Resolves marker refs ([Q1]) or verbatim labels to validated
 * source labels. Unknown markers and labels outside the usable
 * units are dropped — never invented.
 */
function resolveTopicRefs(
  refs: unknown,
  sources: GroundedSource[],
  usable: ParsedCoverageUnit[],
): string[] {
  const byMarker = new Map(
    sources.map((source) => [source.marker, source.refLabel]),
  );
  const out: string[] = [];

  for (const ref of refItems(refs)) {
    const bracketed = /^\[Q(\d+)\]$/.exec(ref);
    const label =
      bracketed !== null
        ? (byMarker.get(`[Q${bracketed[1]}]`) ?? null)
        : ref;
    const parsed = label === null ? [] : parseRefLabels([label]);
    const grounded =
      label !== null &&
      label !== "" &&
      parsed.length > 0 &&
      parsed.some((part) =>
        usable.some((unit) => spansOverlap(unit, part)),
      );

    if (grounded && !out.includes(label)) out.push(label);
  }

  return out;
}

/**
 * Strict topic parser: valid JSON, non-empty names, grounded
 * refs. Ungrounded topics are dropped with a count — never
 * silently accepted, never fabricated.
 */
export function parseTopicExtraction(
  raw: string,
  sources: GroundedSource[],
  usable: ParsedCoverageUnit[],
): TopicParseResult {
  const items = extractItems(raw);
  const topics: ExtractedTopic[] = [];
  let droppedInvalid = 0;
  let droppedUngrounded = 0;

  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      droppedInvalid += 1;
      continue;
    }

    const record = item as Record<string, unknown>;
    const name =
      typeof record.name === "string" ? record.name.trim() : "";

    if (name === "") {
      droppedInvalid += 1;
      continue;
    }

    // Tolerant key: models sometimes emit references/ref/sources.
    const rawRefs =
      record.refs ?? record.references ?? record.ref ?? record.sources;
    const refs = resolveTopicRefs(rawRefs, sources, usable);

    if (refs.length === 0) {
      droppedUngrounded += 1;
      continue;
    }

    const parent =
      typeof record.parent === "string" && record.parent.trim() !== ""
        ? record.parent.trim()
        : null;

    topics.push({
      name,
      summary:
        typeof record.summary === "string" ? record.summary.trim() : "",
      concepts: stringList(record.concepts),
      formulas: formulaList(record.formulas),
      examples: stringList(record.examples),
      prerequisites: stringList(record.prerequisites),
      parent,
      refs,
    });
  }

  return { topics, droppedInvalid, droppedUngrounded };
}

// ------------------------------------------------------------------- repair

export type TopicGenerationCall = (messages: LlmMessage[]) => Promise<string>;

export type RepairedTopics = TopicParseResult & {
  repaired: boolean;
  responseChars: number;
};

function repairPrompt(
  locale: string,
  raw: string,
  reason: string,
): LlmMessage[] {
  const german = locale.toLowerCase().startsWith("de");

  return [
    {
      role: "system",
      content: german
        ? "Du korrigierst defektes JSON. Antworte NUR mit gültigem JSON, ohne Erklärungstext und ohne Markdown."
        : "You repair broken JSON. Reply ONLY with valid JSON, no explanations and no Markdown.",
    },
    {
      role: "user",
      content: german
        ? `Diese Antwort war kein lesbares Themen-JSON (${reason}). Gib denselben Inhalt als gültiges JSON im Schema {"topics": [{"name": "...", "summary": "...", "concepts": [], "formulas": [], "examples": [], "prerequisites": [], "parent": null, "refs": ["[Q1]"]}]} zurück. Erfinde keine Themen, ändere keine Belege:\n\n${raw.slice(0, 4000)}`
        : `This response was not readable topics JSON (${reason}). Return the same content as valid JSON in the schema {"topics": [{"name": "...", "summary": "...", "concepts": [], "formulas": [], "examples": [], "prerequisites": [], "parent": null, "refs": ["[Q1]"]}]}. Invent no topics, change no citations:\n\n${raw.slice(0, 4000)}`,
    },
  ];
}

/**
 * One controlled repair attempt: the first parse failure asks
 * the model to return the same content as valid JSON. Still
 * strict afterwards — no heuristic fallback topics.
 */
export async function parseTopicsWithRepair(
  call: TopicGenerationCall,
  messages: LlmMessage[],
  sources: GroundedSource[],
  usable: ParsedCoverageUnit[],
  locale: string,
): Promise<RepairedTopics> {
  const first = await call(messages);

  try {
    return {
      ...parseTopicExtraction(first, sources, usable),
      repaired: false,
      responseChars: first.length,
    };
  } catch (error: unknown) {
    if (!(error instanceof TopicsParseError)) throw error;

    const second = await call(repairPrompt(locale, first, error.message));

    return {
      ...parseTopicExtraction(second, sources, usable),
      repaired: true,
      responseChars: second.length,
    };
  }
}

// ------------------------------------------------------------------- merge

/** Lowercase alnum tokens: "Zins-Rechnung!" → "zins rechnung". */
export function normalizeTopicName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-zäöüß0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Same topic under a varied name: equal, contained ("Zinsrechnung
 * (Wiederholung)"), or token-similar. Containment needs a real
 * stem (≥6 chars) so "Zins" never swallows "Zinseszins".
 */
export function sameTopicName(a: string, b: string): boolean {
  const left = normalizeTopicName(a);
  const right = normalizeTopicName(b);

  if (left === "" || right === "") return false;
  if (left === right) return true;

  const [shorter, longer] =
    left.length <= right.length ? [left, right] : [right, left];

  if (
    shorter.length >= 6 &&
    (longer.startsWith(`${shorter} `) ||
      longer.endsWith(` ${shorter}`) ||
      longer.includes(` ${shorter} `))
  ) {
    return true;
  }

  return jaccardSimilarity(a, b) >= TOPIC_MERGE_THRESHOLD;
}

function unionStrings(base: string[], extra: string[]): string[] {
  const out = [...base];

  for (const entry of extra) {
    if (!out.includes(entry)) out.push(entry);
  }

  return out;
}

function unionSourceRefs(
  base: TopicSourceRef[],
  extra: TopicSourceRef[],
): TopicSourceRef[] {
  const out = [...base];

  for (const ref of extra) {
    if (
      !out.some(
        (have) =>
          have.documentId === ref.documentId && have.label === ref.label,
      )
    ) {
      out.push(ref);
    }
  }

  return out;
}

function topicDataOf(entry: Entry): {
  concepts: string[];
  formulas: { text: string; variables: string[] }[];
  examples: string[];
  prerequisites: string[];
  priority?: "high" | "normal" | "low";
} {
  return {
    concepts: entry.topicData?.concepts ?? [],
    formulas: entry.topicData?.formulas ?? [],
    examples: entry.topicData?.examples ?? [],
    prerequisites: entry.topicData?.prerequisites ?? [],
    ...(entry.topicData?.priority === undefined
      ? {}
      : { priority: entry.topicData.priority }),
  };
}

function unionFormulas(
  base: { text: string; variables: string[] }[],
  extra: ExtractedFormula[],
): { text: string; variables: string[] }[] {
  const out = base.map((formula) => ({
    text: formula.text,
    variables: [...formula.variables],
  }));

  for (const formula of extra) {
    const have = out.find((entry) => entry.text === formula.text);

    if (have === undefined) {
      out.push({ text: formula.text, variables: [...formula.variables] });
    } else {
      have.variables = unionStrings(have.variables, formula.variables);
    }
  }

  return out;
}

export type TopicMergeInput = {
  topic: ExtractedTopic;
  documentId: string;
};

export type TopicMergeResult = {
  /** Full topic list of the subject after merging. */
  entries: Entry[];
  created: number;
  merged: number;
};

/**
 * Folds extracted topics into the subject's topics. Same-subject
 * topics with equal normalized names (or ≥0.85 similar) merge —
 * every source ref survives, details and structured data union.
 * Parent hints link only to matched same-subject topics.
 */
export function mergeExtractedTopics(
  existing: Entry[],
  incoming: TopicMergeInput[],
  subject: string,
  makeId: () => string,
): TopicMergeResult {
  const entries = existing.map((entry) => ({ ...entry }));
  let created = 0;
  let merged = 0;

  const findMatch = (name: string): Entry | undefined =>
    entries.find(
      (entry) =>
        entry.subject === subject && sameTopicName(entry.title, name),
    );

  for (const { topic, documentId } of incoming) {
    const match = findMatch(topic.name);
    const refs: TopicSourceRef[] = topic.refs.map((label) => ({
      documentId,
      label,
    }));

    if (match === undefined) {
      entries.push({
        id: makeId(),
        title: topic.name,
        detail: topic.summary,
        subject,
        parentId: null,
        sourceRefs: refs,
        topicData: {
          concepts: topic.concepts,
          formulas: topic.formulas,
          examples: topic.examples,
          prerequisites: topic.prerequisites,
        },
      });
      created += 1;
      continue;
    }

    match.sourceRefs = unionSourceRefs(match.sourceRefs ?? [], refs);

    if (
      topic.summary !== "" &&
      !match.detail.includes(topic.summary)
    ) {
      match.detail =
        match.detail === ""
          ? topic.summary
          : `${match.detail}\n\n${topic.summary}`;
    }

    const data = topicDataOf(match);

    match.topicData = {
      concepts: unionStrings(data.concepts, topic.concepts),
      formulas: unionFormulas(data.formulas, topic.formulas),
      examples: unionStrings(data.examples, topic.examples),
      prerequisites: unionStrings(data.prerequisites, topic.prerequisites),
      // User-set priority survives extraction merges.
      ...(data.priority === undefined ? {} : { priority: data.priority }),
    };
    merged += 1;
  }

  // Second pass: parent hints resolve against the merged names.
  const byName = new Map(
    entries
      .filter((entry) => entry.subject === subject)
      .map((entry) => [normalizeTopicName(entry.title), entry]),
  );

  for (const { topic } of incoming) {
    if (topic.parent === null) continue;

    const child = findMatch(topic.name);
    const parent = byName.get(normalizeTopicName(topic.parent));

    if (
      child === undefined ||
      parent === undefined ||
      child.id === parent.id
    ) {
      continue;
    }

    if (child.parentId === undefined || child.parentId === null) {
      child.parentId = parent.id;
    }
  }

  return { entries, created, merged };
}

// ---------------------------------------------------------------- tree ops

export type TopicTreeResult = {
  entries: Entry[];
  /** Question topic reassignments (apply via the quiz store). */
  questionPatches: { id: string; topicId: string | null }[];
  removedIds: string[];
};

function treeError(message: string): { ok: false; error: string } {
  return { ok: false, error: message };
}

/** Renames one topic; sibling titles stay unique. */
export function renameTopic(
  entries: Entry[],
  id: string,
  title: string,
): { ok: true; entries: Entry[] } | { ok: false; error: string } {
  const next = title.trim();

  if (next === "") return treeError("Der Name darf nicht leer sein.");

  const target = entries.find((entry) => entry.id === id);

  if (target === undefined) return treeError("Thema nicht gefunden.");

  const clash = entries.some(
    (entry) =>
      entry.id !== id &&
      entry.subject === target.subject &&
      normalizeTopicName(entry.title) === normalizeTopicName(next),
  );

  if (clash) {
    return treeError("Ein Thema mit diesem Namen existiert bereits.");
  }

  return {
    ok: true,
    entries: entries.map((entry) =>
      entry.id === id ? { ...entry, title: next } : entry,
    ),
  };
}

/**
 * Merges topics into one survivor: source refs, details, and
 * structured data union; children and questions move to the
 * survivor. Nothing linked is lost.
 */
export function mergeTopicsManual(
  entries: Entry[],
  questions: QuizQuestion[],
  ids: string[],
  keepId?: string,
):
  | { ok: true; result: TopicTreeResult }
  | { ok: false; error: string } {
  const unique = [...new Set(ids)];

  if (unique.length < 2) {
    return treeError("Mindestens zwei Themen zum Verbinden wählen.");
  }

  const picked = unique.map((id) => entries.find((e) => e.id === id));

  if (picked.some((entry) => entry === undefined)) {
    return treeError("Thema nicht gefunden.");
  }

  const survivor =
    (keepId !== undefined
      ? picked.find((entry) => entry?.id === keepId)
      : picked[0]) ?? picked[0];

  if (survivor === undefined) return treeError("Thema nicht gefunden.");

  const losers = picked.filter(
    (entry): entry is Entry =>
      entry !== undefined && entry.id !== survivor.id,
  );
  const loserIds = new Set(losers.map((entry) => entry.id));
  const merged: Entry = {
    ...survivor,
    detail: [survivor.detail, ...losers.map((e) => e.detail)]
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .filter((part, index, all) => all.indexOf(part) === index)
      .join("\n\n"),
    sourceRefs: losers.reduce(
      (refs, entry) => unionSourceRefs(refs, entry.sourceRefs ?? []),
      [...(survivor.sourceRefs ?? [])],
    ),
  };

  const survivorData = topicDataOf(survivor);

  merged.topicData = {
    concepts: losers.reduce(
      (all, entry) => unionStrings(all, topicDataOf(entry).concepts),
      [...survivorData.concepts],
    ),
    formulas: losers.reduce(
      (all, entry) => unionFormulas(all, topicDataOf(entry).formulas),
      survivorData.formulas.map((f) => ({ ...f, variables: [...f.variables] })),
    ),
    examples: losers.reduce(
      (all, entry) => unionStrings(all, topicDataOf(entry).examples),
      [...survivorData.examples],
    ),
    prerequisites: losers.reduce(
      (all, entry) => unionStrings(all, topicDataOf(entry).prerequisites),
      [...survivorData.prerequisites],
    ),
    // Survivor priority wins; losers never downgrade it.
    ...(survivorData.priority === undefined
      ? {}
      : { priority: survivorData.priority }),
  };

  const next = entries
    .filter((entry) => !loserIds.has(entry.id))
    .map((entry) => {
      if (entry.id === survivor.id) return merged;

      if (
        typeof entry.parentId === "string" &&
        loserIds.has(entry.parentId)
      ) {
        return { ...entry, parentId: survivor.id };
      }

      return entry;
    });

  const questionPatches = questions
    .filter(
      (question) =>
        question.topicId !== null && loserIds.has(question.topicId),
    )
    .map((question) => ({ id: question.id, topicId: survivor.id }));

  return {
    ok: true,
    result: {
      entries: next,
      questionPatches,
      removedIds: [...loserIds],
    },
  };
}

/**
 * Splits one topic into named parts. Children and linked
 * questions move to the first part and are reported, so the
 * caller can redistribute them instead of losing history.
 */
export function splitTopic(
  entries: Entry[],
  questions: QuizQuestion[],
  id: string,
  parts: { title: string; detail?: string }[],
  makeId: () => string,
):
  | { ok: true; result: TopicTreeResult }
  | { ok: false; error: string } {
  const target = entries.find((entry) => entry.id === id);

  if (target === undefined) return treeError("Thema nicht gefunden.");

  const titles = parts.map((part) => part.title.trim());

  if (titles.length < 2 || titles.some((title) => title === "")) {
    return treeError("Mindestens zwei benannte Teile angeben.");
  }

  if (new Set(titles.map(normalizeTopicName)).size !== titles.length) {
    return treeError("Die Teilenamen müssen sich unterscheiden.");
  }

  const clash = entries.some(
    (entry) =>
      entry.id !== id &&
      entry.subject === target.subject &&
      titles.some(
        (title) => normalizeTopicName(entry.title) === normalizeTopicName(title),
      ),
  );

  if (clash) {
    return treeError("Ein Thema mit diesem Namen existiert bereits.");
  }

  const [first, ...rest] = titles;
  const firstId = makeId();
  const created: Entry[] = [
    {
      ...target,
      id: firstId,
      title: first as string,
      detail: parts[0]?.detail?.trim() || target.detail,
    },
    ...rest.map((title, index) => ({
      id: makeId(),
      title,
      detail: parts[index + 1]?.detail?.trim() ?? "",
      subject: target.subject,
      parentId: target.parentId ?? null,
      sourceRefs: [...(target.sourceRefs ?? [])],
      topicData: target.topicData,
    })),
  ];

  const next = entries
    .filter((entry) => entry.id !== id)
    .map((entry) =>
      entry.parentId === id ? { ...entry, parentId: firstId } : entry,
    )
    .concat(created);

  const questionPatches = questions
    .filter((question) => question.topicId === id)
    .map((question) => ({ id: question.id, topicId: firstId }));

  return {
    ok: true,
    result: { entries: next, questionPatches, removedIds: [id] },
  };
}

/**
 * Removes one topic. Children move up to its parent (or root);
 * linked questions move to the parent or become unassigned —
 * questions and history are never deleted.
 */
export function removeTopic(
  entries: Entry[],
  questions: QuizQuestion[],
  id: string,
):
  | { ok: true; result: TopicTreeResult }
  | { ok: false; error: string } {
  const target = entries.find((entry) => entry.id === id);

  if (target === undefined) return treeError("Thema nicht gefunden.");

  const fallback = target.parentId ?? null;
  const next = entries
    .filter((entry) => entry.id !== id)
    .map((entry) =>
      entry.parentId === id ? { ...entry, parentId: fallback } : entry,
    );

  const questionPatches = questions
    .filter((question) => question.topicId === id)
    .map((question) => ({ id: question.id, topicId: fallback }));

  return {
    ok: true,
    result: { entries: next, questionPatches, removedIds: [id] },
  };
}
