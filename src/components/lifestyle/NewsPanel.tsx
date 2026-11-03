"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Newspaper, RotateCw } from "lucide-react";
import {
  NEWS_INTERESTS_KEY,
  filterNewsByInterests,
  isNewsItem,
  type NewsItem,
} from "@/src/lib/lifestyle/news";

type FeedState = { id: string; label: string; count: number; error: string | null };

const DATE_FORMAT = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatStamp(iso: string): string {
  if (iso === "") return "Datum unbekannt";

  const date = new Date(iso);

  return Number.isNaN(date.getTime()) ? "Datum unbekannt" : DATE_FORMAT.format(date);
}

function isFeedState(value: unknown): value is FeedState {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.id === "string" &&
    typeof item.label === "string" &&
    typeof item.count === "number" &&
    (item.error === null || typeof item.error === "string")
  );
}

/**
 * News from free RSS feeds (server route /api/lifestyle/news). Interests
 * are comma-separated keywords stored locally; empty interests show all
 * items. Every state is honest: loading, per-feed errors, empty.
 */
export function NewsPanel() {
  const [items, setItems] = useState<NewsItem[]>([]);
  const [feeds, setFeeds] = useState<FeedState[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [interests, setInterests] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInterests(window.localStorage.getItem(NEWS_INTERESTS_KEY) ?? "");
    } catch {
      // Private mode: interests simply don't persist.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setFailed(false);

      try {
        const res = await fetch("/api/lifestyle/news", { cache: "no-store" });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const body = (await res.json()) as {
          ok?: boolean;
          data?: { items?: unknown; feeds?: unknown };
        };
        const rawItems = Array.isArray(body.data?.items) ? body.data.items : [];
        const rawFeeds = Array.isArray(body.data?.feeds) ? body.data.feeds : [];

        if (!cancelled) {
          setItems(rawItems.filter(isNewsItem));
          setFeeds(rawFeeds.filter(isFeedState));
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  function saveInterests(next: string) {
    setInterests(next);

    try {
      window.localStorage.setItem(NEWS_INTERESTS_KEY, next);
    } catch {
      // Private mode: keep the filter for this session only.
    }
  }

  const visible = useMemo(
    () => filterNewsByInterests(items, interests),
    [items, interests],
  );
  const feedErrors = feeds.filter((feed) => feed.error !== null);

  return (
    <section
      aria-label="Nachrichten"
      className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
          <Newspaper size={21} />
        </div>

        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Nachrichten</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Kostenlose RSS-Feeds (Tagesschau, heise, Deutschlandfunk) — ohne
            Anmeldung, ohne Kosten. Filtere mit deinen Interessen.
          </p>
        </div>

        <button
          onClick={() => setReloadToken((token) => token + 1)}
          disabled={loading}
          aria-label="Nachrichten aktualisieren"
          title="Aktualisieren"
          className="shrink-0 rounded-xl border border-white/10 p-2.5 text-slate-300 transition hover:border-cyan-300/30 hover:text-white disabled:opacity-40"
        >
          <RotateCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <label className="mt-4 block text-xs text-slate-400">
        Interessen (kommagetrennt, z. B. „Klima, Kino, Leipzig“)
        <input
          value={interests}
          onChange={(event) => saveInterests(event.target.value)}
          placeholder="Alle Nachrichten anzeigen"
          maxLength={200}
          className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
        />
      </label>

      <div className="mt-4">
        {loading ? (
          <p aria-live="polite" className="text-sm text-slate-500">
            Nachrichten werden geladen …
          </p>
        ) : failed ? (
          <div role="alert" className="rounded-2xl border border-rose-400/25 bg-rose-400/5 p-4 text-sm text-rose-200">
            Nachrichten konnten nicht geladen werden. Prüfe deine
            Verbindung und versuche es erneut.
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
            {items.length === 0
              ? "Aktuell keine Nachrichten verfügbar — die Feeds antworten nicht oder sind leer."
              : "Keine Nachrichten zu deinen Interessen. Passe die Stichwörter an oder leere das Feld."}
          </div>
        ) : (
          <ul className="space-y-2">
            {visible.slice(0, 20).map((item) => (
              <li
                key={item.id}
                className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4 transition hover:bg-white/[0.04]"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] uppercase tracking-wider text-cyan-300">
                      {item.feedLabel} · {formatStamp(item.publishedAt)}
                    </p>
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 block text-sm font-medium leading-6 text-slate-100 transition hover:text-cyan-200"
                    >
                      {item.title}
                    </a>
                    {item.excerpt !== "" && (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                        {item.excerpt}
                      </p>
                    )}
                  </div>
                  <ExternalLink size={15} className="mt-1 shrink-0 text-slate-600" />
                </div>
              </li>
            ))}
          </ul>
        )}

        {feedErrors.length > 0 && !loading && !failed && (
          <div className="mt-3 space-y-1.5">
            {feedErrors.map((feed) => (
              <p
                key={feed.id}
                role="status"
                className="rounded-xl border border-amber-300/20 bg-amber-300/5 px-3 py-2 text-xs text-amber-200"
              >
                {feed.error}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
