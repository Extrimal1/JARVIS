import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_EXTRACT_SPANS,
  TOPICS_PER_SPAN,
  TOPIC_EXTRACT_NUM_PREDICT,
  TOPIC_MERGE_THRESHOLD,
  mergeExtractedTopics,
  mergeTopicsManual,
  normalizeTopicName,
  parseTopicExtraction,
  removeTopic,
  renameTopic,
  splitTopic,
  topicExtractionPrompt,
  TopicsParseError,
  type ExtractedTopic,
} from "@/src/lib/study/topics";
import type { GroundedSource } from "@/src/lib/study/prompts";
import type { ParsedCoverageUnit } from "@/src/lib/study/coverage";
import type { Entry } from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";

const SOURCES: GroundedSource[] = [
  {
    marker: "[Q1]",
    documentName: "Vorlesung.pptx",
    refLabel: "Folie 1",
    text: "Zinsrechnung: einfacher Zins.",
  },
  {
    marker: "[Q2]",
    documentName: "Vorlesung.pptx",
    refLabel: "Folie 2",
    text: "Rentenrechnung: nachschüssige Rente.",
  },
];

const USABLE: ParsedCoverageUnit[] = [{ kind: "slide", from: 1, to: 2 }];

function topic(overrides: Partial<ExtractedTopic> = {}): ExtractedTopic {
  return {
    name: "Zinsrechnung",
    summary: "Einfacher Zins.",
    concepts: ["Zins"],
    formulas: [{ text: "K*n*i", variables: ["K", "n", "i"] }],
    examples: ["Sparbuch"],
    prerequisites: [],
    parent: null,
    refs: ["Folie 1"],
    ...overrides,
  };
}

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "t1",
    title: "Zinsrechnung",
    detail: "Einfacher Zins.",
    subject: "Mathe",
    ...overrides,
  };
}

function question(overrides: Partial<QuizQuestion> = {}): QuizQuestion {
  return {
    id: "q1",
    subject: "Mathe",
    examId: null,
    topicId: "t1",
    question: "Was ist Zins?",
    options: ["A", "B"],
    correctIndex: 0,
    explanation: "Weil.",
    ...overrides,
  };
}

describe("topic extraction prompt", () => {
  it("contracts JSON-only output with markers and bounds", () => {
    const messages = topicExtractionPrompt(
      "de",
      "Vorlesung.pptx",
      "Folien 1–2",
      SOURCES,
    );

    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.role, "system");
    assert.match(messages[0]?.content ?? "", /NUR mit gültigem JSON/);
    assert.match(messages[1]?.content ?? "", /\[Q1\][\s\S]*Folie 1/);
    assert.match(messages[1]?.content ?? "", /"topics"/);
    assert.match(
      messages[1]?.content ?? "",
      new RegExp(`höchstens ${TOPICS_PER_SPAN}`),
    );
  });

  it("answers in English for non-German locales", () => {
    const messages = topicExtractionPrompt(
      "ru",
      "Vorlesung.pptx",
      "Folien 1–2",
      SOURCES,
    );

    assert.match(messages[0]?.content ?? "", /ONLY with valid JSON/);
  });

  it("keeps budgets bounded", () => {
    assert.equal(TOPIC_EXTRACT_NUM_PREDICT, 2000);
    assert.equal(MAX_EXTRACT_SPANS, 6);
    assert.equal(TOPIC_MERGE_THRESHOLD, 0.85);
  });
});

