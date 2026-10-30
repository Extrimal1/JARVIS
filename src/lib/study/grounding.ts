/**
 * Citation integrity for grounded answers: sources retrieved through
 * `study.retrieve` are numbered [Q1]…[Qn] per turn, and every marker
 * the model emits must resolve to one of them. Markers that do not
 * resolve are fabricated citations — they get one repair round, then
 * they are stripped with a visible honesty note. No invented ref
 * ever reaches the user.
 */

import type { AssistantLocale } from "@/src/lib/assistant/actions";
import type { LlmMessage } from "@/src/lib/assistant/llm";

export type CitationSource = {
  marker: string;
  documentName: string;
  refLabel: string;
};

const CITATION_PATTERN = /\[Q(\d+)\]/g;

/** All [Qn] markers in reading order (duplicates kept). */
export function findCitations(text: string): number[] {
  const found: number[] = [];
  let match: RegExpExecArray | null;

  CITATION_PATTERN.lastIndex = 0;

  while ((match = CITATION_PATTERN.exec(text)) !== null) {
    found.push(Number.parseInt(match[1] ?? "0", 10));
  }

  return found;
}

export type CitationCheck =
  | { ok: true }
  | { ok: false; invalid: number[] };

/** Every marker must satisfy 1 ≤ n ≤ sourceCount. */
export function validateCitations(
  text: string,
  sourceCount: number,
): CitationCheck {
  const invalid = [
    ...new Set(
      findCitations(text).filter(
        (n) => !Number.isInteger(n) || n < 1 || n > sourceCount,
      ),
    ),
  ].sort((a, b) => a - b);

  return invalid.length === 0 ? { ok: true } : { ok: false, invalid };
}

/** Removes exactly the invalid markers, keeping the prose. */
export function stripInvalidCitations(
  text: string,
  invalid: number[],
): string {
  if (invalid.length === 0) return text;

  const banned = new Set(invalid);

  return text
    .replace(CITATION_PATTERN, (full, num: string) =>
      banned.has(Number.parseInt(num, 10)) ? "" : full,
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One repair round: name the bad markers, restate the valid range. */
export function citationRepairPrompt(
  locale: AssistantLocale,
  invalid: number[],
  sources: CitationSource[],
): string {
  const bad = invalid.map((n) => `[Q${n}]`).join(", ");
  const range =
    sources.length === 0
      ? "keine"
      : `[Q1]…[Q${sources.length}]`;

  return locale === "ru"
    ? `Твои ссылки ${bad} не существуют — допустимы только ${range}. Ответь снова одним JSON-объектом {"final": "…"} и используй только существующие ссылки [Qn]. Если материала недостаточно, так и скажи.`
    : `Deine Quellenangaben ${bad} existieren nicht — erlaubt sind nur ${range}. Antworte erneut mit genau einem JSON-Objekt {"final": "…"} und nutze nur existierende [Qn]-Angaben. Wenn das Material nicht reicht, sage das ehrlich.`;
}

/** Visible honesty note appended after stripping fabricated markers. */
export function strippedCitationNote(
  locale: AssistantLocale,
  removed: number[],
  sources: CitationSource[],
): string {
  const bad = removed.map((n) => `[Q${n}]`).join(", ");
  const valid =
    sources.length === 0
      ? "–"
      : sources
          .map(
            (source) =>
              `${source.marker} (${source.documentName}, ${source.refLabel})`,
          )
          .join("; ");

  return locale === "ru"
    ? `Примечание: ссылки ${bad} не прошли проверку и были удалены. Проверенные источники: ${valid}.`
    : `Hinweis: Die Quellenangaben ${bad} konnten nicht verifiziert und wurden entfernt. Geprüfte Quellen: ${valid}.`;
}

export type GroundedAnswer = {
  text: string;
  stripped: number[];
};

/**
 * Runs one grounded generation: validate citations, one repair
 * round on failure, then strip fabricated markers with a visible
 * note. Shared by the cloud routes (direct Ollama call) and the
 * local client path (via /api/llm/chat) through the `call` seam.
 */
export async function groundedAnswer(
  call: (messages: LlmMessage[]) => Promise<string>,
  messages: LlmMessage[],
  sources: CitationSource[],
  locale: AssistantLocale,
): Promise<GroundedAnswer> {
  const first = await call(messages);
  const check = validateCitations(first, sources.length);

  if (check.ok) return { text: first, stripped: [] };

  const repair = await call([
    ...messages,
    { role: "assistant", content: first },
    {
      role: "user",
      content: citationRepairPrompt(locale, check.invalid, sources),
    },
  ]);
  const recheck = validateCitations(repair, sources.length);

  if (recheck.ok) return { text: repair, stripped: [] };

  return {
    text: `${stripInvalidCitations(repair, recheck.invalid)}\n\n${strippedCitationNote(locale, recheck.invalid, sources)}`,
    stripped: recheck.invalid,
  };
}

/** Deterministic answer when retrieval found nothing usable. */
export function insufficientContextMessage(locale: AssistantLocale): string {
  return locale === "ru"
    ? "В твоих учебных материалах я ничего подходящего не нашёл — поэтому выдумывать ответ не буду. Загрузи документ по этой теме или уточни вопрос."
    : "In deinen Unterlagen habe ich dazu nichts Passendes gefunden — ich erfinde daher keine Antwort. Lade ein Dokument zu diesem Thema hoch oder präzisiere deine Frage.";
}
