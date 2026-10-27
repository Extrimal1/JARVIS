"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Brain,
  Check,
  Info,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import Sidebar from "@/src/components/Sidebar";
import { useToday } from "@/src/hooks/useToday";
import { useMemory } from "@/src/lib/db/useModules";
import {
  MEMORY_CATEGORY_LABELS,
  MEMORY_CATEGORIES,
  activeMemory,
  createMemoryEntry,
  detectSensitiveHint,
  isExpired,
  needsReview,
  usageOf,
  type MemoryCategory,
  type MemoryEntry,
  type MemoryOrigin,
} from "@/src/lib/memory";

const DATE_FORMAT = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

function formatStamp(iso: string): string {
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return iso;

  return DATE_FORMAT.format(date);
}

type CategoryFilter = "all" | MemoryCategory;
type OriginFilter = "all" | MemoryOrigin;

type Draft = { mode: "new" } | { mode: "edit"; id: string };

type FormInput = {
  title: string;
  category: MemoryCategory;
  content: string;
  reviewAt: string;
  expiresAt: string;
};

function MemoryForm({
  initial,
  onSave,
  onClose,
}: {
  initial: MemoryEntry | null;
  onSave: (input: FormInput) => Promise<string | null>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [category, setCategory] = useState<MemoryCategory>(
    initial?.category ?? "preferences",
  );
  const [content, setContent] = useState(initial?.content ?? "");
  const [reviewAt, setReviewAt] = useState(initial?.reviewAt ?? "");
  const [expiresAt, setExpiresAt] = useState(initial?.expiresAt ?? "");
  const [error, setError] = useState<string | null>(null);

  const sensitive = useMemo(
    () => detectSensitiveHint(`${title}\n${content}`),
    [title, content],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    const failure = await onSave({
      title,
      category,
      content,
      reviewAt,
      expiresAt,
    });

    if (failure !== null) {
      setError(failure);
    }
  }

  const inputClass =
    "mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50";

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.03] p-5"
    >
      <h3 className="text-sm font-semibold">
        {initial === null ? "Neue Erinnerung" : "Erinnerung bearbeiten"}
      </h3>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block text-xs text-slate-400 sm:col-span-2">
          Titel
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="z. B. Lieblingslernmethode"
            maxLength={120}
            required
            className={inputClass}
          />
        </label>

        <label className="block text-xs text-slate-400">
          Kategorie
          <select
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as MemoryCategory)
            }
            className={inputClass}
          >
            {MEMORY_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {MEMORY_CATEGORY_LABELS[item]}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-slate-400">
            Prüfen am (optional)
            <input
              type="date"
              value={reviewAt}
              onChange={(event) => setReviewAt(event.target.value)}
              className={inputClass}
            />
          </label>
          <label className="block text-xs text-slate-400">
            Läuft ab (optional)
            <input
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <label className="block text-xs text-slate-400 sm:col-span-2">
          Inhalt
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Was soll sich J.A.R.V.I.S. merken?"
            maxLength={2000}
            required
            rows={4}
            className={`${inputClass} resize-y`}
          />
        </label>
      </div>

      {sensitive.length > 0 && (
        <p className="mt-3 flex gap-2 rounded-xl border border-amber-300/30 bg-amber-300/5 p-3 text-xs text-amber-100">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          Enthält möglicherweise sensible Daten ({sensitive.join(", ")}).
          Speichere keine Passwörter, Ausweise oder Kontodaten als Erinnerung.
        </p>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 text-xs text-rose-300">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="submit"
          className="jarvis-press flex items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
        >
          <Check size={16} />
          Speichern
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:border-white/25 hover:text-white"
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}

export default function MemoryPage() {
  const memoryStore = useMemory();
  const entries = memoryStore.items;
  const today = useToday();
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();

    return entries
      .filter((entry) => (showArchived ? true : !entry.archived))
      .filter(
        (entry) =>
          categoryFilter === "all" || entry.category === categoryFilter,
      )
      .filter(
        (entry) => originFilter === "all" || entry.origin === originFilter,
      )
      .filter(
        (entry) =>
          query === "" ||
          entry.title.toLowerCase().includes(query) ||
          entry.content.toLowerCase().includes(query),
      )
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [entries, search, categoryFilter, originFilter, showArchived]);

  const stats = useMemo(() => {
    const active = today === null ? [] : activeMemory(entries, today);

    return {
      active: active.length,
      pinned: active.filter((entry) => entry.pinned).length,
      reviewDue:
        today === null
          ? 0
          : entries.filter(
              (entry) => !entry.archived && needsReview(entry, today),
            ).length,
    };
  }, [entries, today]);

  async function saveDraft(input: FormInput): Promise<string | null> {
    if (input.title.trim() === "" || input.content.trim() === "") {
      return "Titel und Inhalt dürfen nicht leer sein.";
    }

    if (draft === null) return "Kein Entwurf geöffnet.";

    if (draft.mode === "new") {
      const created = createMemoryEntry({
        category: input.category,
        title: input.title,
        content: input.content,
        origin: "user",
        reviewAt: input.reviewAt === "" ? undefined : input.reviewAt,
        expiresAt: input.expiresAt === "" ? undefined : input.expiresAt,
      });

      if (created === null) {
        return "Eintrag ist ungültig. Prüfe Titel, Inhalt und Daten.";
      }

      const result = await memoryStore.create(created);

      if (!result.ok) {
        return `Speichern fehlgeschlagen: ${result.error}`;
      }
    } else {
      const result = await memoryStore.update(draft.id, {
        category: input.category,
        title: input.title.trim(),
        content: input.content.trim(),
        reviewAt: input.reviewAt === "" ? undefined : input.reviewAt,
        expiresAt: input.expiresAt === "" ? undefined : input.expiresAt,
      });

      if (!result.ok) {
        return `Speichern fehlgeschlagen: ${result.error}`;
      }
    }

    setDraft(null);

    return null;
  }

  async function updateEntry(
    id: string,
    patch: { approved?: boolean; pinned?: boolean; archived?: boolean },
  ) {
    await memoryStore.update(id, patch);
  }

  async function removeEntry(id: string) {
    const result = await memoryStore.remove(id);

    if (!result.ok) return;

    setPendingDelete(null);
  }

  async function clearAll() {
    for (const entry of entries) {
      await memoryStore.remove(entry.id);
    }

    setConfirmingClear(false);
    setPendingDelete(null);
  }

  function resetFilters() {
    setSearch("");
    setCategoryFilter("all");
    setOriginFilter("all");
    setShowArchived(false);
  }

  const editing =
    draft?.mode === "edit"
      ? (entries.find((entry) => entry.id === draft.id) ?? null)
      : null;

  return (
    <main className="min-h-screen bg-[#080b12] text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col md:flex-row">
        <Sidebar />

        <section className="min-w-0 flex-1 px-5 py-7 sm:px-8 lg:px-12">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-slate-500 transition hover:text-cyan-200"
          >
            <ArrowLeft size={16} />
            Zur Übersicht
          </Link>

          <header className="mt-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-sm tracking-wide text-cyan-300">GEDÄCHTNIS</p>
              <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">
                Erinnerungen
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
                Vorlieben, Ziele und Notizen, die sich J.A.R.V.I.S. merken
                soll.{" "}
                {memoryStore.mode === "cloud"
                  ? "Einträge werden geräteübergreifend synchronisiert – nichts wird automatisch gespeichert oder geteilt."
                  : "Alles bleibt lokal – nichts wird automatisch gespeichert oder geteilt."}
              </p>
            </div>

            <button
              onClick={() => setDraft({ mode: "new" })}
              className="flex items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
            >
              <Plus size={16} />
              Neue Erinnerung
            </button>
          </header>

          <div className="mt-6 flex flex-wrap gap-2 text-xs" aria-live="polite">
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-slate-300">
              {stats.active} aktiv
            </span>
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-slate-300">
              {stats.pinned} angepinnt
            </span>
            {stats.reviewDue > 0 && (
              <span className="rounded-full border border-amber-300/30 bg-amber-300/5 px-2.5 py-1 text-amber-100">
                {stats.reviewDue} zu prüfen
              </span>
            )}
          </div>

          <div className="jarvis-enter mt-4 flex flex-wrap items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-sm sm:max-w-xs">
              <Search size={16} className="shrink-0 text-slate-500" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Suchen …"
                aria-label="Erinnerungen durchsuchen"
                className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-600"
              />
              {search !== "" && (
                <button
                  onClick={() => setSearch("")}
                  aria-label="Suche löschen"
                  className="text-slate-500 transition hover:text-white"
                >
                  <X size={15} />
                </button>
              )}
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-400">
              Kategorie
              <select
                value={categoryFilter}
                onChange={(event) =>
                  setCategoryFilter(event.target.value as CategoryFilter)
                }
                className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50"
              >
                <option value="all">Alle</option>
                {MEMORY_CATEGORIES.map((item) => (
                  <option key={item} value={item}>
                    {MEMORY_CATEGORY_LABELS[item]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-400">
              Herkunft
              <select
                value={originFilter}
                onChange={(event) =>
                  setOriginFilter(event.target.value as OriginFilter)
                }
                className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50"
              >
                <option value="all">Alle</option>
                <option value="user">Von mir</option>
                <option value="derived">Abgeleitet</option>
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
                className="h-4 w-4 accent-cyan-300"
              />
              Archivierte zeigen
            </label>
          </div>

          {draft !== null && (
            <div className="jarvis-fade mt-5">
              <MemoryForm
                key={draft.mode === "edit" ? draft.id : "new"}
                initial={draft.mode === "edit" ? editing : null}
                onSave={saveDraft}
                onClose={() => setDraft(null)}
              />
            </div>
          )}

          {memoryStore.error !== null && (
            <div
              role="alert"
              className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/25 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"
            >
              <span className="min-w-0 flex-1">
                Erinnerungen konnten nicht geladen werden: {memoryStore.error}
              </span>
              <button
                onClick={() => void memoryStore.refresh()}
                className="rounded-xl border border-rose-300/30 px-3 py-1.5 text-xs transition hover:bg-rose-400/10"
              >
                Erneut versuchen
              </button>
            </div>
          )}

          <div
            className="jarvis-enter mt-5"
            style={{ "--enter-delay": "80ms" } as React.CSSProperties}
          >
            {memoryStore.loading ? (
              <div className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-10 text-center text-sm text-slate-500">
                Erinnerungen werden geladen …
              </div>
            ) : entries.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-[#0d111b] p-10 text-center">
                <Brain size={28} className="mx-auto text-cyan-300" />
                <p className="mt-4 text-sm font-medium text-slate-200">
                  Noch keine Erinnerungen
                </p>
                <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-slate-500">
                  Lege deine erste Erinnerung an – zum Beispiel ein Ziel, eine
                  Lernvorliebe oder eine Budgetregel.
                </p>
                <button
                  onClick={() => setDraft({ mode: "new" })}
                  className="mt-4 rounded-xl bg-cyan-300 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                >
                  Erste Erinnerung anlegen
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-[#0d111b] p-10 text-center text-sm text-slate-500">
                Keine Treffer für diese Filter.
                <button
                  onClick={resetFilters}
                  className="ml-2 text-cyan-200 underline-offset-2 hover:underline"
                >
                  Filter zurücksetzen
                </button>
              </div>
            ) : (
              <ul className="space-y-3">
                {visible.map((entry) => {
                  const usage =
                    today === null ? [] : usageOf(entry, today);
                  const expired =
                    today !== null && isExpired(entry, today);
                  const reviewDue =
                    today !== null && needsReview(entry, today);

                  return (
                    <li
                      key={entry.id}
                      className={`jarvis-lift rounded-3xl border bg-[#0d111b] p-5 ${
                        entry.pinned
                          ? "border-cyan-300/25"
                          : "border-white/[0.08]"
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {entry.pinned && (
                          <Pin size={15} className="text-cyan-300" />
                        )}
                        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
                          {entry.title}
                        </h2>
                        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-slate-400">
                          {MEMORY_CATEGORY_LABELS[entry.category]}
                        </span>
                        {entry.origin === "user" ? (
                          <span className="rounded-full border border-cyan-300/30 bg-cyan-300/5 px-2 py-0.5 text-[11px] text-cyan-200">
                            Von dir
                          </span>
                        ) : (
                          <span className="rounded-full border border-amber-300/30 bg-amber-300/5 px-2 py-0.5 text-[11px] text-amber-100">
                            Abgeleitet
                            {entry.approved ? "" : " · wartet"}
                          </span>
                        )}
                        {expired && (
                          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-slate-500">
                            Abgelaufen
                          </span>
                        )}
                        {!expired && reviewDue && (
                          <span className="rounded-full border border-amber-300/30 bg-amber-300/5 px-2 py-0.5 text-[11px] text-amber-100">
                            Prüfung fällig
                          </span>
                        )}
                        {entry.archived && (
                          <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-slate-500">
                            Archiviert
                          </span>
                        )}
                      </div>

                      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-300">
                        {entry.content}
                      </p>

                      {entry.evidence !== undefined && (
                        <p className="mt-2 flex gap-2 text-xs leading-5 text-slate-500">
                          <Info size={14} className="mt-0.5 shrink-0" />
                          Begründung: {entry.evidence}
                        </p>
                      )}

                      <p className="mt-3 text-xs text-slate-500">
                        Erstellt {formatStamp(entry.createdAt)} · Aktualisiert{" "}
                        {formatStamp(entry.updatedAt)}
                        {usage.length > 0
                          ? ` · Verwendet in: ${usage.join(", ")}`
                          : ""}
                      </p>

                      {entry.origin === "derived" && !entry.approved && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            onClick={() =>
                              updateEntry(entry.id, { approved: true })
                            }
                            className="flex items-center gap-1.5 rounded-xl bg-cyan-300 px-3 py-1.5 text-xs font-medium text-slate-950 transition hover:bg-cyan-200"
                          >
                            <Check size={14} />
                            Freigeben
                          </button>
                          <span className="self-center text-xs text-slate-500">
                            Erst nach deiner Freigabe wird dieser Eintrag
                            verwendet.
                          </span>
                        </div>
                      )}

                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          onClick={() =>
                            updateEntry(entry.id, { pinned: !entry.pinned })
                          }
                          aria-pressed={entry.pinned}
                          className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/25 hover:text-white"
                        >
                          {entry.pinned ? (
                            <PinOff size={14} />
                          ) : (
                            <Pin size={14} />
                          )}
                          {entry.pinned ? "Lösen" : "Anpinnen"}
                        </button>
                        <button
                          onClick={() =>
                            setDraft({ mode: "edit", id: entry.id })
                          }
                          className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/25 hover:text-white"
                        >
                          <Pencil size={14} />
                          Bearbeiten
                        </button>
                        <button
                          onClick={() =>
                            updateEntry(entry.id, {
                              archived: !entry.archived,
                            })
                          }
                          className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/25 hover:text-white"
                        >
                          {entry.archived ? (
                            <ArchiveRestore size={14} />
                          ) : (
                            <Archive size={14} />
                          )}
                          {entry.archived ? "Wiederherstellen" : "Archivieren"}
                        </button>
                        {pendingDelete !== entry.id && (
                          <button
                            onClick={() => setPendingDelete(entry.id)}
                            className="flex items-center gap-1.5 rounded-xl border border-rose-400/30 px-3 py-1.5 text-xs text-rose-200 transition hover:bg-rose-400/10"
                          >
                            <Trash2 size={14} />
                            Löschen
                          </button>
                        )}
                      </div>

                      {pendingDelete === entry.id && (
                        <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/5 p-3">
                          <p className="text-xs text-rose-100">
                            „{entry.title}“ wirklich löschen? Das kann nicht
                            rückgängig gemacht werden.
                          </p>
                          <div className="mt-2 flex gap-2">
                            <button
                              onClick={() => setPendingDelete(null)}
                              className="rounded-xl border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/25 hover:text-white"
                            >
                              Abbrechen
                            </button>
                            <button
                              onClick={() => removeEntry(entry.id)}
                              className="rounded-xl bg-rose-300 px-3 py-1.5 text-xs font-medium text-slate-950 transition hover:bg-rose-200"
                            >
                              Löschen
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {entries.length > 0 && (
            <div className="mt-6 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5">
              {!confirmingClear ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs text-slate-500">
                    Alle {entries.length} Erinnerungen unwiderruflich entfernen?
                  </p>
                  <button
                    onClick={() => setConfirmingClear(true)}
                    className="rounded-xl border border-rose-400/30 px-3 py-1.5 text-xs text-rose-200 transition hover:bg-rose-400/10"
                  >
                    Alle löschen …
                  </button>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-rose-100">
                    Wirklich alle {entries.length} Erinnerungen löschen? Auch
                    angepinnte und archivierte Einträge werden entfernt. Andere
                    Module (Aufgaben, Kalender, Finanzen …) bleiben erhalten.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => setConfirmingClear(false)}
                      className="rounded-xl border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/25 hover:text-white"
                    >
                      Abbrechen
                    </button>
                    <button
                      onClick={() => void clearAll()}
                      className="rounded-xl bg-rose-300 px-3 py-1.5 text-xs font-medium text-slate-950 transition hover:bg-rose-200"
                    >
                      Alle {entries.length} löschen
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <footer className="py-8 text-center text-xs text-slate-600">
            J.A.R.V.I.S. · Gedächtnis ·{" "}
            {memoryStore.mode === "cloud"
              ? "Cloud-Synchronisierung"
              : "Lokale Speicherung"}
          </footer>
        </section>
      </div>
    </main>
  );
}