describe("parseTopicExtraction", () => {
  it("parses the topics envelope with validated refs", () => {
    const raw = JSON.stringify({
      topics: [
        {
          name: "Zinsrechnung",
          summary: "Einfacher Zins.",
          concepts: ["Zins"],
          formulas: [{ text: "K*n*i", variables: ["K", "n", "i"] }],
          examples: ["Sparbuch"],
          prerequisites: ["Grundrechenarten"],
          parent: "Finanzmathematik",
          refs: ["[Q1]"],
        },
      ],
    });

    assert.deepEqual(parseTopicExtraction(raw, SOURCES, USABLE), {
      topics: [
        {
          name: "Zinsrechnung",
          summary: "Einfacher Zins.",
          concepts: ["Zins"],
          formulas: [{ text: "K*n*i", variables: ["K", "n", "i"] }],
          examples: ["Sparbuch"],
          prerequisites: ["Grundrechenarten"],
          parent: "Finanzmathematik",
          refs: ["Folie 1"],
        },
      ],
      droppedInvalid: 0,
      droppedUngrounded: 0,
    });
  });

  it("accepts a single object and fenced JSON", () => {
    const single = parseTopicExtraction(
      JSON.stringify({
        name: "Rentenrechnung",
        summary: "Rente.",
        refs: ["[Q2]"],
      }),
      SOURCES,
      USABLE,
    );

    assert.equal(single.topics.length, 1);
    assert.deepEqual(single.topics[0]?.refs, ["Folie 2"]);

    const fenced = parseTopicExtraction(
      '```json\n{"topics": [{"name": "Rentenrechnung", "refs": ["[Q2]"]}]}\n```',
      SOURCES,
      USABLE,
    );

    assert.equal(fenced.topics.length, 1);
  });

  it("accepts verbatim labels and drops unknown markers", () => {
    const result = parseTopicExtraction(
      JSON.stringify({
        topics: [{ name: "Zinsrechnung", refs: ["Folie 1", "[Q9]"] }],
      }),
      SOURCES,
      USABLE,
    );

    assert.deepEqual(result.topics[0]?.refs, ["Folie 1"]);
    assert.equal(result.droppedUngrounded, 0);
  });

  it("drops ungrounded and invalid topics with counts", () => {
    const result = parseTopicExtraction(
      JSON.stringify({
        topics: [
          { name: "Erfunden", refs: ["Folie 99"] },
          { name: "   ", refs: ["[Q1]"] },
          null,
          { name: "Zinsrechnung", refs: ["[Q1]"] },
        ],
      }),
      SOURCES,
      USABLE,
    );

    assert.equal(result.topics.length, 1);
    assert.equal(result.topics[0]?.name, "Zinsrechnung");
    assert.equal(result.droppedUngrounded, 1);
    assert.equal(result.droppedInvalid, 2);
  });

  it("rejects output without JSON", () => {
    assert.throws(
      () => parseTopicExtraction("Nur Prosa, kein JSON.", SOURCES, USABLE),
      (error: unknown) =>
        error instanceof TopicsParseError &&
        error.message.includes("kein JSON gefunden"),
    );
  });
});

