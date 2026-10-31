/**
 * Evidence-based mastery: recent answers matter more than old
 * ones, repeated mistakes lower the level, and thin evidence
 * never passes as mastery. Pure and deterministic — every
 * threshold is named, explained in the reasons, and tested.
 * Reading alone produces no events, so it can never advance
 * mastery. The review scheduler stays untouched; this only
 * reads its outcomes.
 */

import { QUIZ_RATING_QUALITY } from "@/src/lib/quizReview";
import type {
  Entry,
  MasteryEvidence,
  StudyPlan,
  TopicMastery,
} from "@/src/lib/study";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { ReviewEvent } from "@/src/lib/study/reviewEvents";

/** Recent window: last N answers decide recency signals. */
export const RECENT_WINDOW = 10;

/** Fewer attempts than this never score (insufficient). */
export const MIN_ATTEMPTS_SCORED = 3;

/** Mastered needs volume plus a proven recent window. */
export const MIN_ATTEMPTS_MASTERED = 8;
export const MIN_RECENT_MASTERED = 5;

/** Composite score cutoffs (0..100). */
export const SCORE_MASTERED = 85;
export const SCORE_UNDERSTOOD = 70;

/** Recent accuracy below this (with ≥3 recent) needs revision. */
export const WEAK_RECENT_ACCURACY = 0.5;

/** Consecutive recent failures that force needs-revision. */
export const FAIL_STREAK_TRIP = 3;

export type TopicMasteryResult = {
  mastery: TopicMastery;
  evidence: MasteryEvidence;
};

function qualityOfEvent(event: ReviewEvent): number {
  return (QUIZ_RATING_QUALITY[event.rating] ?? 3) / 5;
}

function qualityOfQuestion(question: QuizQuestion): number | null {
  if (
    typeof question.difficulty !== "number" ||
    question.difficulty < 1 ||
    question.difficulty > 5
  ) {
    return null;
  }

  return question.difficulty / 5;
}

/**
 * Mastery of one topic from cumulative counters (all-time) and
 * the recency-weighted event log. Explanations name every input
 * so the level is never a black box.
 */
