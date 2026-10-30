/**
 * Server-side model adapter for assistant understanding.
 *
 * One narrow interface: text in, validated `AssistantPlan` out.
 * Providers never touch user data and never execute anything — they
 * only propose, the executor (client) validates and runs.
 *
 * - `ollama`: local chat model via the central LLM service
 *   (`./llm`). The default engine; model output is parsed AND
 *   validated — malformed plans become a German error, never an
 *   invented action.
 * - `heuristic`: built-in deterministic DE/RU parser. Explicit
 *   opt-in only (`ASSISTANT_PROVIDER=heuristic`), honestly labeled
 *   "Lokales Regelwerk" in the UI. It never silently replaces the
 *   LLM: Ollama failures surface as errors, never as quiet
 *   rule-based answers.
 *
 * SERVER-ONLY: reads server env (base URL, model name). The client
 * only learns the provider id + configured flag via GET /api/assistant.
 */

import {
  extractJsonPayload,
  isAssistantPlan,
  type NluContext,
} from "./actions";
import {
  chatWithOllama,
  LLM_NOT_CONFIGURED_MESSAGE,
  ollamaEnv,
  ProviderError,
} from "./llm";
import { parseCommand, type ParseResult } from "./nlu";

export type { ProviderCode } from "./llm";
export { isProviderError, ProviderError } from "./llm";

export type ProviderId = "heuristic" | "ollama";

export type NluProvider = {
  id: ProviderId;
  parse: (text: string, ctx: NluContext) => Promise<ParseResult>;
};

// -------------------------------------------------------------- heuristic

export const heuristicProvider: NluProvider = {
  id: "heuristic",
  parse: async (text: string, ctx: NluContext): Promise<ParseResult> =>
    parseCommand(text, ctx),
};

// ------------------------------------------------------------------ ollama

const OLLAMA_SYSTEM = `Du bist die Verstehens-Komponente von J.A.R.V.I.S., einem persönlichen Assistenten. Antworte AUSSCHLIESSLICH mit einem JSON-Objekt (kein Markdown, kein Fließtext), das exakt einem dieser Pläne entspricht:

{"type":"calendar.create","event":{"title":"...","date":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","type":"personal|lecture|exam","description":"","location":""}}
{"type":"calendar.list","from":"YYYY-MM-DD","to":"YYYY-MM-DD","label":"..."}
{"type":"calendar.update","ref":{"titleQuery":"..."},"patch":{"date?":"YYYY-MM-DD","start?":"HH:MM","end?":"HH:MM","title?":"..."}}
{"type":"calendar.delete","ref":{"titleQuery":"..."}}
{"type":"finance.create","transaction":{"title":"...","amountCents":2450,"type":"expense|income","category":"...","date":"YYYY-MM-DD","currency":"EUR","note":""}}
{"type":"finance.list","limit":10}
{"type":"finance.summary","monthKey":"YYYY-MM"|null,"from":"YYYY-MM-DD"|null,"to":"YYYY-MM-DD"|null,"category":"..."|null,"label":"..."}
{"type":"clarify","question":"...","options":[{"label":"...","text":"..."}]}
{"type":"unsupported","message":"..."}

Regeln: Heute ist {today}, lokale Uhrzeit {now}, Sprache {lang}. Relative Daten ("morgen", "nächste Woche", "завтра") löst du gegen Heute auf. Deutsche Beträge ("24,50") werden zu Cent. Ende liegt nach Beginn. Bei fehlenden oder mehrdeutigen Angaben (Datum, Uhrzeit, Betrag, Termin) gib "clarify" mit einer kurzen deutschen Frage zurück — erfinde NIEMALS Werte. Kategorien für Ausgaben: Lebensmittel, Miete, Transport, Freizeit, Studium, Gesundheit, Abos, Umbuchung, Sonstiges. Für Einnahmen: Gehalt, Stipendium, Nebenjob, Erstattung, Sonstiges. Unverständliche Eingaben → "unsupported" mit kurzer deutscher Hilfe.`;

async function parseWithOllama(
  text: string,
  ctx: NluContext,
): Promise<ParseResult> {
  const env = ollamaEnv();

  if (env === null) {
    throw new ProviderError("not-configured", LLM_NOT_CONFIGURED_MESSAGE);
  }

  const system = OLLAMA_SYSTEM.replace("{today}", ctx.todayISO)
    .replace("{now}", ctx.nowTime)
    .replace("{lang}", ctx.locale === "ru" ? "Russisch" : "Deutsch");

  const result = await chatWithOllama(
    [
      { role: "system", content: system },
      { role: "user", content: text },
    ],
    {
      model: env.model,
      baseUrl: env.baseUrl,
      format: "json",
      think: false,
      temperature: 0,
      numPredict: 800,
    },
  );

  let content: unknown;

  try {
    content = JSON.parse(extractJsonPayload(result.content)) as unknown;
  } catch {
    throw new ProviderError(
      "malformed",
      "Das KI-Modell hat eine ungültige Antwort geliefert. Versuche es erneut oder formuliere kürzer.",
    );
  }

  if (!isAssistantPlan(content)) {
    throw new ProviderError(
      "invalid-plan",
      "Das KI-Modell hat einen ungültigen Aktionsplan geliefert. Es wurde nichts ausgeführt.",
    );
  }

  return { plan: content, locale: ctx.locale };
}

export const ollamaProvider: NluProvider = {
  id: "ollama",
  parse: parseWithOllama,
};

// --------------------------------------------------------------- selection

export function selectProvider(): NluProvider {
  const configured = (process.env.ASSISTANT_PROVIDER ?? "").trim().toLowerCase();

  if (configured === "heuristic") return heuristicProvider;

  if (configured !== "" && configured !== "ollama") {
    console.warn(
      `[assistant] Unknown ASSISTANT_PROVIDER="${configured}", using ollama.`,
    );
  }

  return ollamaProvider;
}

export type ProviderStatus = {
  provider: ProviderId;
  /** False when Ollama is selected but no model is configured. */
  configured: boolean;
};

/** Safe for the client: no URLs, no keys, no model internals. */
export function providerStatus(): ProviderStatus {
  const provider = selectProvider();

  if (provider.id === "ollama") {
    return { provider: "ollama", configured: ollamaEnv() !== null };
  }

  return { provider: "heuristic", configured: true };
}
