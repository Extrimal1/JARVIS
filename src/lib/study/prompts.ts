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

/**
 * One summary span: concise but complete coverage of a contiguous
 * section (definitions, formulas, examples, processes). Citations
 * use the per-call [Qn] markers; the service resolves them to
 * stable slide/page labels before persisting the span.
 */
export function batchSummaryPrompt(
  locale: AssistantLocale,
  documentName: string,
  spanLabel: string,
  sources: GroundedSource[],
): LlmMessage[] {
  const system =
    locale === "ru"
      ? "Ты — J.A.R.V.I.S., личный учебный ассистент. Отвечай по-русски, точно и только на основе приведённых отрывков. Никогда не выдумывай факты, формулы, номера страниц или источники."
      : "Du bist J.A.R.V.I.S., ein persönlicher Lernassistent. Antworte auf Deutsch, präzise und ausschließlich auf Basis der angegebenen Textstellen. Erfinde niemals Fakten, Formeln, Seitenzahlen oder Quellen.";
  const task =
    locale === "ru"
      ? `Составь краткий, но содержательный конспект раздела «${spanLabel}» документа «${documentName}»: ключевые понятия с определениями, важные формулы (с пояснением переменных), шаги процессов, важные примеры и выводы. Каждый пункт подкрепляй пометкой [Qn]. Ничего не выдумывай; ничего важного не опускай ради краткости.`
      : `Fasse den Abschnitt „${spanLabel}“ des Dokuments „${documentName}“ knapp, aber gehaltvoll zusammen: Schlüsselbegriffe mit Definitionen, wichtige Formeln (mit Erklärung der Variablen), Abläufe in Schritten, wichtige Beispiele und Schlussfolgerungen. Belege jeden Punkt mit [Qn]. Erfinde nichts; lasse nichts Wichtiges der Kürze wegen weg.`;

  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `${task}\n\n${locale === "ru" ? "Отрывки" : "Textstellen"}:\n${sourcesBlock(sources)}`,
    },
  ];
}

export type SynthesisSection = {
  label: string;
  text: string;
};

/**
 * Final synthesis over persisted span summaries (never over raw
 * chunks): merges sections into one coherent exam-prep summary
 * with headings. Section labels (Folien/Seiten) are preserved
 * verbatim as the citation currency — never renumbered.
 */
