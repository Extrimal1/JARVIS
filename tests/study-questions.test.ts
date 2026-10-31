/**
 * Study-question tests: grounded generation contract, strict JSON
 * parsing (never heuristic fallback), dedup, persistence mapping,
 * and SM-2-inspired review scheduling for Übungsfragen.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  questionPrompt,
  questionsRepairPrompt,
} from "@/src/lib/study/prompts";
import {
  ProviderError,
  type LlmChatResult,
} from "@/src/lib/assistant/llm";
import {
  QuestionsParseError,
  QuestionsTruncatedError,
  assertCompleteQuestions,
  filterNewQuestions,
  parseGeneratedQuestions,
  parseQuestionsWithRepair,
  questionKey,
  toQuizQuestions,
} from "@/src/lib/study/questions";
import {
  QUIZ_INTERVAL_LADDER,
  getQuizReviewInfo,
  scheduleQuizReview,
} from "@/src/lib/quizReview";
import {
  isQuestionsResponse,
  type QuestionsResponse,
} from "@/src/lib/study/protocol";
import {
  isQuizQuestion,
  isQuizQuestionList,
  type QuizQuestion,
} from "@/src/lib/quiz";
import {
  quizConfig,
  quizRowToDomain,
  quizToDbRow,
} from "@/src/lib/api/modules/quiz";
import {
  generateStudyQuestions,
  validQuestionsInput,
} from "@/src/lib/api/modules/studyIntel";
import { dbFor } from "@/src/lib/supabase/db";

const DB = dbFor(
  { url: "https://supabase.test", anonKey: "anon" },
  "token",
  "user-1",
);

const SOURCES = [
  { marker: "[Q1]", refLabel: "Seite 3" },
  { marker: "[Q2]", refLabel: "Seite 4" },
];

const SOURCES_FULL = [
  {
    marker: "[Q1]",
    documentName: "Skript.pdf",
    refLabel: "Seite 3",
    text: "Der Citratzyklus läuft in den Mitochondrien ab.",
  },
  {
    marker: "[Q2]",
    documentName: "Skript.pdf",
    refLabel: "Seite 4",
    text: "Die Glykolyse spaltet Glukose.",
  },
];

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const realLog = console.log;

  console.log = ((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as typeof console.log;

  return {
    lines,
    restore: () => {
      console.log = realLog;
    },
  };
}

function manualQuestion(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: "q-1",
    subject: "Biologie",
    examId: null,
    topicId: null,
    question: "Wo läuft der Citratzyklus ab?",
    options: ["Mitochondrien", "Zellkern", "Ribosomen"],
    correctIndex: 0,
    explanation: "Der Citratzyklus läuft in den Mitochondrien ab.",
    ...overrides,
  };
}

// ------------------------------------------------------------------ prompt

describe("questionPrompt", () => {
  it("demands strict grounded JSON with mixed kinds and citations", () => {
    const messages = questionPrompt("de", "Skript.pdf", [
      {
        marker: "[Q1]",
        documentName: "Skript.pdf",
        refLabel: "Seite 3",
        text: "Der Citratzyklus läuft in den Mitochondrien ab.",
      },
    ], 6);

    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "system");
    assert.equal(messages[1]?.role, "user");

    const user = messages[1]?.content ?? "";
    assert.match(user, /JSON/);
    assert.match(user, /\[Qn\]/);
    assert.match(user, /Skript\.pdf/);
    assert.match(user, /Mitochondrien/);
    assert.match(user, /erfinde/i);
  });

  it("supports the Russian locale with the same contract", () => {
    const messages = questionPrompt("ru", "Doc.pdf", [], 4);
    const blob = messages.map((message) => message.content).join("\n");

    assert.match(blob, /JSON/);
    assert.match(blob, /\[Qn\]/);
  });

  it("forbids prose outright and names the valid marker range", () => {
    const messages = questionPrompt("de", "Skript.pdf", [
      {
        marker: "[Q1]",
        documentName: "Skript.pdf",
        refLabel: "Seite 3",
        text: "Der Citratzyklus läuft in den Mitochondrien ab.",
      },
      {
        marker: "[Q2]",
        documentName: "Skript.pdf",
        refLabel: "Seite 4",
        text: "Die Glykolyse spaltet Glukose.",
      },
    ], 6);
    const blob = messages.map((message) => message.content).join("\n");

    assert.match(blob, /AUSSCHLIESSLICH/);
    assert.match(blob, /\[Q1\]…\[Q2\]/);
    assert.match(blob, /Beispiel/);
  });

  it("demands a bracketed array and forbids single objects", () => {
    const messages = questionPrompt("de", "Skript.pdf", SOURCES_FULL, 6);
    const blob = messages.map((message) => message.content).join("\n");

    assert.match(blob, /Beginne deine Antwort mit/);
    assert.match(blob, /NIEMALS ein einzelnes Objekt/);
    assert.match(blob, /mit 6 Objekten/);
  });
});

describe("questionsRepairPrompt", () => {
  it("restates the JSON-only contract with the valid range", () => {
    const prompt = questionsRepairPrompt("de", 3);

    assert.match(prompt, /AUSSCHLIESSLICH/);
    assert.match(prompt, /JSON-Array/);
    assert.match(prompt, /\[Q1\]…\[Q3\]/);
    assert.match(prompt, /Erfinde nichts/);
  });

  it("supports the Russian locale", () => {
    assert.match(questionsRepairPrompt("ru", 1), /JSON-массивом/);
  });
});

// ------------------------------------------------------------------ parsing

describe("parseGeneratedQuestions", () => {
  it("parses a plain JSON array and resolves refs to labels", () => {
    const parsed = parseGeneratedQuestions(
      JSON.stringify([
        {
          question: "Wo läuft der Citratzyklus ab?",
          options: ["Mitochondrien", "Zellkern"],
          correctIndex: 0,
          explanation: "Siehe Skript.",
          kind: "single",
          refs: ["[Q1]"],
        },
      ]),
      SOURCES,
    );

    assert.equal(parsed.droppedInvalid, 0);
    assert.equal(parsed.questions.length, 1);
    assert.deepEqual(parsed.questions[0]?.refs, ["Seite 3"]);
  });

  it("accepts fenced code blocks and wrapper objects", () => {
    const item = {
      question: "Wahr oder falsch: Die Glykolyse spaltet Glukose.",
      options: ["Wahr", "Falsch"],
      correctIndex: 0,
      explanation: "Richtig.",
      kind: "single",
      refs: ["[Q2]"],
    };

    const fenced = parseGeneratedQuestions(
      `Hier sind die Fragen:\n\`\`\`json\n${JSON.stringify([item])}\n\`\`\``,
      SOURCES,
    );
    assert.equal(fenced.questions.length, 1);

    const wrapped = parseGeneratedQuestions(
      JSON.stringify({ questions: [item] }),
      SOURCES,
    );
    assert.equal(wrapped.questions.length, 1);

    const repaired = parseGeneratedQuestions(
      JSON.stringify({ final: JSON.stringify([item]) }),
      SOURCES,
    );
    assert.equal(repaired.questions.length, 1);
  });

  it("throws instead of inventing questions when no JSON exists", () => {
    assert.throws(
      () => parseGeneratedQuestions("Leider keine Fragen heute.", SOURCES),
      (error: unknown) =>
        error instanceof QuestionsParseError &&
        /keine lesbaren Fragen/i.test(error.message),
    );
  });

  it("drops invalid items and strips fabricated citations", () => {
    const parsed = parseGeneratedQuestions(
      JSON.stringify([
        {
          question: "Gültige Frage mit erfundener Quelle?",
          options: ["Ja", "Nein"],
          correctIndex: 0,
          explanation: "",
          kind: "single",
          refs: ["[Q1]", "[Q9]"],
        },
        {
          question: "Zu kurz",
          options: ["Nur eine Option"],
          correctIndex: 0,
          explanation: "",
          kind: "single",
          refs: [],
        },
        {
          question: "",
          options: ["A", "B"],
          correctIndex: 5,
          explanation: "",
          kind: "single",
          refs: [],
        },
      ]),
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
    assert.deepEqual(parsed.questions[0]?.refs, ["Seite 3"]);
    assert.equal(parsed.droppedInvalid, 2);
  });

  it("normalizes multiple-choice and free kinds safely", () => {
    const parsed = parseGeneratedQuestions(
      JSON.stringify([
        {
          question: "Welche Aussagen treffen auf die Mitose zu?",
          options: ["Aussage A", "Aussage B", "Aussage C"],
          correctIndex: 0,
          explanation: "A und C sind korrekt.",
          kind: "multiple",
          correctIndices: [0, 2, 2, 9],
          refs: [],
        },
        {
          question: "Erkläre den Unterschied zwischen Mitose und Meiose.",
          options: ["Musterlösung", "Siehe Erklärung"],
          correctIndex: 0,
          explanation: "Ausführliche Lösung.",
          kind: "free",
          gradingCriteria: "Je ein Punkt für Definition und Unterschied.",
          refs: [],
        },
      ]),
      SOURCES,
    );

    assert.equal(parsed.questions.length, 2);
    assert.deepEqual(parsed.questions[0]?.correctIndices, [0, 2]);
    assert.equal(parsed.questions[1]?.gradingCriteria?.includes("Punkt"), true);
  });

  it("drops within-batch duplicates", () => {
    const item = {
      question: "Wo läuft der Citratzyklus ab?",
      options: ["Mitochondrien", "Zellkern"],
      correctIndex: 0,
      explanation: "",
      kind: "single",
      refs: [],
    };

    const parsed = parseGeneratedQuestions(
      JSON.stringify([item, { ...item, refs: ["[Q1]"] }]),
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.droppedInvalid, 1);
  });

  it("tolerates unfenced explanatory prose around the array", () => {
    const parsed = parseGeneratedQuestions(
      `Gerne! Hier sind deine Fragen:\n${JSON.stringify([
        {
          question: "Wo läuft der Citratzyklus ab?",
          options: ["Mitochondrien", "Zellkern"],
          correctIndex: 0,
          explanation: "Siehe Skript.",
          kind: "single",
          refs: ["[Q1]"],
        },
      ])}\nViel Erfolg beim Lernen!`,
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.droppedInvalid, 0);
  });

  it("rejects unexpected JSON structures", () => {
    for (const raw of [
      JSON.stringify({ foo: 1 }),
      JSON.stringify({ questions: "keine" }),
      JSON.stringify("nur ein String"),
      JSON.stringify(42),
    ]) {
      assert.throws(
        () => parseGeneratedQuestions(raw, SOURCES),
        (error: unknown) => error instanceof QuestionsParseError,
      );
    }
  });

  it("rejects empty responses", () => {
    for (const raw of ["", "   ", "\n\n"]) {
      assert.throws(
        () => parseGeneratedQuestions(raw, SOURCES),
        (error: unknown) =>
          error instanceof QuestionsParseError &&
          /keine lesbaren Fragen/i.test(error.message),
      );
    }
  });

  it("rejects truncated JSON instead of guessing items", () => {
    const full = JSON.stringify([
      {
        question: "Wo läuft der Citratzyklus ab?",
        options: ["Mitochondrien", "Zellkern"],
        correctIndex: 0,
        explanation: "Siehe Skript.",
        kind: "single",
        refs: ["[Q1]"],
      },
    ]);

    assert.throws(
      () => parseGeneratedQuestions(full.slice(0, 80), SOURCES),
      (error: unknown) => error instanceof QuestionsParseError,
    );
  });

  it("strips fabricated citations from every text field", () => {
    const parsed = parseGeneratedQuestions(
      JSON.stringify([
        {
          question: "Wo läuft [Q9] der Citratzyklus [Q1] ab?",
          options: ["Mitochondrien [Q2]", "Zellkern [Q7]"],
          correctIndex: 0,
          explanation: "Siehe [Q1] und [Q5].",
          kind: "single",
          gradingCriteria: undefined,
          refs: ["[Q1]"],
        },
      ]),
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
    const item = parsed.questions[0]!;
    assert.equal(item.question.includes("[Q9]"), false);
    assert.equal(item.question.includes("[Q1]"), true);
    assert.equal(item.options[0], "Mitochondrien [Q2]");
    assert.equal(item.options[1], "Zellkern");
    assert.equal(item.explanation.includes("[Q5]"), false);
    assert.equal(item.explanation.includes("[Q1]"), true);
  });

  it("accepts the minimal questions-wrapper schema", () => {
    const parsed = parseGeneratedQuestions(
      JSON.stringify({
        questions: [
          {
            type: "single",
            question: "Example question?",
            options: ["A", "B", "C"],
            correctAnswer: 0,
            explanation: "Explanation based on the source.",
            sourceRefs: ["Q1"],
          },
        ],
      }),
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.droppedInvalid, 0);
    assert.equal(parsed.questions[0]?.correctIndex, 0);
    assert.deepEqual(parsed.questions[0]?.refs, ["Seite 3"]);
  });

  it("accepts alias fields in bare arrays", () => {
    const parsed = parseGeneratedQuestions(
      JSON.stringify([
        {
          type: "multiple",
          question: "Welche Aussagen treffen hier zu bitte?",
          options: ["Aussage A", "Aussage B", "Aussage C"],
          correctAnswer: [0, 2],
          explanation: "A und C sind korrekt.",
          sourceRefs: ["q2"],
        },
      ]),
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.questions[0]?.kind, "multiple");
    assert.deepEqual(parsed.questions[0]?.correctIndices, [0, 2]);
    assert.equal(parsed.questions[0]?.correctIndex, 0);
    assert.deepEqual(parsed.questions[0]?.refs, ["Seite 4"]);
  });

  it("extracts an array followed by bracketed prose", () => {
    const parsed = parseGeneratedQuestions(
      `${JSON.stringify([
        {
          question: "Wo läuft der Citratzyklus ab hier bitte?",
          options: ["Mitochondrien", "Zellkern"],
          correctIndex: 0,
          explanation: "Siehe Skript [Q1].",
          kind: "single",
          refs: ["[Q1]"],
        },
      ])}\nQuellen: [Q1], [Q2].`,
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.droppedInvalid, 0);
  });

  it("extracts an array after bracketed prose", () => {
    const parsed = parseGeneratedQuestions(
      `Siehe [Q1] und [Q2]:\n${JSON.stringify([
        {
          question: "Wo läuft der Citratzyklus ab hier bitte?",
          options: ["Mitochondrien", "Zellkern"],
          correctIndex: 0,
          explanation: "Siehe Skript.",
          kind: "single",
          refs: [],
        },
      ])}`,
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
  });

  it("extracts a prose-wrapped questions object", () => {
    const parsed = parseGeneratedQuestions(
      `Hier sind die Fragen:\n${JSON.stringify({
        questions: [
          {
            question: "Wo läuft der Citratzyklus ab hier bitte?",
            options: ["Mitochondrien", "Zellkern"],
            correctIndex: 0,
            explanation: "Siehe Skript.",
            kind: "single",
            refs: [],
          },
        ],
      })}\nViel Erfolg!`,
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
  });

  it("rejects prose-only answers as no-JSON", () => {
    assert.throws(
      () =>
        parseGeneratedQuestions(
          "Basierend auf den Textstellen lassen sich zum Citratzyklus mehrere Prüfungsfragen formulieren. Die Mitochondrien spielen dabei eine zentrale Rolle, ebenso die Glykolyse im Zytoplasma. Eine ausführliche Begründung folgt im Unterricht.",
          SOURCES,
        ),
      (error: unknown) =>
        error instanceof QuestionsParseError &&
        error.jsonFound === false,
    );
  });

  it("parses the exact live single-object response", () => {
    const parsed = parseGeneratedQuestions(
      `{
  "question": "Welche der folgenden Bereiche werden in der Finanzmathematik betrachtet?",
  "options": [
    "Nur die Zinsrechnung",
    "Nur die Rentenrechnung",
    "Die Zins-, Renten- und Tilgungsrechnung",
    "Keiner der oben genannten"
  ],
  "correctIndex": 2,
  "explanation": "In der Finanzmathematik werden die drei Bereiche Zinsrechnung (Kapitel 1.2), Rentenrechnung (Kapitel 1.3) und Tilgungsrechnung (Kapitel 1.4) betrachtet [Q1].",
  "kind": "single",
  "refs": ["[Q1]"]
}`,
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.droppedInvalid, 0);

    const item = parsed.questions[0]!;
    assert.equal(item.correctIndex, 2);
    assert.equal(item.options.length, 4);
    assert.deepEqual(item.refs, ["Seite 3"]);
    assert.equal(item.explanation.includes("[Q1]"), true);
  });

  it("parses a prose-wrapped single object without duplicating", () => {
    const parsed = parseGeneratedQuestions(
      `Hier ist die Frage:\n${JSON.stringify({
        question: "Wo läuft der Citratzyklus ab hier bitte?",
        options: ["Mitochondrien", "Zellkern"],
        correctIndex: 0,
        explanation: "Siehe Skript.",
        kind: "single",
        refs: ["[Q1]"],
      })}\nQuellen: [Q1].`,
      SOURCES,
    );

    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.droppedInvalid, 0);
  });

  it("rejects scalar-only arrays after real candidates", () => {
    try {
      parseGeneratedQuestions(`["a", "b"]`, SOURCES);
      assert.fail("expected a QuestionsParseError");
    } catch (error: unknown) {
      assert.ok(error instanceof QuestionsParseError);
      assert.equal(error.jsonFound, true);
      assert.deepEqual(error.reasons, ["item", "item"]);
    }
  });

  it("reports an empty array as a declined generation", () => {
    assert.throws(
      () => parseGeneratedQuestions("[]", SOURCES),
      (error: unknown) =>
        error instanceof QuestionsParseError &&
        /keine Fragen zu diesem Dokument/.test(error.message) &&
        error.jsonFound === true,
    );
  });

  it("names the failing fields when every item is invalid", () => {
    try {
      parseGeneratedQuestions(
        JSON.stringify([
          {
            question: "Wo läuft der Citratzyklus ab hier?",
            options: ["Mitochondrien", "Zellkern"],
            correctAnswer: "erste",
            explanation: "",
          },
          {
            question: "Was spaltet die Glykolyse hier auf?",
            options: ["Nur eine Option"],
            correctIndex: 0,
            explanation: "",
          },
        ]),
        SOURCES,
      );
      assert.fail("expected a QuestionsParseError");
    } catch (error: unknown) {
      assert.ok(error instanceof QuestionsParseError);
      assert.equal(error.jsonFound, true);
      assert.deepEqual(error.reasons, ["correctIndex", "options"]);
      assert.match(error.message, /correctIndex/);
      assert.match(error.message, /options/);
    }
  });
});

describe("parseQuestionsWithRepair", () => {
  const MESSAGES = [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "fragen" },
  ];

  const VALID = JSON.stringify([
    {
      question: "Wo läuft der Citratzyklus ab?",
      options: ["Mitochondrien", "Zellkern"],
      correctIndex: 0,
      explanation: "Siehe Skript [Q1].",
      kind: "single",
      refs: ["[Q1]"],
    },
  ]);

  it("returns first-attempt output without a repair round", async () => {
    let calls = 0;

    const parsed = await parseQuestionsWithRepair(
      async () => {
        calls += 1;
        return VALID;
      },
      MESSAGES,
      SOURCES,
      "de",
    );

    assert.equal(calls, 1);
    assert.equal(parsed.repaired, false);
    assert.equal(parsed.questions.length, 1);
    assert.equal(parsed.responseChars, VALID.length);
  });

  it("repairs malformed output with one JSON-only round", async () => {
    const seen: string[][] = [];

    const parsed = await parseQuestionsWithRepair(
      async (messages) => {
        seen.push(messages.map((message) => message.content));

        return seen.length === 1 ? "Leider keine Fragen heute." : VALID;
      },
      MESSAGES,
      SOURCES,
      "de",
    );

    assert.equal(seen.length, 2);
    assert.equal(parsed.repaired, true);
    assert.equal(parsed.questions.length, 1);
    // Repair conversation: original + faulty draft + JSON-only prompt.
    assert.equal(seen[1]?.length, 4);
    assert.match(seen[1]?.[3] ?? "", /AUSSCHLIESSLICH/);
    assert.match(seen[1]?.[3] ?? "", /\[Q1\]…\[Q2\]/);
  });

  it("fails honestly after a failed repair attempt", async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        parseQuestionsWithRepair(
          async () => {
            calls += 1;
            return calls === 1 ? "Prosa statt JSON." : "{ abgeschnitten";
          },
          MESSAGES,
          SOURCES,
          "de",
        ),
      (error: unknown) =>
        error instanceof QuestionsParseError &&
        /Korrekturversuch/.test(error.message),
    );

    assert.equal(calls, 2);
  });

  it("validates citations in repaired output", async () => {
    const dirty = JSON.stringify([
      {
        question: "Wo läuft [Q9] der Citratzyklus ab?",
        options: ["Mitochondrien", "Zellkern"],
        correctIndex: 0,
        explanation: "Siehe [Q1] und [Q8].",
        kind: "single",
        refs: ["[Q1]", "[Q9]"],
      },
    ]);

    const parsed = await parseQuestionsWithRepair(
      async (messages) =>
        messages.length === 2 ? "kein JSON" : dirty,
      MESSAGES,
      SOURCES,
      "de",
    );

    assert.equal(parsed.repaired, true);
    assert.deepEqual(parsed.questions[0]?.refs, ["Seite 3"]);
    assert.equal(parsed.questions[0]?.question.includes("[Q9]"), false);
    assert.equal(
      parsed.questions[0]?.explanation.includes("[Q8]"),
      false,
    );
    assert.equal(
      parsed.questions[0]?.explanation.includes("[Q1]"),
      true,
    );
  });

  it("tells the repair round which fields failed", async () => {
    const seen: string[][] = [];

    const parsed = await parseQuestionsWithRepair(
      async (messages) => {
        seen.push(messages.map((message) => message.content));

        return seen.length === 1
          ? JSON.stringify([
              {
                question: "Wo läuft der Citratzyklus ab hier?",
                options: ["Mitochondrien", "Zellkern"],
                correctAnswer: "erste",
                explanation: "",
              },
            ])
          : JSON.stringify([
              {
                question: "Wo läuft der Citratzyklus ab hier?",
                options: ["Mitochondrien", "Zellkern"],
                correctIndex: 0,
                explanation: "",
              },
            ]);
      },
      MESSAGES,
      SOURCES,
      "de",
    );

    assert.equal(parsed.repaired, true);
    assert.equal(parsed.questions.length, 1);
    assert.match(seen[1]?.[3] ?? "", /correctIndex/);
  });

  it("passes through non-parse errors without a repair round", async () => {
    let calls = 0;

    await assert.rejects(
      () =>
        parseQuestionsWithRepair(
          async () => {
            calls += 1;
            throw new Error("Netzwerk weg.");
          },
          MESSAGES,
          SOURCES,
          "de",
        ),
      /Netzwerk weg/,
    );

    assert.equal(calls, 1);
  });
});

// ------------------------------------------------------------ mapping/dedup

describe("assertCompleteQuestions", () => {
  function meta(overrides: Partial<LlmChatResult> = {}): LlmChatResult {
    return {
      content: "[]",
      model: "qwen3.5:4b",
      doneReason: "stop",
      evalCount: 10,
      thinkingChars: 0,
      ...overrides,
    };
  }

  it("rejects token exhaustion without parsing", () => {
    assert.throws(
      () =>
        assertCompleteQuestions(
          meta({ content: "", doneReason: "length", evalCount: 300, thinkingChars: 4200 }),
        ),
      (error: unknown) =>
        error instanceof QuestionsTruncatedError &&
        /abgeschnitten/.test(error.message) &&
        /length/.test(error.message) &&
        error.doneReason === "length" &&
        error.evalCount === 300,
    );
  });

  it("rejects empty content with only thinking", () => {
    assert.throws(
      () =>
        assertCompleteQuestions(
          meta({ content: "  ", doneReason: "stop", evalCount: 45, thinkingChars: 1200 }),
        ),
      (error: unknown) =>
        error instanceof QuestionsTruncatedError &&
        /leere Antwort/.test(error.message) &&
        /1200/.test(error.message),
    );
  });

  it("accepts complete generations", () => {
    assert.doesNotThrow(() => assertCompleteQuestions(meta()));
  });
});

describe("question mapping and dedup", () => {
  it("maps generated items to labelled AI questions with review defaults", () => {
    const mapped = toQuizQuestions(
      [
        {
          question: "Wo läuft der Citratzyklus ab?",
          options: ["Mitochondrien", "Zellkern"],
          correctIndex: 0,
          explanation: "Siehe Skript.",
          kind: "single",
          refs: ["Seite 3"],
        },
      ],
      { documentId: "doc-1", subject: "Biologie" },
    );

    assert.equal(mapped.length, 1);
    const item = mapped[0]!;
    assert.equal(item.source, "ai");
    assert.equal(item.documentId, "doc-1");
    assert.equal(item.subject, "Biologie");
    assert.deepEqual(item.sourceRefs, ["Seite 3"]);
    assert.equal(item.reviewStatus, "new");
    assert.equal(item.reviewCount, 0);
    assert.equal(item.successCount, 0);
    assert.ok(isQuizQuestion(item));
  });

  it("normalizes question keys for comparison", () => {
    assert.equal(questionKey("  Wo  läuft\nder Zyklus? "), questionKey("wo läuft der Zyklus?"));
  });

  it("skips regeneration duplicates per document only", () => {
    const existing = [
      manualQuestion({
        id: "old",
        documentId: "doc-1",
        source: "ai",
        question: "Wo läuft der Citratzyklus ab?",
      }),
    ];
    const candidates = [
      manualQuestion({
        id: "dup",
        documentId: "doc-1",
        source: "ai",
        question: "  wo läuft der citratzyklus ab? ",
      }),
      manualQuestion({
        id: "other-doc",
        documentId: "doc-2",
        source: "ai",
        question: "Wo läuft der Citratzyklus ab?",
      }),
      manualQuestion({
        id: "fresh",
        documentId: "doc-1",
        source: "ai",
        question: "Was spaltet die Glykolyse?",
      }),
    ];

    const { fresh, skipped } = filterNewQuestions(existing, candidates);

    assert.deepEqual(
      fresh.map((item) => item.id),
      ["other-doc", "fresh"],
    );
    assert.equal(skipped, 1);
  });
});

// --------------------------------------------------------------- scheduling

describe("quiz review scheduling", () => {
  it("treats new questions as due today", () => {
    const info = getQuizReviewInfo(manualQuestion(), "2026-10-31");

    assert.equal(info.dueISO, "2026-10-31");
    assert.equal(info.status, "today");
  });

  it("expands intervals on success and shrinks on hard ratings", () => {
    const first = scheduleQuizReview(manualQuestion(), true, "good", "2026-10-31");
    assert.equal(first.nextReviewAt, "2026-11-01");
    assert.equal(first.reviewStatus, "learning");
    assert.equal(first.successCount, 1);

    const second = scheduleQuizReview(
      manualQuestion({ ...first }),
      true,
      "good",
      "2026-11-01",
    );
    assert.equal(second.nextReviewAt, "2026-11-04");
    assert.equal(second.reviewStatus, "review");

    const hard = scheduleQuizReview(
      manualQuestion({ ...second }),
      true,
      "hard",
      "2026-11-04",
    );
    // Ladder step 7 halved for a hard recall.
    assert.equal(hard.nextReviewAt, "2026-11-08");
  });

  it("resets to tomorrow on wrong answers and tracks mastery", () => {
    const failed = scheduleQuizReview(
      manualQuestion({ reviewCount: 3, successCount: 3, streak: 3 }),
      false,
      "good",
      "2026-10-31",
    );

    assert.equal(failed.nextReviewAt, "2026-11-01");
    assert.equal(failed.streak, 0);
    assert.equal(failed.successCount, 3);
    assert.equal(failed.reviewStatus, "learning");

    const mastered = scheduleQuizReview(
      manualQuestion({ reviewCount: 4, successCount: 4, streak: 3 }),
      true,
      "easy",
      "2026-10-31",
    );

    assert.equal(mastered.reviewStatus, "mastered");
    assert.equal(mastered.streak, 4);
  });

  it("reports overdue and later states from stored dates", () => {
    const overdue = getQuizReviewInfo(
      manualQuestion({ nextReviewAt: "2026-10-29" }),
      "2026-10-31",
    );
    assert.equal(overdue.status, "overdue");
    assert.equal(overdue.daysLeft, -2);

    const later = getQuizReviewInfo(
      manualQuestion({ nextReviewAt: "2026-11-05" }),
      "2026-10-31",
    );
    assert.equal(later.status, "later");
  });

  it("keeps the ladder transparent and bounded", () => {
    assert.deepEqual(QUIZ_INTERVAL_LADDER, [1, 3, 7, 14, 30]);
  });
});

// ------------------------------------------------------------------- guards

describe("question DTO and quiz guards", () => {
  const response: QuestionsResponse = {
    questions: [
      {
        question: "Wo läuft der Citratzyklus ab?",
        options: ["Mitochondrien", "Zellkern"],
        correctIndex: 0,
        explanation: "Siehe Skript.",
        kind: "single",
        refs: ["Seite 3"],
      },
    ],
    documentId: "doc-1",
    documentName: "Skript.pdf",
    subject: "Biologie",
    refsUsed: ["Seite 3"],
    truncated: false,
    chunkCount: 2,
    insufficient: false,
    droppedInvalid: 0,
    partial: true,
    window: { labels: ["Seite 3"], poolSize: 2, truncated: true },
    coverage: { usableUnits: 2, coveredUnits: 0, percent: 0 },
  };

  it("accepts valid question responses", () => {
    assert.equal(isQuestionsResponse(response), true);
    assert.equal(
      isQuestionsResponse({ ...response, questions: "keine" }),
      false,
    );
    assert.equal(
      isQuestionsResponse({ ...response, partial: "ja" }),
      false,
    );
    assert.equal(
      isQuestionsResponse({ ...response, window: undefined }),
      false,
    );
    assert.equal(
      isQuestionsResponse({ ...response, coverage: { percent: 0 } }),
      false,
    );
  });

  it("keeps pre-AI records valid and validates new fields", () => {
    assert.equal(isQuizQuestion(manualQuestion()), true);
    assert.equal(
      isQuizQuestionList([manualQuestion(), manualQuestion({ id: "q-2" })]),
      true,
    );
    assert.equal(
      isQuizQuestion(
        manualQuestion({
          documentId: "doc-1",
          source: "ai",
          sourceRefs: ["Seite 3"],
          lastReviewedAt: "2026-10-31",
          nextReviewAt: "2026-11-01",
          reviewCount: 2,
          successCount: 2,
          streak: 2,
          difficulty: 4,
          reviewStatus: "review",
        }),
      ),
      true,
    );
    assert.equal(
      isQuizQuestion(manualQuestion({ difficulty: 9 })),
      false,
    );
    assert.equal(
      isQuizQuestion(manualQuestion({ reviewStatus: "fertig" as never })),
      false,
    );
    assert.equal(
      isQuizQuestion(manualQuestion({ source: "heuristic" as never })),
      false,
    );
  });
});

// ------------------------------------------------------- persistence mapping

describe("quiz cloud mapping", () => {
  it("round-trips AI linkage and review fields", () => {
    const item = manualQuestion({
      documentId: "doc-1",
      source: "ai",
      sourceRefs: ["Seite 3"],
      lastReviewedAt: "2026-10-31",
      nextReviewAt: "2026-11-01",
      reviewCount: 2,
      successCount: 1,
      streak: 1,
      difficulty: 2,
      reviewStatus: "learning",
    });

    const row = quizToDbRow(item);
    assert.equal(row.document_id, "doc-1");
    assert.equal(row.source, "ai");
    assert.deepEqual(row.source_refs, ["Seite 3"]);
    assert.equal(row.next_review_at, "2026-11-01");
    assert.equal(row.review_count, 2);
    assert.equal(row.success_count, 1);
    assert.equal(row.difficulty, 2);
    assert.equal(row.review_status, "learning");

    const back = quizRowToDomain({ ...row, id: item.id });
    assert.equal(isQuizQuestion(back), true);
    assert.equal((back as QuizQuestion).documentId, "doc-1");
    assert.equal((back as QuizQuestion).nextReviewAt, "2026-11-01");
  });

  it("creates rows with safe defaults for manual questions", async () => {
    const outcome = await quizConfig.checkCreate!(DB, manualQuestion());

    assert.equal("row" in outcome, true);
    const row = (outcome as { row: Record<string, unknown> }).row;
    assert.equal(row.document_id, null);
    assert.equal(row.source, "manual");
    assert.equal(row.review_status, "new");
  });

  it("allows review-field patches on update", async () => {
    const existing = quizRowToDomain({
      ...quizToDbRow(manualQuestion()),
      id: "q-1",
    });
    const outcome = await quizConfig.checkUpdate!(
      DB,
      { nextReviewAt: "2026-11-05", reviewStatus: "review", successCount: 2 },
      existing,
    );

    assert.equal("row" in outcome, true);
    const row = (outcome as { row: Record<string, unknown> }).row;
    assert.equal(row.next_review_at, "2026-11-05");
    assert.equal(row.review_status, "review");
    assert.equal(row.success_count, 2);
    assert.equal("id" in row, false);
  });
});

// ------------------------------------------------------------------ service

describe("validQuestionsInput", () => {
  it("validates the generation request", () => {
    assert.deepEqual(validQuestionsInput({ documentId: "d", locale: "de" }), {
      documentId: "d",
      locale: "de",
      count: 6,
      coveredRefs: [],
    });
    assert.deepEqual(
      validQuestionsInput({ documentId: "d", locale: "ru", count: 3 }),
      { documentId: "d", locale: "ru", count: 3, coveredRefs: [] },
    );
    assert.deepEqual(
      validQuestionsInput({
        documentId: "d",
        locale: "de",
        coveredRefs: ["Seite 1", "Folien 2–3"],
      }),
      {
        documentId: "d",
        locale: "de",
        count: 6,
        coveredRefs: ["Seite 1", "Folien 2–3"],
      },
    );
    assert.equal(
      validQuestionsInput({
        documentId: "d",
        locale: "de",
        coveredRefs: ["Seite 1", 7],
      }),
      null,
    );
    assert.equal(validQuestionsInput({ documentId: "d", locale: "en" }), null);
    assert.equal(validQuestionsInput({ documentId: "", locale: "de" }), null);
    assert.equal(
      validQuestionsInput({ documentId: "d", locale: "de", count: 99 }),
      null,
    );
  });
});

describe("generateStudyQuestions", () => {
  type FetchArgs = { url: string; method: string; body: string | null };
  type Route = {
    match: (args: FetchArgs) => boolean;
    respond: (args: FetchArgs) => Response;
  };

  let routes: Route[] = [];
  let hits: FetchArgs[] = [];
  const realFetch = globalThis.fetch;
  const SAVED_MODEL = process.env.OLLAMA_MODEL;

  function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status });
  }

  beforeEach(() => {
    routes = [];
    hits = [];
    process.env.OLLAMA_MODEL = "qwen3.5:4b";
    globalThis.fetch = (async (input: unknown, init?: {
      method?: string;
      body?: unknown;
    }) => {
      const args: FetchArgs = {
        url: String(input),
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string"
            ? init.body
            : init?.body === undefined
              ? null
              : "<binary>",
      };
      hits.push(args);

      const route = routes.find((candidate) => candidate.match(args));

      if (route === undefined) {
        throw new Error(`unstubbed fetch: ${args.method} ${args.url}`);
      }

      return route.respond(args);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;

    if (SAVED_MODEL === undefined) delete process.env.OLLAMA_MODEL;
    else process.env.OLLAMA_MODEL = SAVED_MODEL;
  });

  function onRest(
    method: string,
    table: string,
    respond: (args: FetchArgs) => Response,
  ): void {
    routes.push({
      match: (args) =>
        args.method === method &&
        args.url.startsWith(`https://supabase.test/rest/v1/${table}`),
      respond,
    });
  }

  function docRow(status: string) {
    return {
      id: "doc-1",
      name: "Skript.pdf",
      subject: "Biologie",
      extraction_status: status,
    };
  }

  const CHUNK_ROWS = [
    {
      id: "c1",
      document_id: "doc-1",
      chunk_index: 0,
      content: "Der Citratzyklus läuft in den Mitochondrien ab.",
      source_refs: [{ kind: "page", page: 3 }],
    },
  ];

  const SLIDE_ROWS = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index + 1}`,
    document_id: "doc-1",
    chunk_index: index,
    content: `FOLIE-${index + 1}-MARKER ${"Inhalt ".repeat(30)}`,
    source_refs: [{ kind: "slide", slide: index + 1 }],
  }));

  function oneQuestionOllama(): void {
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () =>
        json({
          message: {
            content: JSON.stringify([
              {
                question: "Was steht auf der Folie?",
                options: ["A", "B"],
                correctIndex: 0,
                explanation: "Siehe Folie [Q1].",
                kind: "single",
                refs: ["[Q1]"],
              },
            ]),
          },
        }),
    });
  }

  function llmBody(): string {
    return hits.find((hit) => hit.url.includes("11434"))?.body ?? "";
  }

  it("generates grounded questions through the central engine", async () => {
    onRest("GET", "study_documents", () => json([docRow("completed")]));
    onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () =>
        json({
          message: {
            content: JSON.stringify([
              {
                question: "Wo läuft der Citratzyklus ab?",
                options: ["Mitochondrien", "Zellkern"],
                correctIndex: 0,
                explanation: "Siehe Skript [Q1].",
                kind: "single",
                refs: ["[Q1]"],
              },
            ]),
          },
        }),
    });

    const outcome = await generateStudyQuestions(DB, {
      documentId: "doc-1",
      locale: "de",
      count: 6,
      coveredRefs: [],
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.response.questions.length, 1);
    assert.equal(outcome.response.subject, "Biologie");
    assert.deepEqual(outcome.response.questions[0]?.refs, ["Seite 3"]);
    assert.equal(outcome.response.insufficient, false);
    assert.equal(outcome.response.partial, true);
    const llmHits = hits.filter((hit) => hit.url.includes("11434"));
    assert.equal(llmHits.length, 1);
    // Native structured output: the model is constrained to JSON.
    assert.match(llmHits[0]?.body ?? "", /"format":"json"/);
  });

  it("repairs malformed output once through the service", async () => {
    onRest("GET", "study_documents", () => json([docRow("completed")]));
    onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
    let calls = 0;
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () => {
        calls += 1;

        return json({
          message: {
            content:
              calls === 1
                ? "Hier sind viele tolle Fragen (leider als Prosa)."
                : JSON.stringify([
                    {
                      question: "Wo läuft der Citratzyklus ab?",
                      options: ["Mitochondrien", "Zellkern"],
                      correctIndex: 0,
                      explanation: "Siehe Skript [Q1].",
                      kind: "single",
                      refs: ["[Q1]"],
                    },
                  ]),
          },
        });
      },
    });

    const outcome = await generateStudyQuestions(DB, {
      documentId: "doc-1",
      locale: "de",
      count: 6,
      coveredRefs: [],
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(calls, 2);
    assert.equal(outcome.response.questions.length, 1);
    assert.equal(outcome.response.insufficient, false);
    // Both attempts use the same model in native JSON mode.
    for (const hit of hits.filter((entry) => entry.url.includes("11434"))) {
      assert.match(hit.body ?? "", /"format":"json"/);
    }
  });

  it("answers unprocessed documents without calling the LLM", async () => {
    onRest("GET", "study_documents", () => json([docRow("processing")]));

    const outcome = await generateStudyQuestions(DB, {
      documentId: "doc-1",
      locale: "de",
      count: 6,
      coveredRefs: [],
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.response.insufficient, true);
    assert.equal(outcome.response.partial, false);
    assert.deepEqual(outcome.response.questions, []);
    assert.ok(hits.every((hit) => !hit.url.includes("11434")));
  });

  it("surfaces model garbage as an error, never heuristic questions", async () => {
    onRest("GET", "study_documents", () => json([docRow("completed")]));
    onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () => json({ message: { content: "Keine Ahnung." } }),
    });

    await assert.rejects(
      () =>
        generateStudyQuestions(DB, {
          documentId: "doc-1",
          locale: "de",
          count: 6,
          coveredRefs: [],
        }),
      /Korrekturversuch/,
    );

    // Initial attempt plus exactly one repair round, then an error.
    assert.equal(hits.filter((hit) => hit.url.includes("11434")).length, 2);
  });

  it("maps token exhaustion to truncated without a repair round", async () => {
    onRest("GET", "study_documents", () => json([docRow("completed")]));
    onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () =>
        json({
          model: "qwen3.5:4b",
          message: { content: "", thinking: "t".repeat(100) },
          done: true,
          done_reason: "length",
          eval_count: 300,
        }),
    });

    try {
      await generateStudyQuestions(DB, {
        documentId: "doc-1",
        locale: "de",
        count: 6,
        coveredRefs: [],
      });
      assert.fail("expected a truncation error");
    } catch (error: unknown) {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "truncated");
      assert.match(error.message, /abgeschnitten/);
    }

    // Exhaustion skips repair: a longer prompt would only truncate more.
    assert.equal(hits.filter((hit) => hit.url.includes("11434")).length, 1);
  });

  it("logs raw responses and rejections only with STUDY_DEBUG_RAW=1", async () => {
    onRest("GET", "study_documents", () => json([docRow("completed")]));
    onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () => json({ message: { content: "Kurze Prosa ohne JSON." } }),
    });

    const lines = captureLogs();
    const savedFlag = process.env.STUDY_DEBUG_RAW;
    process.env.STUDY_DEBUG_RAW = "1";

    try {
      await assert.rejects(() =>
        generateStudyQuestions(DB, {
          documentId: "doc-1",
          locale: "de",
          count: 6,
          coveredRefs: [],
        }),
      );
    } finally {
      lines.restore();

      if (savedFlag === undefined) delete process.env.STUDY_DEBUG_RAW;
      else process.env.STUDY_DEBUG_RAW = savedFlag;
    }

    const debug = lines.lines.filter((line) => line.includes("DEBUG"));
    // Raw response per attempt plus one rejection line.
    assert.equal(debug.length, 3);
    assert.ok(debug[0]?.includes("Kurze Prosa ohne JSON."));
    assert.ok(
      debug.some((line) => line.includes("jsonFound=false")),
    );
  });

  it("stays silent without STUDY_DEBUG_RAW", async () => {
    onRest("GET", "study_documents", () => json([docRow("completed")]));
    onRest("GET", "retrieval_chunks", () => json(CHUNK_ROWS));
    routes.push({
      match: (args) => args.url === "http://127.0.0.1:11434/api/chat",
      respond: () => json({ message: { content: "Kurze Prosa ohne JSON." } }),
    });

    const lines = captureLogs();
    const savedFlag = process.env.STUDY_DEBUG_RAW;
    delete process.env.STUDY_DEBUG_RAW;

    try {
      await assert.rejects(() =>
        generateStudyQuestions(DB, {
          documentId: "doc-1",
          locale: "de",
          count: 6,
          coveredRefs: [],
        }),
      );
    } finally {
      lines.restore();

      if (savedFlag !== undefined) {
        process.env.STUDY_DEBUG_RAW = savedFlag;
      }
    }

    assert.equal(
      lines.lines.filter((line) => line.includes("DEBUG")).length,
      0,
    );
    assert.ok(
      lines.lines.some((line) => line.includes("[api:study] questions ")),
    );
  });

  it("returns 404 for unknown documents", async () => {
    onRest("GET", "study_documents", () => json([]));

    const outcome = await generateStudyQuestions(DB, {
      documentId: "missing",
      locale: "de",
      count: 6,
      coveredRefs: [],
    });

    assert.deepEqual(outcome, {
      ok: false,
      http: 404,
      message: "Dokument nicht gefunden.",
    });
  });

  it("spreads the first window across all slides (no front bias)", async () => {
    onRest("GET", "study_documents", () => json([docRow("completed")]));
    onRest("GET", "retrieval_chunks", () => json(SLIDE_ROWS));
    oneQuestionOllama();

    const outcome = await generateStudyQuestions(DB, {
      documentId: "doc-1",
      locale: "de",
      count: 2,
      coveredRefs: [],
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.deepEqual(outcome.response.window.labels, ["Folie 1", "Folie 8"]);
    assert.equal(outcome.response.window.poolSize, 8);
    assert.equal(outcome.response.truncated, true);
    assert.deepEqual(outcome.response.coverage, {
      usableUnits: 8,
      coveredUnits: 0,
      percent: 0,
    });
    assert.ok(llmBody().includes("FOLIE-1-MARKER"));
    assert.ok(llmBody().includes("FOLIE-8-MARKER"));
  });

  it("covers new slices when covered labels are passed", async () => {
    onRest("GET", "study_documents", () => json([docRow("completed")]));
    onRest("GET", "retrieval_chunks", () => json(SLIDE_ROWS));
    oneQuestionOllama();

    const outcome = await generateStudyQuestions(DB, {
      documentId: "doc-1",
      locale: "de",
      count: 2,
      coveredRefs: ["Folie 1", "Folie 8"],
    });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.deepEqual(outcome.response.window.labels, ["Folie 2", "Folie 7"]);
    assert.deepEqual(outcome.response.coverage, {
      usableUnits: 8,
      coveredUnits: 2,
      percent: 25,
    });
    assert.ok(llmBody().includes("FOLIE-2-MARKER"));
    assert.ok(llmBody().includes("FOLIE-7-MARKER"));
    assert.ok(!llmBody().includes("FOLIE-1-MARKER"));
    assert.ok(!llmBody().includes("FOLIE-8-MARKER"));
  });
});
