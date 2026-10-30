/**
 * Study prompts: the exact grounding contracts every summary and
 * explanation is built on, shared by the cloud routes and the local
 * client path so both modes instruct the model identically.
 */

import type { AssistantLocale } from "@/src/lib/assistant/actions";
import type { LlmMessage } from "@/src/lib/assistant/llm";

export type GroundedSource = {
  marker: string;
  documentName: string;
  refLabel: string;
  text: string;
};

function sourcesBlock(sources: GroundedSource[]): string {
  return sources
    .map(
      (source) =>
        `${source.marker} (${source.documentName}, ${source.refLabel}):\n${source.text}`,
    )
    .join("\n\n");
}

export function summaryPrompt(
  locale: AssistantLocale,
  documentName: string,
  sources: GroundedSource[],
  truncated: boolean,
): LlmMessage[] {
  const system =
    locale === "ru"
      ? "Ты — J.A.R.V.I.S., личный учебный ассистент. Отвечай по-русски, точно и только на основе приведённых отрывков. Никогда не выдумывай факты, формулы, номера страниц или источники. Если отрывков мало, скажи это честно."
      : "Du bist J.A.R.V.I.S., ein persönlicher Lernassistent. Antworte auf Deutsch, präzise und ausschließlich auf Basis der angegebenen Textstellen. Erfinde niemals Fakten, Formeln, Seitenzahlen oder Quellen. Wenn die Stellen lückenhaft sind, sage das ehrlich.";
  const coverage =
    sources.length === 0
      ? locale === "ru"
        ? "К документу нет извлечённого текста."
        : "Zum Dokument liegt kein extrahierter Text vor."
      : `${locale === "ru" ? "Отрывки" : "Textstellen"}:\n${sourcesBlock(sources)}`;
  const cutNote =
    truncated && sources.length > 0
      ? locale === "ru"
        ? "\n\nПримечание: показаны только первые отрывки — документ длиннее контекста."
        : "\n\nHinweis: Es sind nur die ersten Textstellen enthalten — das Dokument ist länger als der Kontext."
      : "";

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `${
        locale === "ru"
          ? `Составь структурированный конспект документа «${documentName}»: главные мысли, ключевые понятия и определения, важные формулы или даты — с пометками вида [Qn] у каждого пункта.`
          : `Erstelle eine strukturierte Zusammenfassung des Dokuments „${documentName}“: Kernaussagen, Schlüsselbegriffe mit Definitionen, wichtige Formeln oder Daten — jeden Punkt mit [Qn]-Angabe belegen.`
      }\n\n${coverage}${cutNote}`,
    },
  ];
}

export function explainPrompt(
  locale: AssistantLocale,
  documentName: string,
  question: string,
  sources: GroundedSource[],
): LlmMessage[] {
  const system =
    locale === "ru"
      ? "Ты — J.A.R.V.I.S., личный репетитор. Отвечай по-русски, понятно и строго по приведённым отрывкам. Каждое утверждение подкрепляй ссылкой [Qn]. Если отрывки не содержат ответа, скажи прямо: материала недостаточно — и ничего не выдумывай."
      : "Du bist J.A.R.V.I.S., ein persönlicher Tutor. Antworte auf Deutsch, verständlich und strikt auf Basis der angegebenen Textstellen. Belege jede Aussage mit [Qn]. Wenn die Stellen keine Antwort hergeben, sage direkt: Das Material reicht nicht aus — und erfinde nichts.";

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `${
        locale === "ru"
          ? `Вопрос по документу «${documentName}»: ${question}`
          : `Frage zum Dokument „${documentName}“: ${question}`
      }\n\n${locale === "ru" ? "Отрывки" : "Textstellen"}:\n${sourcesBlock(sources)}`,
    },
  ];
}

/**
 * Fits source texts into a char budget from the front (document
 * order); reports truncation honestly. Shared by cloud/local.
 */
export function fitSourcesToBudget<T extends { text: string }>(
  items: T[],
  budgetChars: number,
): { included: T[]; truncated: boolean } {
  const included: T[] = [];
  let used = 0;

  for (const item of items) {
    if (used + item.text.length > budgetChars && included.length > 0) break;

    included.push(item);
    used += item.text.length;
  }

  return { included, truncated: included.length < items.length };
}

/** Instruction block appended to retrieval tool results in the agent. */
export function retrievalInstruction(
  locale: AssistantLocale,
  insufficient: boolean,
): string {
  if (insufficient) {
    return locale === "ru"
      ? "Источники не найдены: ответь, что в материалах ничего подходящего нет, и ничего не выдумывай."
      : "Keine Quellen gefunden: Antworte, dass die Unterlagen dazu nichts enthalten, und erfinde nichts.";
  }

  return locale === "ru"
    ? "Отвечай только по этим отрывкам; подкрепляй утверждения ссылками [Qn] и копируй номера страниц/слайдов точь-в-точь из отрывков. Если ответа нет в отрывках, скажи, что материала недостаточно."
    : "Antworte nur auf Basis dieser Textstellen; belege Aussagen mit [Qn] und übernimm Seiten-/Foliennummern exakt aus den Stellen. Wenn die Antwort nicht in den Stellen steht, sage, dass das Material nicht ausreicht.";
}