export function synthesizePrompt(
  locale: AssistantLocale,
  documentName: string,
  sections: SynthesisSection[],
  complete: boolean,
): LlmMessage[] {
  const system =
    locale === "ru"
      ? "Ты — J.A.R.V.I.S., личный учебный ассистент. Отвечай по-русски и строго на основе приведённых конспектов разделов. Никогда не выдумывай факты, формулы или источники."
      : "Du bist J.A.R.V.I.S., ein persönlicher Lernassistent. Antworte auf Deutsch und strikt auf Basis der angegebenen Abschnittszusammenfassungen. Erfinde niemals Fakten, Formeln oder Quellen.";
  const body = sections
    .map((section) => `## ${section.label}\n${section.text}`)
    .join("\n\n");
  const task =
    locale === "ru"
      ? `Объедини конспекты разделов документа «${documentName}» в один связный конспект для подготовки к экзамену: убери повторы, сохрани связи между темами, структуру с заголовками, все определения, формулы, важные примеры и метки разделов (например «Folien 5–8») дословно. Не добавляй ничего, чего нет в разделах.${complete ? "" : " Честно отметь в конце, какие разделы ещё не обработаны."}`
      : `Führe die Abschnittszusammenfassungen des Dokuments „${documentName}“ zu einer zusammenhängenden Prüfungszusammenfassung zusammen: entferne Redundanzen, erhalte Themenzusammenhänge, gliedere mit Überschriften, behalte alle Definitionen, Formeln, wichtigen Beispiele und Abschnittsangaben (z. B. „Folien 5–8“) wörtlich bei. Füge nichts hinzu, was nicht in den Abschnitten steht.${complete ? "" : " Weise am Ende ehrlich aus, welche Abschnitte noch nicht verarbeitet sind."}`;

  return [
    { role: "system", content: system },
    { role: "user", content: `${task}\n\n${body}` },
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
 * Question-generation contract: strict JSON only, grounded
 * exclusively in the given excerpts. Shared by the cloud route
 * and the local client path so both modes instruct the model
 * identically. The parser (study/questions) accepts nothing
 * else — unparseable output is an error, never a heuristic.
 */
export function questionPrompt(
  locale: AssistantLocale,
  documentName: string,
  sources: GroundedSource[],
  count: number,
): LlmMessage[] {
  const system =
    locale === "ru"
      ? "Ты — J.A.R.V.I.S., автор экзаменационных вопросов. Отвечай ИСКЛЮЧИТЕЛЬНО одним JSON-массивом: никакого сопроводительного текста, вступления, пояснений, fences или выводов. Каждый вопрос — только на основе приведённых отрывков. Никогда не выдумывай факты, формулы, номера страниц или источники. Используй только существующие ссылки [Qn]."
      : "Du bist J.A.R.V.I.S., ein Ersteller von Prüfungsfragen. Antworte AUSSCHLIESSLICH mit einem JSON-Array: kein Begleittext, keine Einleitung, keine Erklärung, keine Code-Fences, kein Fazit. Jede Frage basiert ausschließlich auf den angegebenen Textstellen. Erfinde niemals Fakten, Formeln, Seitenzahlen oder Quellen. Nutze nur existierende [Qn]-Angaben.";
  const range =
    sources.length === 0 ? "keine" : `[Q1]…[Q${sources.length}]`;
  const shape =
    locale === "ru"
      ? `Создай строго один JSON-массив ровно из ${count} экзаменационных вопросов по документу «${documentName}» — смесь типов: single (один правильный ответ из 2–4 вариантов), multiple (несколько правильных, correctIndices), free (открытый вопрос или короткая расчётная задача с gradingCriteria). Вопрос «верно/неверно» — это single с options ["Верно", "Неверно"]. Каждый объект: {"question": string, "options": string[>=2], "correctIndex": number, "explanation": string, "kind": "single"|"multiple"|"free", "correctIndices"?: number[], "gradingCriteria"?: string, "refs": ["[Qn]", ...]}. Пример формата (2 объекта — ты возвращаешь ${count}): [{"question": "…?", "options": ["A", "B"], "correctIndex": 0, "explanation": "… [Q1].", "kind": "single", "refs": ["[Q1]"]}, {"question": "…?", "options": ["Верно", "Неверно"], "correctIndex": 1, "explanation": "… [Q2].", "kind": "single", "refs": ["[Q2]"]}]. Начни ответ с «[» и закончи «]». НИКОГДА не возвращай одиночный объект без скобок массива — даже если получился только один вопрос. Для kind=free: options[0] — краткое образцовое решение, options[1] — "См. объяснение", correctIndex 0. Ничего не выдумывай: explanation всегда раскрывает правильный ответ со ссылкой [Qn]. refs — только реально использованные маркеры из ${range}. Если вопрос нельзя подтвердить отрывками, пропусти его — возвращай только подкреплённые вопросы.`
      : `Erstelle als genau ein JSON-Array exakt ${count} Prüfungsfragen zum Dokument „${documentName}“ — eine Mischung aus: single (genau eine richtige Antwort bei 2–4 Optionen), multiple (mehrere richtige, mit correctIndices), free (offene Frage oder kurze Rechen-/Anwendungsaufgabe mit gradingCriteria). Wahr/Falsch-Fragen sind single mit options ["Wahr", "Falsch"]. Jedes Objekt: {"question": string, "options": string[>=2], "correctIndex": number, "explanation": string, "kind": "single"|"multiple"|"free", "correctIndices"?: number[], "gradingCriteria"?: string, "refs": ["[Qn]", ...]}. Beispiel für das Format (hier 2 Objekte, du lieferst ein Array mit ${count} Objekten): [{"question": "…?", "options": ["A", "B"], "correctIndex": 0, "explanation": "… [Q1].", "kind": "single", "refs": ["[Q1]"]}, {"question": "…?", "options": ["Wahr", "Falsch"], "correctIndex": 1, "explanation": "… [Q2].", "kind": "single", "refs": ["[Q2]"]}]. Beginne deine Antwort mit "[" und beende sie mit "]". Gib NIEMALS ein einzelnes Objekt ohne Array-Klammern zurück — auch dann nicht, wenn du nur eine Frage erstellen kannst. Bei kind=free: options[0] ist die kurze Musterlösung, options[1] ist "Siehe Erklärung", correctIndex 0. Erfinde nichts: die explanation begründet immer die richtige Antwort mit [Qn]-Beleg. refs enthält nur tatsächlich genutzte Marker aus ${range}. Ist eine Frage aus den Stellen nicht belegbar, lasse sie weg — gib nur belegte Fragen zurück.`;
  const coverage =
    sources.length === 0
      ? locale === "ru"
        ? "К документу нет извлечённого текста."
        : "Zum Dokument liegt kein extrahierter Text vor."
      : `${locale === "ru" ? "Отрывки" : "Textstellen"}:\n${sourcesBlock(sources)}`;

  return [
    { role: "system", content: system },
    { role: "user", content: `${shape}\n\n${coverage}` },
  ];
}

/**
 * Single repair round for malformed question output: restates the
 * strict JSON contract without re-sending the sources (they are
 * already in the conversation), plus the concrete problems the
 * parser observed — so the model fixes its actual mistake instead
 * of repeating it. Never asks for prose, so the strict parser
 * stays the only judge.
 */
export function questionsRepairPrompt(
  locale: AssistantLocale,
  sourceCount: number,
  problems: string[] = [],
): string {
  const range = sourceCount === 0 ? "keine" : `[Q1]…[Q${sourceCount}]`;
  const base =
    locale === "ru"
      ? `Твой прошлый ответ не был валидным JSON-массивом. Ответь сейчас ИСКЛЮЧИТЕЛЬНО исправленным JSON-массивом — без текста и fences. Каждый объект: {"question", "options"[>=2], "correctIndex", "explanation", "kind", "refs"}. Используй только маркеры из ${range}. Всегда массив [...] — никогда одиночный объект. Ничего не выдумывай; возвращай только подкреплённые вопросы, даже если их меньше.`
      : `Deine vorige Antwort war kein gültiges JSON-Array. Antworte jetzt AUSSCHLIESSLICH mit dem korrigierten JSON-Array — kein Text, keine Fences. Jedes Objekt: {"question", "options"[>=2], "correctIndex", "explanation", "kind", "refs"}. Nutze nur Marker aus ${range}. Immer ein Array mit [...] — niemals ein einzelnes Objekt. Erfinde nichts; gib nur belegte Fragen zurück, auch wenn es weniger sind.`;

  const hints = [...new Set(problems)]
    .slice(0, 3)
    .map((problem) => repairHint(locale, problem))
    .filter((hint) => hint !== null);

  if (hints.length === 0) return base;

  return locale === "ru"
    ? `${base} Проблемы прошлого ответа: ${hints.join("; ")}.`
    : `${base} Probleme deiner vorigen Antwort: ${hints.join("; ")}.`;
}

function repairHint(locale: AssistantLocale, problem: string): string | null {
  const hints: Record<string, { de: string; ru: string }> = {
    question: {
      de: "„question“ als Text mit mind. 10 Zeichen",
      ru: "«question» — текст от 10 символов",
    },
    options: {
      de: "„options“ als Array mit mind. 2 Texten",
      ru: "«options» — массив из 2+ строк",
    },
    correctIndex: {
      de: "„correctIndex“ als Zahl (0-basiert)",
      ru: "«correctIndex» — число (с 0)",
    },
    correctIndices: {
      de: "„correctIndices“ als Zahlen-Array",
      ru: "«correctIndices» — массив чисел",
    },
    empty: {
      de: "mind. 1 Frage-Objekt statt leerem Array",
      ru: "хотя бы 1 объект вместо пустого массива",
    },
  };

  const hint = hints[problem];

  if (hint === undefined) return null;

  return locale === "ru" ? hint.ru : hint.de;
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