describe("parseTopicsWithRepair", () => {
  it("repairs malformed JSON once", async () => {
    const { parseTopicsWithRepair } = await import(
      "@/src/lib/study/topics"
    );
    const calls: string[] = [];
    const result = await parseTopicsWithRepair(
      async (messages) => {
        calls.push(messages[messages.length - 1]?.content ?? "");

        return calls.length === 1
          ? "Kein JSON."
          : JSON.stringify({
              topics: [{ name: "Zinsrechnung", refs: ["[Q1]"] }],
            });
      },
      [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      SOURCES,
      USABLE,
      "de",
    );

    assert.equal(result.repaired, true);
    assert.equal(result.topics.length, 1);
    assert.match(calls[1] ?? "", /Korrigiere|kein lesbares Themen-JSON/);
  });

  it("throws after a failed repair", async () => {
    const { parseTopicsWithRepair } = await import(
      "@/src/lib/study/topics"
    );

    await assert.rejects(
      parseTopicsWithRepair(
        async () => "Weiterhin kein JSON.",
        [{ role: "user", content: "u" }],
        SOURCES,
        USABLE,
        "de",
      ),
      (error: unknown) => error instanceof TopicsParseError,
    );
  });
});

describe("normalizeTopicName", () => {
  it("folds case, punctuation, and spacing", () => {
    assert.equal(normalizeTopicName("  Zins-Rechnung! "), "zins rechnung");
    assert.equal(normalizeTopicName("Rentenrechnung"), "rentenrechnung");
  });
});

describe("sameTopicName", () => {
  it("matches equal, contained, and similar names", async () => {
    const { sameTopicName } = await import("@/src/lib/study/topics");

    assert.equal(sameTopicName("Zinsrechnung", "Zinsrechnung!"), true);
    assert.equal(
      sameTopicName("Zinsrechnung", "Zinsrechnung (Wiederholung)"),
      true,
    );
    assert.equal(sameTopicName("Zinsrechnung", "Rentenrechnung"), false);
    assert.equal(sameTopicName("Zins", "Zinseszins"), false);
    assert.equal(sameTopicName("", "Zins"), false);
  });
});

describe("mergeExtractedTopics", () => {
  it("creates new topics with sources and data", () => {
    const result = mergeExtractedTopics(
      [],
      [{ topic: topic(), documentId: "doc-1" }],
      "Mathe",
      () => "new-1",
    );

    assert.equal(result.created, 1);
    assert.equal(result.merged, 0);
    assert.deepEqual(result.entries[0]?.sourceRefs, [
      { documentId: "doc-1", label: "Folie 1" },
    ]);
    assert.deepEqual(result.entries[0]?.topicData?.concepts, ["Zins"]);
    assert.equal(result.entries[0]?.parentId, null);
  });

  it("merges exact and near-duplicate names across documents", () => {
    const first = mergeExtractedTopics(
      [],
      [{ topic: topic(), documentId: "doc-1" }],
      "Mathe",
      () => "t1",
    );
    const second = mergeExtractedTopics(
      first.entries,
      [
        {
          topic: topic({
            name: "Zinsrechnung (Wiederholung)",
            summary: "Zinseszins.",
            refs: ["Folie 2"],
          }),
          documentId: "doc-2",
        },
      ],
      "Mathe",
      () => "t2",
    );

    assert.equal(second.created, 0);
    assert.equal(second.merged, 1);
    assert.equal(second.entries.length, 1);
    assert.deepEqual(second.entries[0]?.sourceRefs, [
      { documentId: "doc-1", label: "Folie 1" },
      { documentId: "doc-2", label: "Folie 2" },
    ]);
    assert.match(second.entries[0]?.detail ?? "", /Zinseszins/);
  });

  it("keeps other subjects separate", () => {
    const result = mergeExtractedTopics(
      [entry({ id: "t1", subject: "Physik" })],
      [{ topic: topic(), documentId: "doc-1" }],
      "Mathe",
      () => "t2",
    );

    assert.equal(result.created, 1);
    assert.equal(result.entries.length, 2);
  });

  it("links parent hints only to matched topics", () => {
    const result = mergeExtractedTopics(
      [],
      [
        { topic: topic({ name: "Finanzmathematik" }), documentId: "doc-1" },
        {
          topic: topic({ name: "Zinsrechnung", parent: "Finanzmathematik" }),
          documentId: "doc-1",
        },
        {
          topic: topic({ name: "Waise", parent: "Unbekannt" }),
          documentId: "doc-1",
        },
      ],
      "Mathe",
      (() => {
        let n = 0;

        return () => `t${(n += 1)}`;
      })(),
    );

    const child = result.entries.find((e) => e.title === "Zinsrechnung");
    const orphan = result.entries.find((e) => e.title === "Waise");

    assert.equal(child?.parentId, "t1");
    assert.equal(orphan?.parentId, null);
  });

  it("never links a topic to itself", () => {
    const result = mergeExtractedTopics(
      [],
      [
        {
          topic: topic({ name: "Zinsrechnung", parent: "Zinsrechnung" }),
          documentId: "doc-1",
        },
      ],
      "Mathe",
      () => "t1",
    );

    assert.equal(result.entries[0]?.parentId, null);
  });
});

describe("topic tree ops", () => {
  it("renames with uniqueness checks", () => {
    const renamed = renameTopic([entry()], "t1", "  Zins & Zinseszins ");

    assert.equal(renamed.ok, true);

    if (!renamed.ok) return;

    assert.equal(renamed.entries[0]?.title, "Zins & Zinseszins");

    assert.deepEqual(renameTopic([entry()], "t1", "   "), {
      ok: false,
      error: "Der Name darf nicht leer sein.",
    });
    assert.deepEqual(
      renameTopic([entry(), entry({ id: "t2", title: "Rente" })], "t1", "rente"),
      { ok: false, error: "Ein Thema mit diesem Namen existiert bereits." },
    );
  });

  it("merges topics and reassigns children and questions", () => {
    const entries = [
      entry({ id: "keep", title: "Zinsrechnung", detail: "Basis." }),
      entry({
        id: "drop",
        title: "Zins",
        detail: "Extra.",
        sourceRefs: [{ documentId: "doc-2", label: "Folie 5" }],
      }),
      entry({ id: "child", title: "Zinseszins", parentId: "drop" }),
    ];
    const merged = mergeTopicsManual(
      entries,
      [question({ id: "q1", topicId: "drop" })],
      ["keep", "drop"],
      "keep",
    );

    assert.equal(merged.ok, true);

    if (!merged.ok) return;

    assert.deepEqual(merged.result.removedIds, ["drop"]);

    const survivor = merged.result.entries.find((e) => e.id === "keep");

    assert.match(survivor?.detail ?? "", /Basis/);
    assert.match(survivor?.detail ?? "", /Extra/);
    assert.deepEqual(survivor?.sourceRefs, [
      { documentId: "doc-2", label: "Folie 5" },
    ]);
    assert.equal(
      merged.result.entries.find((e) => e.id === "child")?.parentId,
      "keep",
    );
    assert.deepEqual(merged.result.questionPatches, [
      { id: "q1", topicId: "keep" },
    ]);
  });

  it("splits a topic and reports moved questions", () => {
    let n = 0;
    const split = splitTopic(
      [entry({ id: "t1" })],
      [question({ id: "q1", topicId: "t1" })],
      "t1",
      [{ title: "Einfacher Zins" }, { title: "Zinseszins" }],
      () => `n${(n += 1)}`,
    );

    assert.equal(split.ok, true);

    if (!split.ok) return;

    assert.deepEqual(split.result.removedIds, ["t1"]);
    assert.deepEqual(
      split.result.entries.map((e) => e.title).sort(),
      ["Einfacher Zins", "Zinseszins"],
    );
    assert.deepEqual(split.result.questionPatches, [
      { id: "q1", topicId: "n1" },
    ]);

    const withRefs = splitTopic(
      [
        entry({
          id: "t1",
          sourceRefs: [{ documentId: "doc-1", label: "Folie 1" }],
        }),
      ],
      [],
      "t1",
      [{ title: "A" }, { title: "B" }],
      () => "n9",
    );

    assert.equal(withRefs.ok, true);

    if (!withRefs.ok) return;

    for (const part of withRefs.result.entries) {
      assert.deepEqual(part.sourceRefs, [
        { documentId: "doc-1", label: "Folie 1" },
      ]);
    }
    assert.deepEqual(
      splitTopic([entry({ id: "t1" })], [], "t1", [{ title: "Solo" }], () => "x"),
      { ok: false, error: "Mindestens zwei benannte Teile angeben." },
    );
  });

  it("removes a topic without deleting questions or children", () => {
    const entries = [
      entry({ id: "parent", title: "Finanzmathematik" }),
      entry({ id: "t1", title: "Zinsrechnung", parentId: "parent" }),
      entry({ id: "child", title: "Zinseszins", parentId: "t1" }),
    ];
    const removed = removeTopic(
      entries,
      [question({ id: "q1", topicId: "t1" })],
      "t1",
    );

    assert.equal(removed.ok, true);

    if (!removed.ok) return;

    assert.equal(
      removed.result.entries.some((e) => e.id === "t1"),
      false,
    );
    assert.equal(
      removed.result.entries.find((e) => e.id === "child")?.parentId,
      "parent",
    );
    assert.deepEqual(removed.result.questionPatches, [
      { id: "q1", topicId: "parent" },
    ]);

    const rootless = removeTopic(
      [entry({ id: "t1", parentId: null })],
      [question({ id: "q1", topicId: "t1" })],
      "t1",
    );

    assert.equal(rootless.ok, true);

    if (!rootless.ok) return;

    assert.deepEqual(rootless.result.questionPatches, [
      { id: "q1", topicId: null },
    ]);
  });
});
