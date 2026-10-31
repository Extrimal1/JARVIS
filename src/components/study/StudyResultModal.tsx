"use client";

import { Check, Loader2, X } from "lucide-react";
import { Modal } from "@/src/components/study/Modal";

export type StudyResultSaveState = "idle" | "saving" | "saved";

/**
 * Full-text view for AI summaries and explanations. Document cards
 * only ever show a short preview; the complete generated content
 * lives here, separated from document management.
 */
export function StudyResultModal({
  title,
  meta,
  text,
  refsUsed,
  note,
  sections,
  saveState,
  onSave,
  onClose,
}: {
  title: string;
  meta?: string;
  text: string;
  refsUsed: string[];
  note?: string | null;
  sections?: { label: string; text: string }[];
  saveState: StudyResultSaveState;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <Modal titleId="study-result-title" onClose={onClose}>
      <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              id="study-result-title"
              className="truncate text-lg font-semibold"
            >
              {title}
            </h2>
            {meta !== undefined && meta !== "" && (
              <p className="mt-1 text-xs text-slate-500">{meta}</p>
            )}
          </div>

          <button
            onClick={onClose}
            aria-label="Schließen"
            className="shrink-0 rounded-xl border border-white/10 p-2 text-slate-400 transition hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <p className="whitespace-pre-wrap text-sm leading-6 text-slate-200">
            {text}
          </p>

          {refsUsed.length > 0 && (
            <p className="mt-3 text-xs leading-5 text-slate-500">
              Quellen: {refsUsed.join("; ")}
            </p>
          )}

          {note !== undefined && note !== null && note !== "" && (
            <p className="mt-2 text-xs leading-5 text-amber-200/80">{note}</p>
          )}

          {sections !== undefined && sections.length > 0 && (
            <div className="mt-4 border-t border-white/[0.06] pt-3">
              <p className="text-xs font-medium text-slate-400">
                Abschnitte ({sections.length})
              </p>
              {sections.map((section) => (
                <div key={section.label} className="mt-2">
                  <p className="text-xs font-medium text-slate-300">
                    {section.label}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-slate-400">
                    {section.text}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onSave}
            disabled={saveState !== "idle"}
            className="flex items-center gap-1.5 rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saveState === "saving" ? (
              <Loader2 size={16} className="motion-safe:animate-spin" />
            ) : saveState === "saved" ? (
              <Check size={16} />
            ) : null}
            {saveState === "saving"
              ? "Wird gespeichert …"
              : saveState === "saved"
                ? "Gespeichert"
                : "Als Lernmaterial speichern"}
          </button>
          <button
            onClick={onClose}
            className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
          >
            Schließen
          </button>
        </div>
    </Modal>
  );
}
