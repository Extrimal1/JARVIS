#!/usr/bin/env node
/**
 * Live Ollama probe for topic extraction (Phase 4D step 1).
 *
 * Uses the REAL prompt builder + strict parser against your local
 * Ollama (qwen3.5:4b). Run from jarvis/ with Ollama serving:
 *
 *   node --import ./tests/register.mjs scripts/ollama-topic-probe.mjs
 *
 * Exit 0 = extraction + parse + grounding all passed on the live
 * model. Anything else prints diagnostics and exits 1. Mocked unit
 * tests never substitute for this probe.
 */
import { topicExtractionPrompt, parseTopicExtraction } from "@/src/lib/study/topics.ts";

const BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:4b";

const sources = [
  {
    marker: "[Q1]",
    documentName: "Probe.pptx",
    refLabel: "Folie 1",
    text: "Zinsrechnung: Der einfache Zins beträgt Kapital mal Zinssatz mal Laufzeit (K*n*i). Beispiel: 1000 Euro zu 2 % für 3 Jahre.",
  },
  {
    marker: "[Q2]",
    documentName: "Probe.pptx",
    refLabel: "Folie 2",
    text: "Rentenrechnung: Eine nachschüssige Rente zahlt jeweils am Periodenende. Voraussetzung ist die Zinsrechnung.",
  },
];
const usable = [{ kind: "slide", from: 1, to: 2 }];

function fail(message, extra = {}) {
  console.error(`FAIL: ${message}`);

  for (const [key, value] of Object.entries(extra)) {
    console.error(`  ${key}=${value}`);
  }

  process.exit(1);
}

const started = Date.now();
let res;

try {
  res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: "json",
      think: false,
      options: { temperature: 0, num_predict: 2000 },
      messages: topicExtractionPrompt("de", "Probe.pptx", "Folien 1–2", sources),
    }),
    signal: AbortSignal.timeout(120000),
  });
} catch (error) {
  fail("Ollama nicht erreichbar — läuft `ollama serve`?", {
    baseUrl: BASE_URL,
    error: error instanceof Error ? error.message : String(error),
  });
}

if (!res.ok) {
  fail(`Ollama HTTP ${res.status}`, { body: (await res.text()).slice(0, 500) });
}

const payload = await res.json();
const content = payload?.message?.content ?? "";
const thinking = payload?.message?.thinking ?? "";
const durationMs = Date.now() - started;

console.log(
  `diagnostics model=${MODEL} durationMs=${durationMs} ` +
    `doneReason=${payload?.done_reason ?? null} evalCount=${payload?.eval_count ?? null} ` +
    `responseChars=${content.length} thinkingChars=${thinking.length}`,
);

if (payload?.done_reason === "length") {
  fail("Token-Limit erreicht (done_reason=length) — Budget prüfen.", {
    evalCount: payload?.eval_count ?? null,
  });
}

if (content.trim() === "") {
  fail("Leere Antwort trotz done_reason=stop.", {
    raw: JSON.stringify(payload).slice(0, 500),
  });
}

let parsed;

try {
  parsed = parseTopicExtraction(content, sources, usable);
} catch (error) {
  console.error("--- raw response (1000 chars) ---");
  console.error(content.slice(0, 1000));
  console.error("--- end raw response ---");
  fail("Strikter Parser hat die Live-Antwort abgelehnt.", {
    error: error instanceof Error ? error.message : String(error),
  });
}

if (parsed.topics.length === 0) {
  fail("Keine geerdeten Themen in der Live-Antwort.", {
    droppedInvalid: parsed.droppedInvalid,
    droppedUngrounded: parsed.droppedUngrounded,
  });
}

console.log(
  `PASS: ${parsed.topics.length} Thema/Themen, ` +
    `droppedInvalid=${parsed.droppedInvalid} droppedUngrounded=${parsed.droppedUngrounded}`,
);
console.log(JSON.stringify(parsed.topics[0], null, 2));
