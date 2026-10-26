"use client";

import { useMemo, useState } from "react";
import {
  ExternalLink,
  Pencil,
  Plus,
  Search,
  Ticket,
  Trash2,
} from "lucide-react";
import { useToday } from "@/src/hooks/useToday";
import { createId } from "@/src/lib/ids";
import { formatUploadDate } from "@/src/lib/documents";
import { usePlaceEvents } from "@/src/lib/db/useModules";
import {
  parseISODateLocal,
  timeToMinutes,
} from "@/src/lib/calendar";
import {
  centsToEuroInput,
  formatCents,
  parseEuroToCentsAllowingZero,
} from "@/src/lib/finance";
import {
  CATEGORY_LABELS,
  PLACE_CATEGORIES,
  type EventCategory,
  type PlaceEvent,
} from "@/src/lib/lifestyle/types";
import {
  MANUAL_SOURCE,
  filterEvents,
  type EventSearch,
} from "@/src/lib/lifestyle/providers";

const EVENT_DAY_FORMAT = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeZone: "UTC",
});

function formatEventDay(dateISO: string): string {
  return EVENT_DAY_FORMAT.format(new Date(`${dateISO}T12:00:00Z`));
}

const CATEGORY_OPTIONS: { key: "all" | EventCategory; label: string }[] = [
  { key: "all", label: "Alle Kategorien" },
  ...PLACE_CATEGORIES.map((category) => ({
    key: category as EventCategory,
    label: CATEGORY_LABELS[category],
  })),
  { key: "events", label: CATEGORY_LABELS.events },
];

