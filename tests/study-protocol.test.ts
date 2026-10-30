/**
 * Study protocol tests: error→status mapping, budget fitting,
 * excerpts, prompt contracts, and the shared grounded-answer
 * orchestration (validate → repair → strip).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  excerptOf,
  isExplainResponse,
  isProcessResponse,
  isRetrieveResponse,
  isSummarizeResponse,
  processResponseOfExtractError,
} from "@/src/lib/study/protocol";
import { ExtractError } from "@/src/lib/study/extract";
import {
  explainPrompt,
  fitSourcesToBudget,
  retrievalInstruction,
  summaryPrompt,
} from "@/src/lib/study/prompts";
import { groundedAnswer } from "@/src/lib/study/grounding";

describe("processResponseOfExtractError", () => {
  it("maps scanned/unknown kinds to unsupported", () => {
    assert.deepEqual(
      processResponseOfExtractError(new ExtractError("scanned", "OCR fehlt.")),
      {
        status: "unsupported",
        chunks: 0,
        blocks: 0,
        warnings: [],
        message: "OCR fehlt.",
      },
    );
    assert.equal(
      processResponseOfExtractError(
        new ExtractError("unsupported-kind", "Nein."),
      ).status,
      "unsupported",
    );
  });

  it("maps broken input to failed", () => {
    for (const code of [
      "corrupt",
      "encrypted",
      "empty",
      "too-large",
      "unsupported-content",
    ] as const) {
      const response = processResponseOfExtractError(
        new ExtractError(code, "Kaputt."),
      );

      assert.equal(response.status, "failed");
      assert.equal(response.message, "Kaputt.");
    }
  });
});

describe("fitSourcesToBudget", () => {
  it("fits from the front and reports truncation", () => {
    const items = [
      { text: "a".repeat(100) },
      { text: "b".repeat(100) },
      { text: "c".repeat(100) },
    ];

    assert.deepEqual(fitSourcesToBudget(items, 1000), {
      included: items,
      truncated: false,
    });
    assert.deepEqual(fitSourcesToBudget(items, 150), {
      included: [items[0]],
      truncated: true,
    });
  });

  it("always keeps the first item", () => {
    const items = [{ text: "x".repeat(500) }];

    assert.deepEqual(fitSourcesToBudget(items, 10), {
      included: items,
      truncated: false,
    });
  });
});

describe("excerptOf", () => {
  it("cuts at word boundaries", () => {
    assert.equal(excerptOf("kurz", 100), "kurz");
    assert.equal(excerptOf("eins zwei drei vier", 10), "eins zwei …");
  });
});

describe("protocol guards", () => {
  it("validates response shapes", () => {
    assert.equal(
      isRetrieveResponse({ chunks: [], totalCandidates: 0, terms: ["a"] }),
      true,
    );
    assert.equal(isRetrieveResponse({ chunks: [{}] }), false);
    assert.equal(
      isProcessResponse({
        status: "completed",
        chunks: 1,
        blocks: 2,
        warnings: [],
        message: "ok",
      }),
      true,
    );
    assert.equal(
      isProcessResponse({ status: "fertig", chunks: 1 }),
      false,
    );
    assert.equal(
      isSummarizeResponse({
        summary: "s",
        documentName: "d",
        refsUsed: ["Seite 1"],
        truncated: false,
        chunkCount: 3,
      }),
      true,
    );
    assert.equal(isSummarizeResponse({ summary: "s" }), false);
    assert.equal(
      isExplainResponse({
        answer: "a",
        documentName: "d",
        refsUsed: [],
        insufficient: true,
      }),
      true,
    );
    assert.equal(isExplainResponse(null), false);
  });
});

describe("study prompts", () => {
  const sources = [
    {
      marker: "[Q1]",
      documentName: "Skript.pdf",
      refLabel: "Seite 3",
      text: "Der Citratzyklus läuft in den Mitochondrien ab.",
    },
  ];

  it("grounds summaries in numbered sources (de/ru)", () => {
    const de = summaryPrompt("de", "Skript.pdf", sources, false);
    const ru = summaryPrompt("ru", "Skript.pdf", sources, true);

    assert.match(de[1]?.content ?? "", /\[Q1\] \(Skript\.pdf, Seite 3\)/);
    assert.match(de[1]?.content ?? "", /Zusammenfassung/);
    assert.match(ru[1]?.content ?? "", /конспект/);
    assert.match(ru[1]?.content ?? "", /первые отрывки/);
  });

  it("grounds explanations in the question + sources", () => {
    const messages = explainPrompt("de", "Skript.pdf", "Wo läuft was?", sources);

    assert.match(messages[0]?.content ?? "", /\[Qn\]/);
    assert.match(messages[1]?.content ?? "", /Wo läuft was\?/);
    assert.match(messages[1]?.content ?? "", /Citratzyklus/);
  });

  it("instructs honest insufficiency when sources are missing", () => {
    assert.match(retrievalInstruction("de", true), /nichts enthalten/);
    assert.match(retrievalInstruction("ru", true), /ничего подходящего/);
    assert.match(retrievalInstruction("de", false), /\[Qn\]/);
  });
});

describe("groundedAnswer", () => {
  const sources = [
    { marker: "[Q1]", documentName: "d", refLabel: "Seite 1" },
  ];

  it("returns valid first answers untouched", async () => {
    let calls = 0;
    const result = await groundedAnswer(
      async () => {
        calls += 1;

        return "Gut [Q1].";
      },
      [{ role: "system", content: "s" }],
      sources,
      "de",
    );

    assert.deepEqual(result, { text: "Gut [Q1].", stripped: [] });
    assert.equal(calls, 1);
  });

  it("repairs once, then strips with a note", async () => {
    const answers = ["Schlecht [Q4].", "Immer noch [Q5]."];
    const seen: string[][] = [];
    const result = await groundedAnswer(
      async (messages) => {
        seen.push(messages.map((message) => message.content));

        return answers[Math.min(seen.length - 1, 1)] ?? "";
      },
      [{ role: "system", content: "s" }],
      sources,
      "ru",
    );

    assert.equal(seen.length, 2);
    assert.match(seen[1]?.join("\n") ?? "", /\[Q4\]/);
    assert.ok(!(result.text.split("Примечание:")[0] ?? "").includes("[Q"));
    assert.deepEqual(result.stripped, [5]);
  });
});
