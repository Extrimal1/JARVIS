/**
 * PPTX auto topic-extraction regression tests (priority 3, separate
 * from PDF/DOCX): real multi-slide deck fixture through upload/MIME
 * detection, binary slide extraction (presentation order, titles +
 * bullets, tables, notes, entities, no XML junk), chunking/coverage
 * bounds, the meaningful-text gate, the EXISTING topic service
 * (prompt, mocked Ollama parse, grounding, merge, persist with
 * slide-numbered refs), and honest retryable/insufficient states.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateFile } from "@/src/lib/documents";
import { validCreateDoc } from "@/src/lib/api/modules/documents";
import {
  blocksToText,
  extractDocument,
  formatSourceRefs,
} from "@/src/lib/study/extract";
import { chunkBlocks } from "@/src/lib/study/chunk";
import {
  hasMeaningfulText,
  runDocumentTopicExtraction,
  classifyTopicError,
  formatTopicSummary,
  type TopicPersistStore,
} from "@/src/lib/study/autoTopics";
import {
  mergeExtractedTopics,
  parseTopicExtraction,
  parseTopicsWithRepair,
  topicExtractionPrompt,
} from "@/src/lib/study/topics";
import { planSummarySweep } from "@/src/lib/study/coverage";
import {
  MAX_CHUNKS_PER_DOC,
  type TopicsExtractResponse,
} from "@/src/lib/study/protocol";
import type { GroundedSource } from "@/src/lib/study/prompts";
import type { Entry } from "@/src/lib/study";

const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
  );
}

function fakeFile(name: string, type: string, size: number): File {
  return { name, type, size } as File;
}

function response(
  overrides: Partial<TopicsExtractResponse> = {},
): TopicsExtractResponse {
  return {
    documentId: "deck-1",
    documentName: "Biologie-Deck.pptx",
    spansDone: [],
    skippedSpans: [],
    topics: [],
    droppedInvalid: 0,
    droppedUngrounded: 0,
    repaired: false,
    insufficient: false,
    done: true,
    ...overrides,
  };
}

function topicDto(name: string, refs: string[], parent: string | null = null) {
  return {
    name,
    summary: `${name} kurz.`,
    concepts: [`${name}-Begriff`],
    formulas: [],
    examples: [],
    prerequisites: [],
    parent,
    refs,
  };
}

function makeStore(): TopicPersistStore & {
  added: Entry[];
  updated: { id: string; patch: Partial<Entry> }[];
} {
  const added: Entry[] = [];
  const updated: { id: string; patch: Partial<Entry> }[] = [];

  return {
    added,
    updated,
    addEntry: async (_section, entry) => {
      added.push(entry);

      return { ok: true as const };
    },
    updateEntry: async (id, patch) => {
      updated.push({ id, patch });

      return { ok: true as const };
    },
  };
}

// ------------------------------------------------------- upload/MIME (PPTX)

describe("pptx upload/MIME detection", () => {
  it("accepts the official MIME plus octet-stream and empty fallbacks", () => {
    for (const type of [PPTX_MIME, "application/octet-stream", ""]) {
      const result = validateFile(fakeFile("Deck.pptx", type, 1024));

      assert.equal(result.ok, true);

      if (result.ok) {
        assert.equal(result.value.kind, "pptx");
        assert.equal(
          result.value.mimeType,
          type === "" ? PPTX_MIME : type,
        );
      }
    }
  });

  it("rejects mismatched types, empty, and oversized PPTX", () => {
    const wrong = validateFile(
      fakeFile("Deck.pptx", "application/pdf", 1024),
    );

    assert.equal(wrong.ok, false);

    assert.equal(
      validateFile(fakeFile("Deck.pptx", PPTX_MIME, 0)).ok,
      false,
    );
    assert.equal(
      validateFile(fakeFile("Deck.pptx", PPTX_MIME, 10 * 1024 * 1024 + 1))
        .ok,
      false,
    );
    assert.equal(
      validateFile(fakeFile("Deck.pdf", PPTX_MIME, 1024)).ok,
      false,
    );
  });

  it("cloud creation matches local fallback behavior for PPTX", () => {
    for (const mime of [PPTX_MIME, "application/octet-stream", ""]) {
      const input = validCreateDoc({
        id: "deck-1",
        name: "Deck.pptx",
        mime,
        size: 1024,
        subject: "Biologie",
        description: "",
      });

      assert.ok(input !== null);
      assert.equal(input?.mime, mime);
    }

    assert.equal(
      validCreateDoc({
        id: "deck-1",
        name: "Deck.pptx",
        mime: "application/pdf",
        size: 1024,
        subject: null,
        description: "",
      }),
      null,
    );
    assert.equal(
      validCreateDoc({
        id: "deck-1",
        name: "Deck.pptx",
        mime: PPTX_MIME,
        size: 10 * 1024 * 1024 + 1,
        subject: null,
        description: "",
      }),
      null,
    );
  });
});

// ------------------------------------------------- slide extraction (deck)

describe("pptx slide extraction from every slide", () => {
  it("extracts titles+bullets in presentation order with numbers kept", async () => {
    const doc = await extractDocument("pptx", fixture("sample-deck.pptx"));

    // Six slides, file5 (position 3) empty: five blocks, gap kept.
    assert.equal(doc.blocks.length, 5);
    assert.deepEqual(
      doc.blocks.map((block) => block.ref),
      [
        { kind: "slide", slide: 1 },
        { kind: "slide", slide: 2 },
        { kind: "slide", slide: 4 },
        { kind: "slide", slide: 5 },
        { kind: "slide", slide: 6 },
      ],
    );
    assert.equal(doc.pageCount, 6);
    assert.deepEqual(doc.warnings, [
      "1 von 6 Folien enthalten keinen lesbaren Text.",
    ]);

    // Presentation order [3,1,5,2,4,6], not filename order.
    assert.match(doc.blocks[0]?.text ?? "", /Biologie Klausur/);
    assert.match(doc.blocks[0]?.text ?? "", /prüfungsrelevanten/);
    assert.match(doc.blocks[1]?.text ?? "", /Photosynthese/);
    assert.match(doc.blocks[1]?.text ?? "", /Chlorophyll/);
    assert.match(doc.blocks[1]?.text ?? "", /Kohlenstoffdioxid/);
    assert.match(doc.blocks[2]?.text ?? "", /Zellatmung/);
    assert.match(doc.blocks[2]?.text ?? "", /Glykolyse/);
    assert.match(doc.blocks[2]?.text ?? "", /Citratzyklus/);
    assert.match(doc.blocks[3]?.text ?? "", /Mendel/);
    assert.match(doc.blocks[4]?.text ?? "", /Ökologie/);
  });

  it("appends speaker notes via rels and same-number fallback", async () => {
    const doc = await extractDocument("pptx", fixture("sample-deck.pptx"));
    const bySlide = new Map(
      doc.blocks.map((block) => [
        block.ref.kind === "slide" ? block.ref.slide : 0,
        block.text,
      ]),
    );

    // Position 4 = file2 (rels-linked notes).
    assert.match(
      bySlide.get(4) ?? "",
      /Sprechnotiz zu Zellatmung: ATP-Ausbeute/,
    );
    // Position 5 = file4 (fallback notes, no rels file).
    assert.match(bySlide.get(5) ?? "", /Notiz zu Mendel: Erbsenexperimente/);
    // Notes extend their own slide; other slides carry none.
    assert.ok(!(bySlide.get(1) ?? "").includes("Sprechnotiz"));
    assert.ok(!(bySlide.get(2) ?? "").includes("Notiz zu Mendel"));
  });

  it("reads table cells, unescapes entities, leaks no XML", async () => {
    const doc = await extractDocument("pptx", fixture("sample-deck.pptx"));
    const text = blocksToText(doc.blocks);

    assert.match(text, /Merkmal/);
    assert.match(text, /Ausprägung/);
    assert.match(text, /rund oder runzlig/);
    assert.match(text, /Ökologie & Umwelt/);
    assert.ok(!text.includes("&amp;"));
    assert.ok(!text.includes("&lt;"));

    for (const block of doc.blocks) {
      assert.ok(!block.text.includes("<"));
      assert.ok(!block.text.includes("a:t"));
      assert.ok(!block.text.includes("p:sld"));
      assert.ok(!block.text.includes("xmlns"));
    }
  });

  it("keeps presentation-less files on filename order (no regression)", async () => {
    const doc = await extractDocument("pptx", fixture("sample.pptx"));

    assert.equal(doc.blocks.length, 2);
    assert.deepEqual(doc.blocks[0]?.ref, { kind: "slide", slide: 1 });
    assert.deepEqual(doc.blocks[1]?.ref, { kind: "slide", slide: 2 });
    assert.equal(doc.pageCount, 3);
  });
});

// ------------------------------------------------ chunking/coverage/bounds

describe("pptx chunking, coverage, and bounds", () => {
  it("chunks keep slide refs and cover every usable slide once", async () => {
    const doc = await extractDocument("pptx", fixture("sample-deck.pptx"));
    const chunks = chunkBlocks(doc.blocks);

    assert.ok(chunks.length >= 1);

    for (const chunk of chunks) {
      assert.ok(chunk.refs.length >= 1);
      assert.ok(chunk.charCount <= 4000);
      assert.ok(
        chunk.refs.every((ref) => ref.kind === "slide"),
        "deck chunks cite slides only",
      );
    }

    const seen = new Set(
      chunks.flatMap((chunk) =>
        chunk.refs.map((ref) => (ref.kind === "slide" ? ref.slide : 0)),
      ),
    );

    assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 4, 5, 6]);

    const plan = planSummarySweep(chunks);
    const usable = plan.flatMap((span) => span.units);

    assert.ok(plan.length >= 1);
    assert.ok(
      plan.every((span) => /Folie/.test(span.label)),
      "span labels stay slide-numbered",
    );

    const covered = new Set<number>();

    for (const unit of usable) {
      assert.equal(unit.kind, "slide");

      for (let n = unit.from; n <= unit.to; n += 1) covered.add(n);
    }

    assert.deepEqual([...covered].sort((a, b) => a - b), [1, 2, 4, 5, 6]);
  });

  it("many slides stay bounded (no runaway chunk counts)", () => {
    const blocks = Array.from({ length: 120 }, (_, index) => ({
      text: `Folie ${index + 1}: ${"Lernstoff zur Klausur. ".repeat(20)}`,
      ref: { kind: "slide", slide: index + 1 } as const,
    }));
    const chunks = chunkBlocks(blocks);

    assert.ok(chunks.length >= 1);
    assert.ok(chunks.length <= MAX_CHUNKS_PER_DOC);

    for (const chunk of chunks) {
      assert.ok(chunk.charCount <= 4000);
      assert.ok(chunk.refs.length >= 1);
    }
  });
});

// ------------------------------------------------------- meaningful-text gate

describe("pptx meaningful-text gate", () => {
  it("accepts the deck, rejects empty and fragment-only input", async () => {
    const doc = await extractDocument("pptx", fixture("sample-deck.pptx"));

    assert.equal(hasMeaningfulText(chunkBlocks(doc.blocks)), true);
    assert.equal(hasMeaningfulText([]), false);
    assert.equal(hasMeaningfulText([{ text: "Folie" }]), false);
    assert.equal(
      hasMeaningfulText([{ text: "… --- …" }, { text: " . " }]),
      false,
    );
  });
});

// -------------------------------------------- prompt/parse/grounding (PPTX)

describe("pptx topic prompt, parse, and grounding", () => {
  async function deckSources(): Promise<{
    sources: GroundedSource[];
    usable: { kind: "slide"; from: number; to: number }[];
    label: string;
  }> {
    const doc = await extractDocument("pptx", fixture("sample-deck.pptx"));
    const chunks = chunkBlocks(doc.blocks);
    const plan = planSummarySweep(chunks);
    const span = plan[0]!;
    const wanted = new Set(span.chunkIndices);
    const picked = chunks.filter((chunk) => wanted.has(chunk.index));

    return {
      sources: picked.map((chunk, index) => ({
        marker: `[Q${index + 1}]`,
        documentName: "Biologie-Deck.pptx",
        refLabel: formatSourceRefs(chunk.refs),
        text: chunk.text,
      })),
      usable: plan.flatMap((entry) =>
        entry.units.map((unit) => ({
          kind: "slide" as const,
          from: unit.from,
          to: unit.to,
        })),
      ),
      label: span.label,
    };
  }

  it("prompts with Folie labels and slide text (JSON-only contract)", async () => {
    const { sources, label } = await deckSources();
    const messages = topicExtractionPrompt(
      "de",
      "Biologie-Deck.pptx",
      label,
      sources,
    );

    assert.equal(messages.length, 2);
    assert.match(messages[0]?.content ?? "", /NUR mit gültigem JSON/);
    assert.match(messages[1]?.content ?? "", /\[Q1\]/);
    assert.match(messages[1]?.content ?? "", /Folie/);
    assert.match(messages[1]?.content ?? "", /"topics"/);
  });

  it("grounds marker refs to Folie labels, drops the rest with counts", async () => {
    const { sources, usable } = await deckSources();
    const result = parseTopicExtraction(
      JSON.stringify({
        topics: [
          { name: "Photosynthese", refs: ["[Q1]"] },
          { name: "Erfunden", refs: ["Folie 99"] },
          { name: "   ", refs: ["[Q1]"] },
        ],
      }),
      sources,
      usable,
    );

    assert.equal(result.topics.length, 1);
    assert.match(result.topics[0]?.refs.join(",") ?? "", /Folie/);
    assert.equal(result.droppedUngrounded, 1);
    assert.equal(result.droppedInvalid, 1);
  });

  it("repairs malformed model JSON once (same existing parser)", async () => {
    const { sources, usable } = await deckSources();
    const calls: string[] = [];
    const result = await parseTopicsWithRepair(
      async (messages) => {
        calls.push(messages[messages.length - 1]?.content ?? "");

        return calls.length === 1
          ? "Kein JSON."
          : JSON.stringify({
              topics: [{ name: "Zellatmung", refs: ["[Q1]"] }],
            });
      },
      [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ],
      sources,
      usable,
      "de",
    );

    assert.equal(result.repaired, true);
    assert.equal(result.topics.length, 1);
    assert.match(result.topics[0]?.refs.join(",") ?? "", /Folie/);
  });
});

// ----------------------- auto extraction via the EXISTING runner (PPTX deck)

describe("pptx automatic extraction via the existing service", () => {
  it("runs to completion and persists slide-numbered refs (idempotent)", async () => {
    let rounds = 0;
    const seen: string[][] = [];
    const call = async (covered: string[]) => {
      seen.push([...covered]);
      rounds += 1;

      if (covered.length === 0) {
        return response({
          spansDone: ["Folie 1"],
          topics: [topicDto("Photosynthese", ["Folie 2"])],
          done: false,
        });
      }

      return response({
        spansDone: ["Folie 1", "Folie 4"],
        topics: [
          topicDto("Zellatmung", ["Folie 4"]),
          topicDto("Glykolyse", ["Folie 4"], "Zellatmung"),
        ],
        done: true,
      });
    };
    const store = makeStore();
    let next = 0;
    const makeId = () => `pptx-${(next += 1)}`;
    const progress: string[] = [];

    const summary = await runDocumentTopicExtraction({
      documentId: "deck-1",
      subject: "Biologie",
      locale: "de",
      topics: [],
      makeId,
      call,
      store,
      onProgress: (update) => {
        progress.push(
          `${update.spansDone.length} Abschnitte · +${update.created} neu`,
        );
      },
    });

    assert.equal(summary.done, true);
    assert.equal(summary.created, 3);
    assert.equal(summary.merged, 0);
    assert.equal(rounds, 2);
    assert.deepEqual(seen, [[], ["Folie 1"]]);
    assert.ok(progress.length >= 1);
    assert.equal(store.added.length, 3);
    assert.ok(
      store.added.every(
        (entry) =>
          entry.subject === "Biologie" &&
          (entry.sourceRefs ?? []).every(
            (ref) =>
              ref.documentId === "deck-1" && /Folie/.test(ref.label),
          ),
      ),
    );

    const child = summary.topics.find(
      (entry) => entry.title === "Glykolyse",
    );
    const parent = summary.topics.find(
      (entry) => entry.title === "Zellatmung",
    );

    assert.ok(parent !== undefined && child?.parentId === parent.id);

    // Re-run merges without duplicates or extra writes.
    const second = makeStore();
    const twice = await runDocumentTopicExtraction({
      documentId: "deck-1",
      subject: "Biologie",
      locale: "de",
      topics: summary.topics,
      makeId,
      call,
      store: second,
    });

    assert.equal(twice.created, 0);
    assert.equal(twice.merged, 0);
    assert.equal(twice.topics.length, 3);
    assert.equal(second.added.length, 0);
    assert.equal(second.updated.length, 0);
  });

  it("merges same-name topics: refs union, details kept, no dupes", () => {
    const existing: Entry[] = [
      {
        id: "t-1",
        title: "Photosynthese",
        detail: "Chlorophyll fängt Licht ein.",
        subject: "Biologie",
        parentId: null,
        sourceRefs: [{ documentId: "deck-1", label: "Folie 2" }],
        topicData: {
          concepts: ["Chlorophyll"],
          formulas: [],
          examples: [],
          prerequisites: [],
        },
      },
    ];
    const merged = mergeExtractedTopics(
      existing,
      [
        {
          topic: {
            name: "Photosynthese!",
            summary: "Wasser und CO2 als Ausgangsstoffe.",
            concepts: ["Kohlenstoffdioxid"],
            formulas: [],
            examples: [],
            prerequisites: [],
            parent: null,
            refs: ["Folie 2", "Folie 4"],
          },
          documentId: "deck-1",
        },
      ],
      "Biologie",
      () => "t-new",
    );

    assert.equal(merged.created, 0);
    assert.equal(merged.merged, 1);
    assert.equal(merged.entries.length, 1);
    assert.deepEqual(
      (merged.entries[0]?.sourceRefs ?? [])
        .map((ref) => ref.label)
        .sort(),
      ["Folie 2", "Folie 4"],
    );
    assert.match(merged.entries[0]?.detail ?? "", /Chlorophyll/);
    assert.match(merged.entries[0]?.detail ?? "", /Ausgangsstoffe/);
    assert.deepEqual(
      [...(merged.entries[0]?.topicData?.concepts ?? [])].sort(),
      ["Chlorophyll", "Kohlenstoffdioxid"],
    );
  });

  it("retries skipped spans, then reports honestly (retryable)", async () => {
    let calls = 0;
    const call = async () => {
      calls += 1;

      if (calls === 1) {
        return response({
          spansDone: [],
          skippedSpans: ["Folie 1"],
          done: false,
        });
      }

      return response({
        spansDone: ["Folie 1"],
        topics: [topicDto("Ökologie", ["Folie 6"])],
        done: true,
      });
    };
    const store = makeStore();
    let next = 0;

    const summary = await runDocumentTopicExtraction({
      documentId: "deck-1",
      subject: "Biologie",
      locale: "de",
      topics: [],
      makeId: () => `r-${(next += 1)}`,
      call,
      store,
    });

    assert.equal(calls, 2);
    assert.equal(summary.done, true);
    assert.equal(summary.created, 1);
    assert.deepEqual(summary.skippedSpans, []);
  });

  it("reports insufficient text honestly without inventing topics", async () => {
    const store = makeStore();
    const summary = await runDocumentTopicExtraction({
      documentId: "deck-1",
      subject: "Biologie",
      locale: "de",
      topics: [],
      makeId: () => "x-1",
      call: async () =>
        response({ insufficient: true, done: true, spansDone: [] }),
      store,
    });

    assert.equal(summary.insufficient, true);
    assert.equal(summary.done, true);
    assert.equal(summary.created, 0);
    assert.equal(store.added.length, 0);
    assert.equal(
      formatTopicSummary(summary),
      "Kein ausreichender Text für Themen gefunden.",
    );
    assert.deepEqual(
      classifyTopicError(new Error("Kein lesbarer Text in den Folien.")),
      {
        cause: "empty",
        detail: "Kein lesbarer Text in den Folien.",
        retryable: false,
      },
    );
  });
});
