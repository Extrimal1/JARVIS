/**
 * Batch-loop tests: multi-batch accumulation, covered-label growth,
 * dedup across batches, failure preservation (a later batch never
 * loses earlier saves), saturation, caps, and cancellation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runQuestionBatches } from "@/src/lib/study/batches";
import type {
  GeneratedQuestionDto,
  QuestionsResponse,
} from "@/src/lib/study/protocol";
import type { QuizQuestion } from "@/src/lib/quiz";

let nextId = 0;

function manualQuestion(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  nextId += 1;

  return {
    id: `q-${nextId}`,
    subject: "BWL",
    examId: null,
    topicId: null,
    question: "Was ist der Zinseszins?",
    options: ["A", "B", "C"],
    correctIndex: 0,
    explanation: "Begründung.",
    documentId: "doc-1",
    source: "ai",
    sourceRefs: ["Seite 1"],
    ...overrides,
  };
}

function dto(question: string, refs: string[]): GeneratedQuestionDto {
  return {
    question,
    options: ["A", "B"],
    correctIndex: 0,
    explanation: "Siehe Skript.",
    kind: "single",
    refs,
  };
}

function response(
  dtos: GeneratedQuestionDto[],
  labels: string[],
): QuestionsResponse {
  return {
    questions: dtos,
    documentId: "doc-1",
    documentName: "Skript.pdf",
    subject: "BWL",
    refsUsed: labels,
    truncated: true,
    chunkCount: 8,
    insufficient: false,
    droppedInvalid: 0,
    partial: false,
    window: { labels, poolSize: 8, truncated: true },
    coverage: { usableUnits: 8, coveredUnits: 0, percent: 0 },
  };
}

function mapResponse(res: QuestionsResponse): QuizQuestion[] {
  return res.questions.map((item) =>
    manualQuestion({ question: item.question, sourceRefs: item.refs }),
  );
}

describe("runQuestionBatches", () => {
  it("accumulates batches and grows the covered labels", async () => {
    const seen: string[][] = [];
    const calls = [
      response([dto("Frage eins?", ["Seite 1"])], ["Seite 1"]),
      response([dto("Frage zwei?", ["Seite 8"])], ["Seite 8"]),
    ];

    const result = await runQuestionBatches({
      existing: [],
      mapResponse,
      maxBatches: 2,
      generate: async (covered) => {
        seen.push([...covered]);

        return calls[seen.length - 1] ?? calls[0]!;
      },
      save: async () => {},
    });

    assert.equal(result.status, "done");
    assert.equal(result.batches, 2);
    assert.equal(result.saved.length, 2);
    assert.deepEqual(seen, [[], ["Seite 1"]]);
  });

  it("dedupes across batches without losing the fresh ones", async () => {
    const calls = [
      response([dto("Frage eins?", ["Seite 1"])], ["Seite 1"]),
      response(
        [dto("Frage eins?", ["Seite 1"]), dto("Frage zwei?", ["Seite 8"])],
        ["Seite 8"],
      ),
    ];
    let index = 0;

    const result = await runQuestionBatches({
      existing: [],
      mapResponse,
      maxBatches: 2,
      generate: async () => calls[index++] ?? calls[0]!,
      save: async () => {},
    });

    assert.equal(result.status, "done");
    assert.equal(result.saved.length, 2);
    assert.equal(result.skippedExact, 1);
  });

  it("preserves earlier saves when a later batch fails to save", async () => {
    let saves = 0;

    const result = await runQuestionBatches({
      existing: [],
      mapResponse,
      maxBatches: 3,
      generate: async (covered) =>
        response(
          [dto(`Frage ${covered.length + 1}?`, [`Seite ${covered.length + 1}`])],
          [`Seite ${covered.length + 1}`],
        ),
      save: async () => {
        saves += 1;

        if (saves >= 2) throw new Error("Cloud-Speichern fehlgeschlagen.");
      },
    });

    assert.equal(result.status, "error");
    assert.equal(result.saved.length, 1);
    assert.equal(result.batches, 2);
    assert.equal(result.error, "Cloud-Speichern fehlgeschlagen.");
  });

  it("preserves earlier saves when generation fails mid-run", async () => {
    let calls = 0;

    const result = await runQuestionBatches({
      existing: [],
      mapResponse,
      maxBatches: 3,
      generate: async () => {
        calls += 1;

        if (calls >= 2) throw new Error("Modell antwortet nicht.");

        return response([dto("Frage eins?", ["Seite 1"])], ["Seite 1"]);
      },
      save: async () => {},
    });

    assert.equal(result.status, "error");
    assert.equal(result.saved.length, 1);
    assert.equal(result.error, "Modell antwortet nicht.");
  });

  it("saturates after two consecutive empty batches", async () => {
    const result = await runQuestionBatches({
      existing: [manualQuestion({ question: "Bekannte Frage?" })],
      mapResponse,
      maxBatches: 5,
      generate: async () =>
        response([dto("Bekannte Frage?", ["Seite 1"])], ["Seite 1"]),
      save: async () => {},
    });

    assert.equal(result.status, "saturated");
    assert.equal(result.batches, 2);
    assert.equal(result.saved.length, 0);
    assert.equal(result.skippedExact, 2);
  });

  it("stops at the saved cap", async () => {
    let calls = 0;

    const result = await runQuestionBatches({
      existing: [],
      mapResponse,
      maxBatches: 5,
      maxSaved: 1,
      generate: async () => {
        calls += 1;

        return response([dto(`Frage ${calls}?`, ["Seite 1"])], ["Seite 1"]);
      },
      save: async () => {},
    });

    assert.equal(result.status, "done");
    assert.equal(result.savedCapReached, true);
    assert.equal(result.saved.length, 1);
    assert.equal(calls, 1);
  });

  it("cancels between batches and keeps the saves", async () => {
    const controller = new AbortController();

    const result = await runQuestionBatches({
      existing: [],
      mapResponse,
      maxBatches: 5,
      signal: controller.signal,
      generate: async () =>
        response([dto("Frage eins?", ["Seite 1"])], ["Seite 1"]),
      save: async () => {},
      onBatch: () => controller.abort(),
    });

    assert.equal(result.status, "cancelled");
    assert.equal(result.saved.length, 1);
  });

  it("reports insufficient material as an error", async () => {
    const result = await runQuestionBatches({
      existing: [],
      mapResponse,
      generate: async () => ({
        ...response([], []),
        insufficient: true,
      }),
      save: async () => {
        assert.fail("must not save without material");
      },
    });

    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /keine auswertbaren Textstellen/);
  });
});
