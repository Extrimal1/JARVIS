"use client";

import { Check, X } from "lucide-react";
import type { ViewStep, ViewTurn } from "@/src/lib/assistant/transcript";

/**
 * One persisted turn: user message or assistant answer with its tool
 * activity. Activity rows show which real data was accessed (and
 * whether it worked); the answer is the model's explanation on top.
 * Nothing here renders raw envelopes — unparseable entries never
 * reach this component (see transcriptToTurns).
 */

function StepRow({ step }: { step: ViewStep }) {
  return (
    <li className="flex items-center gap-1.5 text-xs text-slate-400">
      {step.ok === null ? (
        <span
          aria-hidden
          className="inline-block h-3 w-3 rounded-full border border-slate-500"
        />
      ) : step.ok ? (
        <Check size={14} className="text-emerald-400" aria-label="Erfolgreich" />
      ) : (
        <X size={14} className="text-rose-400" aria-label="Fehlgeschlagen" />
      )}
      <span>{step.label}</span>
    </li>
  );
}

export function TurnView({
  turn,
  onClarify,
  disabled,
}: {
  turn: ViewTurn;
  onClarify: (text: string) => void;
  disabled: boolean;
}) {
  if (turn.kind === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-line rounded-xl rounded-br-sm border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-sm text-slate-100">
          {turn.text}
        </p>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-2 rounded-xl rounded-bl-sm border border-slate-700 bg-slate-800/60 px-3 py-2">
        {turn.steps.length > 0 && (
          <div>
            <p className="mb-1 text-[11px] font-medium tracking-wide text-slate-500 uppercase">
              Datenquellen
            </p>
            <ul className="space-y-1">
              {turn.steps.map((step, index) => (
                <StepRow key={`${step.tool}-${index}`} step={step} />
              ))}
            </ul>
          </div>
        )}
        {turn.answer !== "" && (
          <p className="text-sm whitespace-pre-line text-slate-200">
            {turn.answer}
          </p>
        )}
        {turn.clarify.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {turn.clarify.map((option) => (
              <button
                key={option.label}
                type="button"
                disabled={disabled}
                onClick={() => onClarify(option.text)}
                className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200 transition-colors hover:bg-cyan-400/20 disabled:opacity-50"
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