export function computeTopicMastery(
  topicId: string,
  questions: QuizQuestion[],
  events: ReviewEvent[],
  nowISO: string,
): TopicMasteryResult {
  const linked = questions.filter(
    (question) => question.topicId === topicId,
  );
  const log = events
    .filter((event) => event.topicId === topicId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recent = log.slice(0, RECENT_WINDOW);

  let attempts = 0;
  let successes = 0;

  for (const question of linked) {
    if (
      typeof question.reviewCount === "number" &&
      question.reviewCount > 0 &&
      typeof question.successCount === "number"
    ) {
      attempts += question.reviewCount;
      successes += question.successCount;
    }
  }

  // Events may predate counter backfills — volume is the max.
  const total = Math.max(attempts, log.length);
  const allTime = attempts > 0 ? successes / attempts : null;
  const recentAccuracy =
    recent.length > 0
      ? recent.filter((event) => event.correct).length / recent.length
      : null;
  const effectiveRecent = recentAccuracy ?? allTime;

  let failStreak = 0;

  for (const event of log) {
    if (event.correct) break;
    failStreak += 1;
  }

  const qualities =
    recent.length > 0
      ? recent.map(qualityOfEvent)
      : linked
          .map(qualityOfQuestion)
          .filter((value): value is number => value !== null);
  const avgQuality =
    qualities.length > 0
      ? qualities.reduce((sum, value) => sum + value, 0) / qualities.length
      : null;

  const kinds = [
    ...new Set([
      ...log.map((event) => event.kind),
      ...linked.map((question) => question.kind ?? "single"),
    ]),
  ].sort();
  const breadth = kinds.length >= 2 ? 1 : kinds.length === 1 ? 0.5 : 0;

  const reasons: string[] = [];

  if (total === 0) {
    reasons.push("Noch keine Fragen beantwortet.");
  } else {
    reasons.push(
      `${total} beantwortete ${total === 1 ? "Frage" : "Fragen"}.`,
    );
  }

  if (recentAccuracy !== null) {
    reasons.push(
      `Letzte ${recent.length}: ${Math.round(recentAccuracy * 100)} % korrekt.`,
    );
  } else if (allTime !== null) {
    reasons.push(
      `Gesamtquote ${Math.round(allTime * 100)} % (keine Detailhistorie).`,
    );
  }

  if (failStreak >= FAIL_STREAK_TRIP) {
    reasons.push(`${failStreak} Fehler in Folge — Wiederholung nötig.`);
  }

  if (kinds.length > 0) {
    reasons.push(`Fragearten: ${kinds.join(", ")}.`);
  }

  // Insufficient evidence: cap at learning, no score.
  if (total === 0) {
    return {
      mastery: "not-started",
      evidence: {
        quizAccuracy: null,
        reviews: 0,
        ratedAt: nowISO,
        score: null,
        reasons,
        kinds,
      },
    };
  }

  if (total < MIN_ATTEMPTS_SCORED) {
    reasons.push("Zu wenig Versuche für eine Bewertung.");

    return {
      mastery: "learning",
      evidence: {
        quizAccuracy: effectiveRecent,
        reviews: total,
        ratedAt: nowISO,
        score: null,
        reasons,
        kinds,
      },
    };
  }

  const score = Math.round(
    50 * (effectiveRecent ?? 0) +
      20 * (allTime ?? 0) +
      10 * Math.min(1, total / 20) +
      10 * (avgQuality ?? 0) +
      10 * breadth,
  );

  let mastery: TopicMastery = "learning";

  if (failStreak >= FAIL_STREAK_TRIP) {
    mastery = "needs-revision";
  } else if (
    recent.length >= MIN_ATTEMPTS_SCORED &&
    (recentAccuracy ?? 1) < WEAK_RECENT_ACCURACY
  ) {
    mastery = "needs-revision";
    reasons.push("Aktuelle Trefferquote unter 50 %.");
  } else if (
    score >= SCORE_MASTERED &&
    total >= MIN_ATTEMPTS_MASTERED &&
    recent.length >= MIN_RECENT_MASTERED
  ) {
    mastery = "mastered";
    reasons.push("Stabile Leistung über viele Versuche.");
  } else if (score >= SCORE_UNDERSTOOD) {
    mastery = "understood";
  }

  return {
    mastery,
    evidence: {
      quizAccuracy: effectiveRecent,
      reviews: total,
      ratedAt: nowISO,
      score,
      reasons,
      kinds,
    },
  };
}

/** Recomputes mastery for every given topic (stable id order). */
export function recomputeMastery(
  topics: Entry[],
  questions: QuizQuestion[],
  events: ReviewEvent[],
  nowISO: string,
): Map<string, TopicMasteryResult> {
  const out = new Map<string, TopicMasteryResult>();
  const ordered = [...topics].sort((a, b) => a.id.localeCompare(b.id));

  for (const topic of ordered) {
    out.set(
      topic.id,
      computeTopicMastery(topic.id, questions, events, nowISO),
    );
  }

  return out;
}

export type ExamReadiness = {
  /** 0..100, null when no evidence exists at all. */
  score: number | null;
  label: string;
  explanation: string[];
};

/**
 * Honest readiness estimate from mastery mix (50 %), recent
 * accuracy (30 %), and plan completion (20 %). Missing inputs
 * drop out instead of inventing signal; the label never
 * promises an exam result.
 */
export function examReadiness(
  exam: Entry,
  topics: Entry[],
  questions: QuizQuestion[],
  events: ReviewEvent[],
): ExamReadiness {
  const linkedIds =
    exam.examData?.topicIds !== undefined &&
    exam.examData.topicIds.length > 0
      ? new Set(exam.examData.topicIds)
      : null;
  const scoped =
    linkedIds !== null
      ? topics.filter((topic) => linkedIds.has(topic.id))
      : exam.subject !== undefined && exam.subject !== ""
        ? topics.filter((topic) => topic.subject === exam.subject)
        : [];
  const topicIds = new Set(scoped.map((topic) => topic.id));
  const explanation: string[] = [];
  const parts: { weight: number; value: number; label: string }[] = [];

  if (scoped.length > 0) {
    const points: Record<TopicMastery, number> = {
      "not-started": 0,
      learning: 40,
      "needs-revision": 25,
      understood: 75,
      mastered: 100,
    };
    const mean =
      scoped.reduce(
        (sum, topic) => sum + (points[topic.mastery ?? "not-started"] ?? 0),
        0,
      ) / scoped.length;

    parts.push({ weight: 0.5, value: mean, label: "Lernstand" });
    explanation.push(
      `Lernstand: ${Math.round(mean)} von 100 aus ${scoped.length} ${scoped.length === 1 ? "Thema" : "Themen"}.`,
    );
  }

  const recent = events
    .filter(
      (event) =>
        (event.topicId !== null && topicIds.has(event.topicId)) ||
        event.examId === exam.id,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, RECENT_WINDOW);

  if (recent.length >= MIN_ATTEMPTS_SCORED) {
    const accuracy =
      (recent.filter((event) => event.correct).length / recent.length) * 100;

    parts.push({ weight: 0.3, value: accuracy, label: "Trefferquote" });
    explanation.push(
      `Aktuelle Trefferquote: ${Math.round(accuracy)} % aus den letzten ${recent.length} Antworten.`,
    );
  }

  const plan: StudyPlan | null | undefined = exam.examData?.plan;
  const done =
    plan?.tasks.filter((task) => task.status === "done").length ?? 0;
  const open =
    plan?.tasks.filter((task) => task.status === "open").length ?? 0;

  if ((plan?.tasks.length ?? 0) > 0 && done + open > 0) {
    const completion = (done / (done + open)) * 100;

    parts.push({ weight: 0.2, value: completion, label: "Plan" });
    explanation.push(
      `Planfortschritt: ${done} von ${done + open} Aufgaben erledigt.`,
    );
  }

  if (parts.length === 0) {
    return {
      score: null,
      label: "Keine Daten",
      explanation: [
        "Noch keine Themen, Antworten oder Pläne — keine Einschätzung möglich.",
      ],
    };
  }

  const weightSum = parts.reduce((sum, part) => sum + part.weight, 0);
  const score = Math.round(
    parts.reduce((sum, part) => sum + part.weight * part.value, 0) / weightSum,
  );

  explanation.push("Schätzung aus dem Lernstand — keine Erfolgsgarantie.");

  return {
    score,
    label:
      score >= 75 ? "Gut vorbereitet" : score >= 50 ? "Auf Kurs" : "Noch viel zu tun",
    explanation,
  };
}