export function EventsPanel() {
  const eventsStore = usePlaceEvents();
  const events = eventsStore.items;
  const today = useToday();
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | EventCategory>(
    "all",
  );
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [maxPrice, setMaxPrice] = useState("");
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<EventCategory>("events");
  const [venue, setVenue] = useState("");
  const [address, setAddress] = useState("");
  const [date, setDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [time, setTime] = useState("");
  const [price, setPrice] = useState("");
  const [freeEntry, setFreeEntry] = useState(false);
  const [bookingUrl, setBookingUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);

  // Standardmäßig nur anstehende Events; vergangene auf Wunsch einblenden.
  const effectiveFrom =
    !showPast && today !== null ? today : from === "" ? null : from;

  const visible = useMemo(() => {
    const search: EventSearch = {
      query,
      categories: categoryFilter === "all" ? [] : [categoryFilter],
      fromISO: effectiveFrom,
      toISO: to === "" ? null : to,
      maxPriceCents:
        maxPrice.trim() === ""
          ? null
          : parseEuroToCentsAllowingZero(maxPrice),
      freeOnly,
    };

    return filterEvents(events, search);
  }, [events, query, categoryFilter, effectiveFrom, to, maxPrice, freeOnly]);

  function openNew() {
    setEditing("new");
    setTitle("");
    setCategory("events");
    setVenue("");
    setAddress("");
    setDate(today ?? "");
    setEndDate("");
    setTime("");
    setPrice("");
    setFreeEntry(false);
    setBookingUrl("");
    setNotes("");
    setFormError(null);
    setConfirmDeleteId(null);
  }

  function openEdit(event: PlaceEvent) {
    setEditing(event.id);
    setTitle(event.title);
    setCategory(event.category);
    setVenue(event.venue);
    setAddress(event.address);
    setDate(event.date);
    setEndDate(event.endDate ?? "");
    setTime(event.time);
    setPrice(
      event.priceCents === null || event.priceCents === 0
        ? ""
        : centsToEuroInput(event.priceCents),
    );
    setFreeEntry(event.priceCents === 0);
    setBookingUrl(event.bookingUrl);
    setNotes(event.notes);
    setFormError(null);
    setConfirmDeleteId(null);
  }

  async function saveEvent(form: React.FormEvent<HTMLFormElement>) {
    form.preventDefault();
    if (editing === null) return;

    if (title.trim() === "") {
      setFormError("Bitte gib einen Titel ein.");
      return;
    }

    if (parseISODateLocal(date) === null) {
      setFormError("Bitte wähle ein gültiges Datum.");
      return;
    }

    if (
      endDate !== "" &&
      (parseISODateLocal(endDate) === null || endDate < date)
    ) {
      setFormError("Das Enddatum muss am oder nach dem Startdatum liegen.");
      return;
    }

    if (time !== "" && timeToMinutes(time) === null) {
      setFormError("Die Uhrzeit ist ungültig.");
      return;
    }

    const priceCents = freeEntry
      ? 0
      : price.trim() === ""
        ? null
        : parseEuroToCentsAllowingZero(price);

    if (!freeEntry && price.trim() !== "" && priceCents === null) {
      setFormError("Der Preis ist ungültig (z. B. 15,00).");
      return;
    }

    if (
      bookingUrl.trim() !== "" &&
      !/^https?:\/\/.+/i.test(bookingUrl.trim())
    ) {
      setFormError("Der Buchungslink muss mit http(s):// beginnen.");
      return;
    }

    const now = new Date().toISOString();

    if (editing === "new") {
      const entry: PlaceEvent = {
        id: createId(),
        title: title.trim(),
        category,
        venue: venue.trim(),
        address: address.trim(),
        date,
        endDate: endDate === "" ? null : endDate,
        time,
        priceCents,
        bookingUrl: bookingUrl.trim(),
        notes: notes.trim(),
        source: MANUAL_SOURCE,
        createdAt: now,
        updatedAt: now,
      };
      const result = await eventsStore.create(entry);

      if (!result.ok) {
        setFormError(`Speichern fehlgeschlagen: ${result.error}`);
        return;
      }
    } else {
      const result = await eventsStore.update(editing, {
        title: title.trim(),
        category,
        venue: venue.trim(),
        address: address.trim(),
        date,
        endDate: endDate === "" ? null : endDate,
        time,
        priceCents,
        bookingUrl: bookingUrl.trim(),
        notes: notes.trim(),
        updatedAt: now,
      });

      if (!result.ok) {
        setFormError(`Speichern fehlgeschlagen: ${result.error}`);
        return;
      }
    }

    setEditing(null);
    setFormError(null);
  }

  async function deleteEvent(id: string) {
    await eventsStore.remove(id);
    setConfirmDeleteId(null);
  }

  return (
    <section
      id="veranstaltungen"
      aria-label="Veranstaltungen"
      className="scroll-mt-4 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
            <Ticket size={21} />
          </div>

          <div>
            <h2 className="font-semibold">Veranstaltungen</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              Deine Termine und Events – Termine stammen aus deinen
              Einträgen, kein Anbieter bestätigt ihre Aktualität.
            </p>
            <p className="mt-2 text-xs text-cyan-300">
              {events.length}{" "}
              {events.length === 1 ? "Eintrag" : "Einträge"}
            </p>
          </div>
        </div>

        <button
          onClick={openNew}
          className="flex shrink-0 items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
        >
          <Plus size={16} />
          Event anlegen
        </button>
      </div>

      {eventsStore.loading ? (
        <p className="mt-5 text-sm text-slate-500">
          Veranstaltungen werden geladen …
        </p>
      ) : eventsStore.error !== null ? (
        <div
          role="alert"
          className="mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/25 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"
        >
          <span className="min-w-0 flex-1">
            Veranstaltungen konnten nicht geladen werden: {eventsStore.error}
          </span>
          <button
            onClick={() => void eventsStore.refresh()}
            className="rounded-xl border border-rose-300/30 px-3 py-1.5 text-xs transition hover:bg-rose-400/10"
          >
            Erneut versuchen
          </button>
        </div>
      ) : (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1">
              <Search
                size={15}
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <input
                value={query}
                onChange={(change) => setQuery(change.target.value)}
                placeholder="Events suchen …"
                aria-label="Veranstaltungen suchen"
                className="w-full rounded-xl border border-white/10 bg-black/20 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
              />
            </div>

            <select
              value={categoryFilter}
              onChange={(change) =>
                setCategoryFilter(
                  change.target.value as "all" | EventCategory,
                )
              }
              aria-label="Nach Kategorie filtern"
              className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-xs text-white outline-none focus:border-cyan-300/50"
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>

            <label className="flex items-center gap-2 text-xs text-slate-400">
              Von
              <input
                type="date"
                value={from}
                onChange={(change) => setFrom(change.target.value)}
                aria-label="Frühestes Datum"
                className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50"
              />
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-400">
              Bis
              <input
                type="date"
                value={to}
                onChange={(change) => setTo(change.target.value)}
                aria-label="Spätestes Datum"
                className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50"
              />
            </label>

            <input
              value={maxPrice}
              onChange={(change) => setMaxPrice(change.target.value)}
              placeholder="Max. €"
              aria-label="Maximaler Preis in Euro"
              inputMode="decimal"
              className="w-24 rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-xs tabular-nums text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
            />

            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-xs text-slate-400 transition hover:text-slate-200">
              <input
                type="checkbox"
                checked={freeOnly}
                onChange={(change) => setFreeOnly(change.target.checked)}
                className="h-4 w-4 accent-cyan-300"
              />
              Nur kostenlos
            </label>

            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/10 px-3 py-2.5 text-xs text-slate-400 transition hover:text-slate-200">
              <input
                type="checkbox"
                checked={showPast}
                onChange={(change) => setShowPast(change.target.checked)}
                className="h-4 w-4 accent-cyan-300"
              />
              Vergangene anzeigen
            </label>
          </div>

          {editing !== null && (
            <form
              onSubmit={saveEvent}
              noValidate
              className="mt-4 space-y-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-slate-400">
                  Titel
                  <input
                    autoFocus
                    value={title}
                    onChange={(change) => {
                      setTitle(change.target.value);
                      setFormError(null);
                    }}
                    placeholder="z. B. Open-Air-Kino"
                    maxLength={120}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Kategorie
                  <select
                    value={category}
                    onChange={(change) =>
                      setCategory(change.target.value as EventCategory)
                    }
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  >
                    {CATEGORY_OPTIONS.filter(
                      (option) => option.key !== "all",
                    ).map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block text-xs text-slate-400">
                  Datum
                  <input
                    type="date"
                    value={date}
                    onChange={(change) => {
                      setDate(change.target.value);
                      setFormError(null);
                    }}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Enddatum (optional)
                  <input
                    type="date"
                    value={endDate}
                    onChange={(change) => {
                      setEndDate(change.target.value);
                      setFormError(null);
                    }}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Uhrzeit (optional)
                  <input
                    type="time"
                    value={time}
                    onChange={(change) => {
                      setTime(change.target.value);
                      setFormError(null);
                    }}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-xs text-slate-400">
                  Ort / Venue
                  <input
                    value={venue}
                    onChange={(change) => setVenue(change.target.value)}
                    placeholder="z. B. Stadtpark"
                    maxLength={120}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                </label>

                <label className="block text-xs text-slate-400">
                  Adresse (optional)
                  <input
                    value={address}
                    onChange={(change) => setAddress(change.target.value)}
                    placeholder="z. B. Parkallee 5"
                    maxLength={200}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs text-slate-400">
                    Preis (€, leer = unbekannt)
                    <input
                      value={price}
                      onChange={(change) => {
                        setPrice(change.target.value);
                        setFormError(null);
                      }}
                      disabled={freeEntry}
                      placeholder="z. B. 15,00"
                      inputMode="decimal"
                      className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:border-cyan-300/50 disabled:opacity-50"
                    />
                  </label>
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-slate-400">
                    <input
                      type="checkbox"
                      checked={freeEntry}
                      onChange={(change) => {
                        setFreeEntry(change.target.checked);
                        setFormError(null);
                      }}
                      className="h-4 w-4 accent-cyan-300"
                    />
                    Kostenloser Eintritt
                  </label>
                </div>

                <label className="block text-xs text-slate-400">
                  Buchungslink (optional)
                  <input
                    value={bookingUrl}
                    onChange={(change) => {
                      setBookingUrl(change.target.value);
                      setFormError(null);
                    }}
                    placeholder="https://…"
                    inputMode="url"
                    maxLength={300}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                  />
                </label>
              </div>

              <label className="block text-xs text-slate-400">
                Notizen (optional)
                <textarea
                  value={notes}
                  onChange={(change) => setNotes(change.target.value)}
                  placeholder="z. B. Tickets vorher sichern"
                  maxLength={500}
                  rows={2}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                />
              </label>

              {formError !== null && (
                <p role="alert" className="text-xs text-rose-300">
                  {formError}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  type="submit"
                  className="flex-1 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                >
                  {editing === "new" ? "Event speichern" : "Speichern"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setFormError(null);
                  }}
                  className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                >
                  Abbrechen
                </button>
              </div>
            </form>
          )}

          <div className="mt-4">
            {events.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                Noch keine Veranstaltungen eingetragen.
              </div>
            ) : visible.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-5 text-center text-sm text-slate-500">
                Keine Veranstaltungen für diese Filter gefunden.
              </div>
            ) : (
              <ul className="space-y-2">
                {visible.map((event) => (
                  <li
                    key={event.id}
                    className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
                  >
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-200">
                          {event.title}
                        </p>
                        <p className="mt-1 text-xs tabular-nums text-slate-400">
                          {formatEventDay(event.date)}
                          {event.endDate !== null &&
                            event.endDate !== event.date &&
                            ` – ${formatEventDay(event.endDate)}`}
                          {event.time !== "" && ` · ${event.time} Uhr`}
                        </p>
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          <span className="rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[10px] text-cyan-200">
                            {CATEGORY_LABELS[event.category]}
                          </span>
                          <span className="rounded-full bg-white/[0.05] px-2 py-1 text-[10px] tabular-nums text-slate-400">
                            {event.priceCents === null
                              ? "Preis unbekannt"
                              : event.priceCents === 0
                                ? "Kostenlos"
                                : formatCents(event.priceCents)}
                          </span>
                        </div>

                        {(event.venue !== "" || event.address !== "") && (
                          <p className="mt-2 truncate text-xs text-slate-500">
                            {event.venue}
                            {event.venue !== "" && event.address !== ""
                              ? " · "
                              : ""}
                            {event.address}
                          </p>
                        )}
                        {event.notes !== "" && (
                          <p className="mt-1 break-words text-xs leading-5 text-slate-500">
                            {event.notes}
                          </p>
                        )}
                        <p className="mt-2 text-[10px] text-slate-600">
                          {event.source.label} · Stand{" "}
                          {formatUploadDate(event.updatedAt)}
                        </p>
                      </div>

                      <div className="flex shrink-0 gap-1">
                        {event.bookingUrl !== "" && (
                          <a
                            href={event.bookingUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Tickets: ${event.title}`}
                            title="Buchungsseite öffnen"
                            className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                          >
                            <ExternalLink size={15} />
                          </a>
                        )}
                        <button
                          onClick={() => openEdit(event)}
                          aria-label={`Bearbeiten: ${event.title}`}
                          title="Bearbeiten"
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(event.id)}
                          aria-label={`Löschen: ${event.title}`}
                          title="Löschen"
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>

                    {confirmDeleteId === event.id && (
                      <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/5 p-4">
                        <p className="text-sm text-rose-200">
                          „{event.title}“ wirklich löschen?
                        </p>
                        <div className="mt-3 flex gap-2">
                          <button
                            onClick={() => deleteEvent(event.id)}
                            className="flex-1 rounded-xl bg-rose-400 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-rose-300"
                          >
                            Endgültig löschen
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                          >
                            Abbrechen
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
