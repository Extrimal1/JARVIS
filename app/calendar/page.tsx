"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import Sidebar from "@/src/components/Sidebar";
import { useLocalStorage } from "@/src/hooks/useLocalStorage";
import { useLockBodyScroll } from "@/src/hooks/useLockBodyScroll";
import {
  CALENDAR_STORAGE_KEY,
  EVENT_TYPE_STYLES,
  NO_EVENTS,
  addDays,
  findConflicts,
  isCalendarEventList,
  layoutDayEvents,
  minutesToTime,
  parseISODateLocal,
  startOfWeekMonday,
  timeToMinutes,
  toISODateLocal,
  weekDays,
  weekLabel,
  type CalendarEvent,
  type CalendarEventType,
} from "@/src/lib/calendar";

const HOUR_PX = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("de-DE", { weekday: "short" });

type FilterKey = "all" | CalendarEventType;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "lecture", label: "Vorlesungen" },
  { key: "exam", label: "Prüfungen" },
  { key: "personal", label: "Persönlich" },
];

type Draft = { mode: "new" | "edit"; event: CalendarEvent };

type ClockSnapshot = {
  weekStart: Date;
  todayISO: string;
  nowMinutes: number;
};

export default function CalendarPage() {
  const [events, setEvents] = useLocalStorage(
    CALENDAR_STORAGE_KEY,
    NO_EVENTS,
    isCalendarEventList,
  );
  const [snapshot, setSnapshot] = useState<ClockSnapshot | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    const current = new Date();
    // Mount-gated: prerendered HTML must not depend on the current date.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnapshot({
      weekStart: startOfWeekMonday(current),
      todayISO: toISODateLocal(current),
      nowMinutes: current.getHours() * 60 + current.getMinutes(),
    });
  }, []);

  const weekStart = useMemo(
    () =>
      snapshot === null
        ? null
        : addDays(snapshot.weekStart, weekOffset * 7),
    [snapshot, weekOffset],
  );
  const todayISO = snapshot?.todayISO ?? null;
  const nowMinutes = snapshot?.nowMinutes ?? 0;

  const days = useMemo(
    () => (weekStart === null ? [] : weekDays(weekStart)),
    [weekStart],
  );

  const visibleEvents = useMemo(
    () =>
      filter === "all"
        ? events
        : events.filter((event) => event.type === filter),
    [events, filter],
  );

  const weekCounts = useMemo(() => {
    const inWeek = new Set(days.map((day) => toISODateLocal(day)));
    const scoped = events.filter((event) => inWeek.has(event.date));

    return {
      all: scoped.length,
      lecture: scoped.filter((event) => event.type === "lecture").length,
      exam: scoped.filter((event) => event.type === "exam").length,
      personal: scoped.filter((event) => event.type === "personal").length,
    };
  }, [days, events]);

  function goToToday() {
    setWeekOffset(0);
  }

  function shiftWeek(deltaWeeks: number) {
    setWeekOffset((current) => current + deltaWeeks);
  }

  function openNew(date: string, start: string, end: string, id: number) {
    setDraft({
      mode: "new",
      event: {
        id,
        title: "",
        date,
        start,
        end,
        type: "lecture",
        description: "",
        location: "",
      },
    });
  }

  function openNewDefault() {
    if (weekStart === null || todayISO === null) return;

    const showsToday = days.some((day) => toISODateLocal(day) === todayISO);
    openNew(
      showsToday ? todayISO : toISODateLocal(weekStart),
      "09:00",
      "10:00",
      Date.now(),
    );
  }

  function openEdit(event: CalendarEvent) {
    setDraft({ mode: "edit", event: { ...event } });
  }

  function saveDraft(event: CalendarEvent) {
    if (draft?.mode === "new") {
      setEvents((current) => [...current, event]);
    } else {
      setEvents((current) =>
        current.map((item) => (item.id === event.id ? event : item)),
      );
    }

    setDraft(null);
  }

  function deleteDraft(id: number) {
    setEvents((current) => current.filter((item) => item.id !== id));
    setDraft(null);
  }

  function handleColumnClick(
    dayISO: string,
    clientY: number,
    rectTop: number,
    rectHeight: number,
    id: number,
  ) {
    const minutes = ((clientY - rectTop) / rectHeight) * 24 * 60;
    const snapped = Math.max(
      0,
      Math.min(1410, Math.floor(minutes / 30) * 30),
    );
    const start = minutesToTime(snapped);
    const end = snapped + 60 > 1439 ? "23:59" : minutesToTime(snapped + 60);
    openNew(dayISO, start, end, id);
  }

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

          <header className="mt-7">
            <p className="text-sm tracking-wide text-cyan-300">TERMINPLANER</p>

            <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">Kalender</h1>

            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
              Plane Vorlesungen, Prüfungen und persönliche Termine in einer
              Wochenübersicht.
            </p>
          </header>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-2xl border border-white/[0.08] bg-[#0d111b] p-1">
              <button
                onClick={() => shiftWeek(-1)}
                aria-label="Vorherige Woche"
                className="rounded-xl p-2.5 text-slate-300 transition hover:bg-white/5 hover:text-white"
              >
                <ChevronLeft size={18} />
              </button>

              <button
                onClick={goToToday}
                className="rounded-xl px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white"
              >
                Heute
              </button>

              <button
                onClick={() => shiftWeek(1)}
                aria-label="Nächste Woche"
                className="rounded-xl p-2.5 text-slate-300 transition hover:bg-white/5 hover:text-white"
              >
                <ChevronRight size={18} />
              </button>
            </div>

            <p aria-live="polite" className="text-sm font-medium text-slate-200">
              {weekStart === null
                ? "Kalender wird geladen …"
                : weekLabel(weekStart)}
            </p>

            <div
              role="group"
              aria-label="Termine filtern"
              className="flex flex-wrap items-center gap-2"
            >
              {FILTERS.map(({ key, label }) => {
                const active = filter === key;
                const activeChip =
                  key === "all"
                    ? "border-white/25 bg-white/10 text-white"
                    : EVENT_TYPE_STYLES[key].chip;

                return (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    aria-pressed={active}
                    className={`rounded-full border px-3 py-1.5 text-xs transition ${
                      active
                        ? activeChip
                        : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200"
                    }`}
                  >
                    {label} · {weekCounts[key]}
                  </button>
                );
              })}
            </div>

            <button
              onClick={openNewDefault}
              disabled={weekStart === null}
              className="ml-auto flex items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={16} />
              Neuer Termin
            </button>
          </div>

          {weekStart === null || days.length === 0 ? (
            <div className="mt-6 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-10 text-center text-sm text-slate-500">
              Kalender wird geladen …
            </div>
          ) : (
            <div className="mt-6 max-h-[75vh] overflow-auto rounded-3xl border border-white/[0.08] bg-[#0d111b]">
              <div className="min-w-[900px]">
                <div className="sticky top-0 z-10 grid grid-cols-[52px_repeat(7,minmax(0,1fr))] border-b border-white/[0.08] bg-[#0d111b]">
                  <div aria-hidden="true" />

                  {days.map((day) => {
                    const iso = toISODateLocal(day);
                    const isToday = iso === todayISO;

                    return (
                      <div key={iso} className="px-2 py-3 text-center">
                        <p
                          className={`text-[11px] uppercase tracking-wider ${
                            isToday ? "text-cyan-300" : "text-slate-500"
                          }`}
                        >
                          {WEEKDAY_FORMAT.format(day)}
                        </p>

                        <p
                          className={`mx-auto mt-1 flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold ${
                            isToday
                              ? "bg-cyan-300 text-slate-950"
                              : "text-slate-200"
                          }`}
                        >
                          {day.getDate()}
                        </p>
                      </div>
                    );
                  })}
                </div>

                <div className="grid grid-cols-[52px_repeat(7,minmax(0,1fr))]">
                  <div aria-hidden="true">
                    {HOURS.map((hour) => (
                      <div key={hour} className="h-12 pr-2 text-right">
                        <span
                          className={`block text-[11px] tabular-nums text-slate-500 ${
                            hour === 0 ? "" : "-translate-y-1/2"
                          }`}
                        >
                          {String(hour).padStart(2, "0")}:00
                        </span>
                      </div>
                    ))}
                  </div>

                  {days.map((day) => {
                    const iso = toISODateLocal(day);
                    const isToday = iso === todayISO;
                    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
                    const positioned = layoutDayEvents(
                      visibleEvents.filter((event) => event.date === iso),
                    );

                    return (
                      <div
                        key={iso}
                        onClick={(click) => {
                          const rect =
                            click.currentTarget.getBoundingClientRect();
                          handleColumnClick(
                            iso,
                            click.clientY,
                            rect.top,
                            rect.height,
                            Date.now(),
                          );
                        }}
                        className={`relative cursor-pointer border-l border-white/[0.06] ${
                          isToday
                            ? "bg-cyan-300/[0.04]"
                            : isWeekend
                              ? "bg-white/[0.015]"
                              : ""
                        }`}
                      >
                        {HOURS.map((hour) => (
                          <div
                            key={hour}
                            className="h-12 border-t border-white/[0.06]"
                          />
                        ))}

                        {isToday && (
                          <div
                            aria-hidden="true"
                            style={{ top: `${(nowMinutes / 60) * HOUR_PX}px` }}
                            className="pointer-events-none absolute left-0 right-0 z-[5] border-t-2 border-rose-400"
                          >
                            <span className="absolute -top-[5px] left-0 h-2 w-2 rounded-full bg-rose-400" />
                          </div>
                        )}

                        {positioned.map(({ event, column, columns }) => {
                          const startMin = timeToMinutes(event.start) ?? 0;
                          const endMin = timeToMinutes(event.end) ?? startMin;
                          const top = (startMin / 60) * HOUR_PX;
                          const height = Math.max(
                            ((endMin - startMin) / 60) * HOUR_PX,
                            24,
                          );
                          const tall = endMin - startMin >= 45;
                          const style = EVENT_TYPE_STYLES[event.type];

                          return (
                            <button
                              key={event.id}
                              onClick={(click) => {
                                click.stopPropagation();
                                openEdit(event);
                              }}
                              title={`${event.title}\n${event.start}–${event.end}${
                                event.location
                                  ? ` · ${event.location}`
                                  : ""
                              }`}
                              style={{
                                top: `${top}px`,
                                height: `${height}px`,
                                left: `calc(${(column * 100) / columns}% + 2px)`,
                                width: `calc(${100 / columns}% - 4px)`,
                              }}
                              className={`absolute z-[6] overflow-hidden rounded-lg border-l-2 p-1.5 text-left transition ${style.block}`}
                            >
                              <span className="block truncate text-[11px] font-medium leading-tight">
                                {event.title}
                              </span>

                              {tall && (
                                <span className="mt-0.5 block text-[10px] leading-tight tabular-nums opacity-80">
                                  {event.start}–{event.end}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          <p className="mt-4 text-xs leading-5 text-slate-500">
            Tipp: Klicke auf eine freie Fläche im Kalender, um einen Termin zu
            erstellen. Überschneidungen werden beim Bearbeiten als Hinweis
            angezeigt.
          </p>

          <footer className="py-8 text-center text-xs text-slate-600">
            J.A.R.V.I.S. · Terminplaner · Lokale Speicherung
          </footer>
        </section>
      </div>

      {draft !== null && (
        <EventForm
          key={draft.event.id}
          mode={draft.mode}
          initial={draft.event}
          allEvents={events}
          onSave={saveDraft}
          onDelete={deleteDraft}
          onClose={() => setDraft(null)}
        />
      )}
    </main>
  );
}

type FormErrors = Partial<Record<"title" | "date" | "time", string>>;

function EventForm({
  mode,
  initial,
  allEvents,
  onSave,
  onDelete,
  onClose,
}: {
  mode: "new" | "edit";
  initial: CalendarEvent;
  allEvents: CalendarEvent[];
  onSave: (event: CalendarEvent) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
}) {
  const [fields, setFields] = useState<CalendarEvent>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  useLockBodyScroll(true);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  function setField<Key extends keyof CalendarEvent>(
    key: Key,
    value: CalendarEvent[Key],
  ) {
    setFields((current) => ({ ...current, [key]: value }) as CalendarEvent);
    setErrors({});
  }

  const conflicts = useMemo(
    () => findConflicts(allEvents, fields),
    [allEvents, fields],
  );

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextErrors: FormErrors = {};

    if (fields.title.trim() === "") {
      nextErrors.title = "Bitte gib einen Titel ein.";
    }

    if (parseISODateLocal(fields.date) === null) {
      nextErrors.date = "Bitte wähle ein gültiges Datum.";
    }

    const startMin = timeToMinutes(fields.start);
    const endMin = timeToMinutes(fields.end);

    if (startMin === null || endMin === null) {
      nextErrors.time = "Bitte gib gültige Uhrzeiten ein.";
    } else if (endMin <= startMin) {
      nextErrors.time = "Das Ende muss nach dem Beginn liegen.";
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    onSave({ ...fields, title: fields.title.trim() });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="event-form-title"
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
    >
      <button
        aria-label="Schließen"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/70"
      />

      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#0d111b] p-6">
        <div className="flex items-start justify-between gap-3">
          <h2 id="event-form-title" className="text-lg font-semibold">
            {mode === "new" ? "Neuer Termin" : "Termin bearbeiten"}
          </h2>

          <button
            onClick={onClose}
            aria-label="Schließen"
            className="rounded-xl border border-white/10 p-2 text-slate-400 transition hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} noValidate className="mt-5 space-y-4">
          <label className="block text-xs text-slate-400">
            Titel
            <input
              autoFocus
              value={fields.title}
              onChange={(change) => setField("title", change.target.value)}
              placeholder="z. B. Java-Vorlesung"
              maxLength={120}
              aria-invalid={errors.title !== undefined}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
            {errors.title && (
              <span className="mt-1 block text-xs text-rose-300">
                {errors.title}
              </span>
            )}
          </label>

          <label className="block text-xs text-slate-400">
            Datum
            <input
              type="date"
              value={fields.date}
              onChange={(change) => setField("date", change.target.value)}
              aria-invalid={errors.date !== undefined}
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
            {errors.date && (
              <span className="mt-1 block text-xs text-rose-300">
                {errors.date}
              </span>
            )}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-slate-400">
              Beginn
              <input
                type="time"
                value={fields.start}
                onChange={(change) => setField("start", change.target.value)}
                aria-invalid={errors.time !== undefined}
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
              />
            </label>

            <label className="block text-xs text-slate-400">
              Ende
              <input
                type="time"
                value={fields.end}
                onChange={(change) => setField("end", change.target.value)}
                aria-invalid={errors.time !== undefined}
                className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
              />
            </label>
          </div>

          {errors.time && (
            <p className="text-xs text-rose-300">{errors.time}</p>
          )}

          <label className="block text-xs text-slate-400">
            Art
            <select
              value={fields.type}
              onChange={(change) =>
                setField("type", change.target.value as CalendarEventType)
              }
              className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            >
              <option value="lecture">Vorlesung</option>
              <option value="exam">Prüfung</option>
              <option value="personal">Persönlich</option>
            </select>
          </label>

          <label className="block text-xs text-slate-400">
            Ort (optional)
            <input
              value={fields.location}
              onChange={(change) => setField("location", change.target.value)}
              placeholder="z. B. Raum A101"
              maxLength={120}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
          </label>

          <label className="block text-xs text-slate-400">
            Beschreibung (optional)
            <textarea
              value={fields.description}
              onChange={(change) =>
                setField("description", change.target.value)
              }
              placeholder="Notizen zum Termin"
              maxLength={500}
              rows={3}
              className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
            />
          </label>

          {conflicts.length > 0 && (
            <p className="rounded-xl border border-amber-300/25 bg-amber-300/5 p-3 text-xs leading-5 text-amber-200">
              Überschneidung mit{" "}
              {conflicts.length === 1
                ? "einem Termin"
                : `${conflicts.length} Terminen`}
              : {conflicts.map((conflict) => conflict.title).join(", ")}.
              Speichern ist trotzdem möglich.
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              className="flex-1 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
            >
              {mode === "new" ? "Termin erstellen" : "Änderungen speichern"}
            </button>

            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
            >
              Abbrechen
            </button>
          </div>

          {mode === "edit" && !confirmDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-rose-400/25 px-4 py-3 text-sm text-rose-300 transition hover:bg-rose-400/10"
            >
              <Trash2 size={16} />
              Termin löschen
            </button>
          )}

          {mode === "edit" && confirmDelete && (
            <div className="rounded-xl border border-rose-400/30 bg-rose-400/5 p-4">
              <p className="text-sm text-rose-200">
                Diesen Termin wirklich löschen?
              </p>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => onDelete(initial.id)}
                  className="flex-1 rounded-xl bg-rose-400 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-rose-300"
                >
                  Endgültig löschen
                </button>

                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                >
                  Abbrechen
                </button>
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

