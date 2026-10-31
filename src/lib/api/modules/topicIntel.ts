/**
 * Topic-extraction server logic: grounded per-span topic
 * proposals over the coverage sweep plan. Generation only —
 * merging and persistence stay client-side (same split as the
 * question batches), so local and cloud share the merge code.
 * Truncated or unparseable spans are skipped honestly and can
 * be retried; they never poison the extracted set.
 */

import {
  chatWithOllama,
  type LlmMessage,
} from "@/src/lib/assistant/llm";
import type { AssistantLocale } from "@/src/lib/assistant/actions";
import {
  dbGetOne,
  type DbClient,
} from "@/src/lib/supabase/db";
import { formatSourceRefs } from "@/src/lib/study/extract";
import {
  planSummarySweep,
  SUMMARY_SPAN_BUDGET_CHARS,
} from "@/src/lib/study/coverage";
import {
  MAX_EXTRACT_SPANS,
  parseTopicsWithRepair,
  topicExtractionPrompt,
  TOPIC_EXTRACT_NUM_PREDICT,
  TopicsParseError,
  type ExtractedTopic,
} from "@/src/lib/study/topics";
import {
  assertCompleteQuestions,
  QuestionsTruncatedError,
} from "@/src/lib/study/questions";
import type { TopicsExtractResponse } from "@/src/lib/study/protocol";
import {
  loadOrderedChunks,
  toGroundedSources,
} from "@/src/lib/api/modules/studyIntel";

export type TopicExtractInput = {
  documentId: string;
  locale: AssistantLocale;
  /** Sweep span labels already extracted (client-driven resume). */
  coveredLabels: string[];
  maxSpans: number;
};

export function validTopicExtractInput(
  value: unknown,
): TopicExtractInput | null {
  if (typeof value !== "object" || value === null) return null;

  const record = value as Record<string, unknown>;

  if (typeof record.documentId !== "string" || record.documentId === "") {
    return null;
  }

  if (record.locale !== "de" && record.locale !== "ru") return null;

  if (
    !Array.isArray(record.coveredLabels) ||
    !record.coveredLabels.every((label): label is string => typeof label === "string")
  ) {
    return null;
  }

  const maxSpans =
    typeof record.maxSpans === "number" &&
    Number.isInteger(record.maxSpans) &&
    record.maxSpans > 0
      ? Math.min(record.maxSpans, MAX_EXTRACT_SPANS)
      : MAX_EXTRACT_SPANS;

  return {
    documentId: record.documentId,
    locale: record.locale,
    coveredLabels: record.coveredLabels,
    maxSpans,
  };
}

export type TopicExtractOutcome =
  | { ok: true; response: TopicsExtractResponse }
  | { ok: false; http: 404 | 409; message: string };

/**
 * Extracts topics from the next uncovered sweep spans (bounded
 * per call). Skipped spans stay retryable via a later call with
 * updated coveredLabels.
 */
export async function extractTopics(
  db: DbClient,
  input: TopicExtractInput,
): Promise<TopicExtractOutcome> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "study_documents",
    input.documentId,
  );

  if (row === null) {
    return { ok: false, http: 404, message: "Dokument nicht gefunden." };
  }

  if (row.extraction_status !== "completed") {
    return {
      ok: false,
      http: 409,
      message: "Das Dokument ist noch nicht verarbeitet.",
    };
  }

  const documentName =
    typeof row.name === "string" && row.name !== "" ? row.name : "Dokument";
  const chunks = await loadOrderedChunks(db, input.documentId);
  const plan = planSummarySweep(chunks, SUMMARY_SPAN_BUDGET_CHARS, {});

  if (plan.length === 0) {
    return {
      ok: true,
      response: {
        documentId: input.documentId,
        documentName,
        spansDone: [],
        skippedSpans: [],
        topics: [],
        droppedInvalid: 0,
        droppedUngrounded: 0,
        repaired: false,
        insufficient: true,
        done: true,
      },
    };
  }

  const usable = plan.flatMap((span) => span.units);
  const covered = new Set(input.coveredLabels);
  const todo = plan
    .filter((span) => !covered.has(span.label))
    .slice(0, input.maxSpans);
  const spansDone: string[] = [];
  const skippedSpans: string[] = [];
  const topics: ExtractedTopic[] = [];
  let droppedInvalid = 0;
  let droppedUngrounded = 0;
  let repaired = false;

  const call = async (messages: LlmMessage[]): Promise<string> => {
    const result = await chatWithOllama(messages, {
      temperature: 0,
      numPredict: TOPIC_EXTRACT_NUM_PREDICT,
      format: "json",
      think: false,
    });

    assertCompleteQuestions({
      content: result.content,
      doneReason: result.doneReason,
      evalCount: result.evalCount,
      thinkingChars: result.thinkingChars,
    });

    return result.content;
  };

  for (const span of todo) {
    const wanted = new Set(span.chunkIndices);
    const picked = chunks.filter((chunk) => wanted.has(chunk.index));
    const sources = toGroundedSources(
      picked.map((chunk) => ({
        text: chunk.text,
        refLabel: formatSourceRefs(chunk.refs),
        documentName,
      })),
    );

    try {
      const parsed = await parseTopicsWithRepair(
        call,
        topicExtractionPrompt(
          input.locale,
          documentName,
          span.label,
          sources,
        ),
        sources,
        usable,
        input.locale,
      );

      topics.push(...parsed.topics);
      droppedInvalid += parsed.droppedInvalid;
      droppedUngrounded += parsed.droppedUngrounded;
      repaired = repaired || parsed.repaired;
      spansDone.push(span.label);
      covered.add(span.label);
    } catch (error: unknown) {
      if (
        error instanceof QuestionsTruncatedError ||
        error instanceof TopicsParseError
      ) {
        skippedSpans.push(span.label);
        continue;
      }

      throw error;
    }
  }

  console.log(
    `[api:study] topics doc=${input.documentId} spans=${spansDone.length}/${plan.length} topics=${topics.length} skipped=${skippedSpans.length} repaired=${repaired}`,
  );

  return {
    ok: true,
    response: {
      documentId: input.documentId,
      documentName,
      spansDone,
      skippedSpans,
      topics,
      droppedInvalid,
      droppedUngrounded,
      repaired,
      insufficient: false,
      done: plan.every((span) => covered.has(span.label)),
    },
  };
}
