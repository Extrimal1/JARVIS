import { authed } from "@/src/lib/api/withAuth";
import { fail, failFromUnknown, ok, readJson } from "@/src/lib/api/respond";
import {
  dbGetOne,
  dbInsert,
  dbList,
  type DbClient,
} from "@/src/lib/supabase/db";
import { dbFromAuth } from "@/src/lib/supabase/db";
import {
  MAX_REVIEW_EVENTS,
  type ReviewEvent,
} from "@/src/lib/study/reviewEvents";
import type { QuestionKind } from "@/src/lib/quiz";
import type { QuizRating } from "@/src/lib/quizReview";

const RATINGS: readonly string[] = ["again", "hard", "good", "easy"];

function toDomain(row: Record<string, unknown>): ReviewEvent | null {
  if (
    typeof row.id !== "string" ||
    typeof row.question_id !== "string" ||
    (row.topic_id !== null && typeof row.topic_id !== "string") ||
    (row.exam_id !== null && typeof row.exam_id !== "string") ||
    typeof row.kind !== "string" ||
    typeof row.correct !== "boolean" ||
    typeof row.rating !== "string" ||
    typeof row.created_at !== "string"
  ) {
    return null;
  }

  return {
    id: row.id,
    questionId: row.question_id,
    topicId: row.topic_id,
    examId: row.exam_id,
    kind: row.kind as QuestionKind,
    correct: row.correct,
    rating: row.rating as QuizRating,
    createdAt: row.created_at,
  };
}

/** GET /api/quiz/reviews → own events, newest first (capped). */
export const GET = authed(async (_request, auth) => {
  try {
    const db: DbClient | null = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const rows = await dbList<Record<string, unknown>>(db, "study_review_events", {
      select: "id,question_id,topic_id,exam_id,kind,correct,rating,created_at",
      order: "created_at.desc",
      limit: MAX_REVIEW_EVENTS,
    });
    const events: ReviewEvent[] = [];

    for (const row of rows) {
      const event = toDomain(row);

      if (event !== null) events.push(event);
    }

    return ok(events);
  } catch (error) {
    return failFromUnknown("study", error);
  }
});

/**
 * POST /api/quiz/reviews { questionId, correct, rating } →
 * appended event. Topic/exam/kind are stamped server-side from
 * the owned question row — foreign questions fail like missing
 * ones, so clients cannot spoof links.
 */
export const POST = authed(async (request, auth) => {
  try {
    const db: DbClient | null = dbFromAuth(auth);

    if (db === null) {
      return fail("cloud-not-configured", "Cloud-Backend ist nicht konfiguriert.", 503);
    }

    const body = (await readJson(request)) as Record<string, unknown> | null;

    if (
      body === null ||
      typeof body.questionId !== "string" ||
      body.questionId === "" ||
      typeof body.correct !== "boolean" ||
      typeof body.rating !== "string" ||
      !RATINGS.includes(body.rating)
    ) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    const question = await dbGetOne<Record<string, unknown>>(
      db,
      "quiz_questions",
      body.questionId,
    );

    if (question === null) {
      return fail("not-found", "Frage nicht gefunden.", 404);
    }

    const rows = await dbInsert<Record<string, unknown>>(db, "study_review_events", [
      {
        question_id: body.questionId,
        topic_id:
          typeof question.topic_id === "string" ? question.topic_id : null,
        exam_id: typeof question.exam_id === "string" ? question.exam_id : null,
        kind: typeof question.kind === "string" ? question.kind : "single",
        correct: body.correct,
        rating: body.rating,
      },
    ]);
    const event = rows[0] !== undefined ? toDomain(rows[0]) : null;

    if (event === null) {
      return fail("bad-request", "Ungültige Anfrage.", 400);
    }

    return ok(event);
  } catch (error) {
    return failFromUnknown("study", error);
  }
});
