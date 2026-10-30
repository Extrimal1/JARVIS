"use client";

import { Plus } from "lucide-react";
import type { ConversationThread } from "@/src/lib/conversation";

/**
 * Thread navigation for the shared conversation panel: pick a
 * previous conversation or start a new one. Both Dashboard and
 * /assistant render this same component over the same threads.
 */

const DATE_FORMAT = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
});

export function ThreadPicker({
  threads,
  selectedId,
  onSelect,
  onNew,
  disabled,
}: {
  threads: ConversationThread[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onNew: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label="Unterhaltung wählen"
        className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-200 outline-none focus:border-cyan-400 disabled:opacity-50"
        value={selectedId ?? ""}
        disabled={disabled || threads.length === 0}
        onChange={(event) =>
          onSelect(event.target.value === "" ? null : event.target.value)
        }
      >
        {threads.length === 0 ? (
          <option value="">Neue Unterhaltung</option>
        ) : (
          threads.map((thread) => (
            <option key={thread.id} value={thread.id}>
              {thread.title} ·{" "}
              {DATE_FORMAT.format(new Date(thread.updatedAt))}
            </option>
          ))
        )}
      </select>
      <button
        type="button"
        onClick={onNew}
        disabled={disabled}
        title="Neue Unterhaltung"
        aria-label="Neue Unterhaltung"
        className="flex shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 p-1.5 text-slate-300 transition-colors hover:border-cyan-400 hover:text-cyan-300 disabled:opacity-50"
      >
        <Plus size={18} />
      </button>
    </div>
  );
}
