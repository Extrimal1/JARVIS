"use client";

import { useState } from "react";
import { Check, Eye, X } from "lucide-react";
import { useToday } from "@/src/hooks/useToday";
import { formatDayShort } from "@/src/lib/briefing";
import type { QuizQuestion } from "@/src/lib/quiz";
import {
  scheduleQuizReview,
  type QuizRating,
  type QuizReviewPatch,
} from "@/src/lib/quizReview";

const RATINGS: { key: QuizRating; label: string }[] = [
  { key: "again", label: "Nochmal" },
  { key: "hard", label: "Schwer" },
  { key: "good", label: "Gut" },
  { key: "easy", label: "Leicht" },
];

const STATUS_LABELS: Record<string, string> = {
  learning: "Lernt",
  review: "Wiederholung",
  mastered: "Gemeistert",
};

/**
 * Self-contained due-question reviewer: answer, see the correct
 * solution with explanation, then rate the difficulty. The rating
 * schedules the next review through the shared SM-2-inspired
 * scheduler; persistence happens through `onRate`.
 */
export function QuestionReviewer({
  question,
  onRate,
  onClose,
}: {
  question: QuizQuestion;
  onRate: (
    patch: QuizReviewPatch,
    info: { correct: boolean; rating: QuizRating },
  ) => Promise<{ ok: boolean; error?: string }>;
  onClose: () => void;
}) {
  const today = useToday();
  const kind = question.kind ?? "single";
  const correctSet = new Set(
    kind === "multiple"
      ? (question.correctIndices ?? [question.correctIndex])
      : [question.correctIndex],
  );

  const [picked, setPicked] = useState<number | null>(null);
  const [pickedMany, setPickedMany] = useState<number[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [selfCorrect, setSelfCorrect] = useState<boolean | null>(null);
  const [checked, setChecked] = useState(false);
  const [correct, setCorrect] = useState(false);
  const [ratingBusy, setRatingBusy] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);
  const [done, setDone] = useState<QuizReviewPatch | null>(null);

  function toggleMany(index: number) {
    setPickedMany((current) =>
      current.includes(index)
        ? current.filter((entry) => entry !== index)
        : [...current, index],
    );
  }

  function checkAnswer() {
    if (kind === "multiple") {
      const chosen = new Set(pickedMany);
      const sameSize = chosen.size === correctSet.size;
      const sameItems = [...chosen].every((index) => correctSet.has(index));

      setCorrect(sameSize && sameItems);
    } else {
      setCorrect(picked === question.correctIndex);
    }

    setChecked(true);
  }

  async function rate(rating: QuizRating) {
    if (today === null || ratingBusy || done !== null) return;

    const isCorrect = kind === "free" ? selfCorrect === true : correct;
    const patch = scheduleQuizReview(question, isCorrect, rating, today);

    setRatingBusy(true);
    setRateError(null);

    const result = await onRate(patch, { correct: isCorrect, rating });

    setRatingBusy(false);

    if (!result.ok) {
      setRateError(result.error ?? "Speichern fehlgeschlagen.");
      return;
    }

    setDone(patch);
  }

  if (done !== null) {
    return (
      <div className="jarvis-fade rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm">
        <p className="flex items-center gap-2 font-medium text-emerald-100">
          <Check size={16} />
          Eingeplant — nächste Wiederholung:{" "}
          {formatDayShort(done.nextReviewAt ?? today ?? "")}
        </p>
        <p className="mt-1 text-xs text-emerald-200/70">
          Status: {STATUS_LABELS[done.reviewStatus ?? "learning"] ?? "Lernt"} ·{" "}
          {done.successCount ?? 0}{" "}
          {(done.successCount ?? 0) === 1 ? "Erfolg" : "Erfolge"}
        </p>
        <button
          onClick={onClose}
          className="mt-3 rounded-xl border border-white/10 px-4 py-2 text-xs text-slate-300 hover:bg-white/5"
        >
          Schließen
        </button>
      </div>
    );
  }

  const needsRating =
    kind === "free" ? selfCorrect !== null : checked;

  return (
    <div className="jarvis-fade space-y-3 rounded-xl border border-white/[0.06] bg-black/20 p-4">
      {(kind === "single" || kind === "multiple") && (
        <div className="space-y-2" role="group" aria-label="Antwortmöglichkeiten">
          {question.options.map((option, index) => {
            const isPicked =
              kind === "multiple"
                ? pickedMany.includes(index)
                : picked === index;
            const isCorrectOption = correctSet.has(index);
            const showCorrect = checked && isCorrectOption;
            const showWrong = checked && isPicked && !isCorrectOption;

            return (
              <button
                key={index}
                disabled={checked}
                onClick={() =>
                  kind === "multiple"
                    ? toggleMany(index)
                    : setPicked(index)
                }
                aria-pressed={isPicked}
                className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left text-sm transition ${
                  showCorrect
                    ? "border-emerald-400/50 bg-emerald-400/10 text-emerald-100"
                    : showWrong
                      ? "border-rose-400/50 bg-rose-400/10 text-rose-100"
                      : isPicked
                        ? "border-cyan-300/50 bg-cyan-300/10 text-cyan-100"
                        : "border-white/10 text-slate-300 hover:border-white/25"
                } ${checked ? "" : "cursor-pointer"}`}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                    showCorrect
                      ? "border-emerald-400 bg-emerald-400 text-slate-950"
                      : showWrong
                        ? "border-rose-400 bg-rose-400 text-slate-950"
                        : isPicked
                          ? "border-cyan-300 bg-cyan-300 text-slate-950"
                          : "border-slate-600 text-slate-500"
                  }`}
                >
                  {showCorrect || (isPicked && !checked) ? (
                    <Check size={13} />
                  ) : (
                    String.fromCharCode(65 + index)
                  )}
                </span>
                <span className="min-w-0 flex-1">{option}</span>
              </button>
            );
          })}
        </div>
      )}

      {kind === "free" && !revealed && (
        <button
          onClick={() => setRevealed(true)}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-cyan-300/25 px-4 py-2.5 text-sm text-cyan-200 transition hover:border-cyan-300/50"
        >
          <Eye size={15} />
          Antwort zeigen
        </button>
      )}

      {kind === "free" && revealed && (
        <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3 text-sm leading-6">
          <p className="font-medium text-slate-100">
            {question.options[question.correctIndex] ?? ""}
          </p>
          {question.explanation !== "" && (
            <p className="mt-2 text-slate-300">{question.explanation}</p>
          )}
          {(question.sourceRefs ?? []).length > 0 && (
            <p className="mt-2 text-xs text-slate-500">
              Quelle: {(question.sourceRefs ?? []).join("; ")}
            </p>
          )}
          {question.gradingCriteria !== undefined &&
            question.gradingCriteria !== "" && (
              <p className="mt-2 text-xs text-slate-500">
                Bewertung: {question.gradingCriteria}
              </p>
            )}
          {selfCorrect === null && (
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => setSelfCorrect(true)}
                className="flex-1 rounded-xl bg-emerald-400 px-4 py-2 text-xs font-medium text-slate-950 transition hover:bg-emerald-300"
              >
                Gewusst
              </button>
              <button
                onClick={() => setSelfCorrect(false)}
                className="flex-1 rounded-xl bg-rose-400 px-4 py-2 text-xs font-medium text-slate-950 transition hover:bg-rose-300"
              >
                Nicht gewusst
              </button>
            </div>
          )}
        </div>
      )}

      {kind !== "free" && !checked && (
        <button
          onClick={checkAnswer}
          disabled={
            kind === "multiple" ? pickedMany.length === 0 : picked === null
          }
          className="w-full rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Prüfen
        </button>
      )}

      {kind !== "free" && checked && (
        <div
          className={`rounded-xl border p-3 text-sm leading-6 ${
            correct
              ? "border-emerald-400/30 bg-emerald-400/5 text-emerald-100"
              : "border-rose-400/30 bg-rose-400/5 text-rose-100"
          }`}
        >
          <p className="flex items-center gap-2 font-medium">
            {correct ? (
              <>
                <Check size={15} /> Richtig!
              </>
            ) : (
              <>
                <X size={15} /> Falsch — richtig wäre:{" "}
                {[...correctSet]
                  .sort((a, b) => a - b)
                  .map((index) => question.options[index])
                  .filter((option) => option !== undefined)
                  .join("; ")}
              </>
            )}
          </p>
          {question.explanation !== "" && (
            <p className="mt-1 text-slate-300">{question.explanation}</p>
          )}
          {(question.sourceRefs ?? []).length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              Quelle: {(question.sourceRefs ?? []).join("; ")}
            </p>
          )}
        </div>
      )}

      {needsRating && (
        <div>
          <p className="text-xs text-slate-400">
            Wie schwer war das? Das plant die nächste Wiederholung.
          </p>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {RATINGS.map((rating) => (
              <button
                key={rating.key}
                onClick={() => void rate(rating.key)}
                disabled={today === null || ratingBusy}
                className="rounded-xl border border-white/10 px-2 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {rating.label}
              </button>
            ))}
          </div>
          {today === null && (
            <p className="mt-2 text-xs text-slate-500">Wird geladen …</p>
          )}
        </div>
      )}

      {rateError !== null && (
        <p role="alert" className="text-xs text-rose-300">
          {rateError}
        </p>
      )}
    </div>
  );
}
