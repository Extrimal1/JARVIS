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
import { createId } from "@/src/lib/ids";
import { useLockBodyScroll } from "@/src/hooks/useLockBodyScroll";
import { useCalendarEvents } from "@/src/lib/db/useModules";
import {
  EVENT_TYPE_STYLES,
  addDays,
  dayViewLabel,
  eventsOnDay,
  findConflicts,
  layoutDayEvents,
  minutesToTime,
  monthCells,
  monthGridLabel,
  parseISODateLocal,
  shiftYearMonth,
  startOfWeekMonday,
  timeToMinutes,
  toISODateLocal,
  weekDays,
  weekLabel,
  type CalendarEvent,
  type CalendarEventType,
} from "@/src/lib/calendar";
import { EMPTY_STUDY, type Entry } from "@/src/lib/study";
import { useStudy } from "@/src/lib/db/useModules";

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

type CalendarView = "month" | "week" | "day";

const VIEWS: { key: CalendarView; label: string }[] = [
  { key: "month", label: "Monat" },
  { key: "week", label: "Woche" },
  { key: "day", label: "Tag" },
];

const EVENT_TYPE_LABELS: Record<CalendarEventType, string> = {
  lecture: "Vorlesung",
  exam: "Prüfung",
  personal: "Persönlich",
};

type Draft = { mode: "new" | "edit"; event: CalendarEvent };

type ClockSnapshot = { todayISO: string; nowMinutes: number };

export default function CalendarPage() {
  const [now, setNow] = useState<Date | null>(null);

  const eventsStore = useCalendarEvents();
  const events = eventsStore.items;
  const studyStore = useStudy(EMPTY_STUDY);
  const studyExams = useMemo(
    () =>
      studyStore.data.exams.filter(
        (exam) => exam.date !== undefined && exam.date !== "",
      ),
    [studyStore.data.exams],
  );

  const [snapshot, setSnapshot] = useState<ClockSnapshot | null>(null);
  const [weekStart, setWeekStart] = useState<Date | null>(null);
  const [anchor, setAnchor] = useState<Date | null>(null);
  const [view, setView] = useState<CalendarView>("week");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    // Mount-gated clock: prerendered HTML must not depend on now.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date());

    const timer = window.setInterval(() => setNow(new Date()), 30_000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (now === null) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnapshot({
      todayISO: toISODateLocal(now),
      nowMinutes: now.getHours() * 60 + now.getMinutes(),
    });
    setWeekStart((current) => current ?? startOfWeekMonday(now));
    setAnchor((current) => current ?? now);
  }, [now]);

  const days = useMemo(
    () => (weekStart === null ? [] : weekDays(weekStart)),
    [weekStart],
  );

  const todayISO = snapshot?.todayISO ?? "";
  const nowMinutes = snapshot?.nowMinutes ?? 0;

  const visibleEvents = useMemo(
    () =>
      filter === "all"
        ? events
        : events.filter((event) => event.type === filter),
    [events, filter],
  );

  const range = useMemo(() => {
    if (view === "week") {
      if (weekStart === null) return null;

      return {
        from: toISODateLocal(weekStart),
        to: toISODateLocal(addDays(weekStart, 6)),
      };
    }

    if (anchor === null) return null;

    if (view === "day") {
      const iso = toISODateLocal(anchor);

      return { from: iso, to: iso };
    }

    return {
      from: toISODateLocal(
        new Date(anchor.getFullYear(), anchor.getMonth(), 1),
      ),
      to: toISODateLocal(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)),
    };
  }, [view, weekStart, anchor]);

  const rangeCounts = useMemo(() => {
    const counts: Record<FilterKey, number> = {
      all: 0,
      lecture: 0,
      exam: 0,
      personal: 0,
    };

    if (range === null) return counts;

    for (const event of events) {
      if (event.date < range.from || event.date > range.to) continue;

      counts.all += 1;
      counts[event.type] += 1;
    }

    return counts;
  }, [events, range]);

  const rangeLabel =
    view === "week"
      ? weekStart === null
        ? "Kalender wird geladen …"
        : weekLabel(weekStart)
      : anchor === null
        ? "Kalender wird geladen …"
        : view === "month"
          ? monthGridLabel(anchor.getFullYear(), anchor.getMonth())
          : dayViewLabel(anchor);

  function shiftRange(direction: -1 | 1) {
    if (view === "week") {
      setWeekStart((current) =>
        current === null ? current : addDays(current, direction * 7),
      );

      return;
    }

    setAnchor((current) => {
      if (current === null) return current;

      if (view === "day") return addDays(current, direction);

      const shifted = shiftYearMonth(
        current.getFullYear(),
        current.getMonth(),
        direction,
      );

      return new Date(shifted.year, shifted.month, 1);
    });
  }

  function goToToday() {
    const current = new Date();
    setNow(current);
    setWeekStart(startOfWeekMonday(current));
    setAnchor(current);
  }

  function openDay(iso: string) {
    const date = parseISODateLocal(iso);

    if (date !== null) setAnchor(date);

    setView("day");
  }

  function openNew(date: string, start: string, end: string, id: string) {
    setDraft({
      mode: "new",
      event: {
        id,
        title: "",
        date,
        start,
        end,
        type: "personal",
        description: "",
        location: "",
      },
    });
  }

  function openNewDefault() {
    const base = anchor ?? weekStart ?? new Date();
    const date = toISODateLocal(base);
    const start = "09:00";
    const end = "10:00";

    openNew(date, start, end, createId());
  }

  function handleColumnClick(
    date: string,
    clientY: number,
    top: number,
    height: number,
    id: string,
  ) {
    const ratio = height > 0 ? (clientY - top) / height : 0;
    const clamped = Math.min(Math.max(ratio, 0), 0.999);
    const minutes = Math.floor((clamped * 24 * 60) / 30) * 30;
    const start = minutesToTime(minutes);
    const end = minutesToTime(minutes + 60);

    openNew(date, start, end, id);
  }

  function openEdit(event: CalendarEvent) {
    setDraft({ mode: "edit", event });
  }

  async function saveDraft(event: CalendarEvent) {
    const result =
      draft?.mode === "new"
        ? await eventsStore.create(event)
        : await eventsStore.update(event.id, event);

    if (!result.ok) return;

    setDraft(null);
  }

  async function deleteDraft(id: string) {
    const result = await eventsStore.remove(id);

    if (!result.ok) return;

    setDraft(null);
  }

  return (
    <main className="min-h-screen bg-[#080d18] text-white">
      <div className="mx-auto flex max-w-[1400px] gap-6 px-6 py-8">
        <Sidebar />

        <section className="min-w-0 flex-1">
          <header className="flex items-center gap-3">
            <Link
              href="/"
              aria-label="Zurück zur Übersicht"
              className="rounded-xl border border-white/10 p-2.5 text-slate-300 transition hover:bg-white/5 hover:text-white"
            >
              <ArrowLeft size={18} />
            </Link>

            <div>
              <h1 className="text-xl font-semibold">Terminplaner</h1>
              <p className="text-sm text-slate-400">
                Vorlesungen, Prüfungen & persönliche Termine
              </p>
            </div>
          </header>

          {eventsStore.loading && (
            <p
              aria-live="polite"
              className="mt-4 rounded-2xl border border-white/[0.08] bg-[#0d111b] px-4 py-3 text-sm text-slate-400"
            >
              Termine werden geladen …
            </p>
          )}

          {eventsStore.error !== null && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/25 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"
            >
              <span className="min-w-0 flex-1">
                Termine konnten nicht geladen werden: {eventsStore.error}
              </span>
              <button
                onClick={() => void eventsStore.refresh()}
                className="rounded-xl border border-rose-300/30 px-3 py-1.5 text-xs transition hover:bg-rose-400/10"
              >
                Erneut versuchen
              </button>
            </div>
          )}

          <div className="jarvis-enter mt-4 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-2xl border border-white/[0.08] bg-[#0d111b] p-1">
              <button
                onClick={() => shiftRange(-1)}
                aria-label="Vorheriger Zeitraum"
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
                onClick={() => shiftRange(1)}
                aria-label="Nächster Zeitraum"
                className="rounded-xl p-2.5 text-slate-300 transition hover:bg-white/5 hover:text-white"
              >
                <ChevronRight size={18} />
              </button>
            </div>

            <div
              role="group"
              aria-label="Kalenderansicht"
              className="flex items-center gap-1 rounded-2xl border border-white/[0.08] bg-[#0d111b] p-1"
            >
              {VIEWS.map((entry) => (
                <button
                  key={entry.key}
                  onClick={() => setView(entry.key)}
                  aria-pressed={view === entry.key}
                  className={`rounded-xl px-3 py-2 text-sm transition ${
                    view === entry.key
                      ? "bg-cyan-300/15 font-medium text-cyan-200"
                      : "text-slate-300 hover:bg-white/5 hover:text-white"
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>

            <p aria-live="polite" className="text-sm font-medium text-slate-200">
              {rangeLabel}
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
                    {label} · {rangeCounts[key]}
                  </button>
                );
              })}
            </div>

            <button
              onClick={openNewDefault}
              disabled={view === "week" ? weekStart === null : anchor === null}
              className="ml-auto flex items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={16} />
              Neuer Termin
            </button>
          </div>

          {(view === "week" && (weekStart === null || days.length === 0)) ||
          (view !== "week" && anchor === null) ? (
            <div className="jarvis-fade mt-6 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-10 text-center text-sm text-slate-500">
              Kalender wird geladen …
            </div>
          ) : view === "month" && anchor !== null ? (
            <MonthGrid
              anchor={anchor}
              visibleEvents={visibleEvents}
              studyExams={studyExams}
              showExams={filter === "all" || filter === "exam"}
              todayISO={todayISO}
              onSelectDay={openDay}
              onEdit={openEdit}
            />
          ) : view === "day" && anchor !== null ? (
            <DayAgenda
              anchor={anchor}
              visibleEvents={visibleEvents}
              studyExams={studyExams}
              showExams={filter === "all" || filter === "exam"}
              onEdit={openEdit}
              onNew={(date) => openNew(date, "09:00", "10:00", createId())}
            />
          ) : (
            <div
              className="jarvis-enter mt-6 max-h-[75vh] overflow-auto rounded-3xl border border-white/[0.08] bg-[#0d111b]"
              style={{ "--enter-delay": "80ms" } as React.CSSProperties}
            >
              <div className="min-w-[900px]">
                <div className="sticky top-0 z-10 grid grid-cols-[52px_repeat(7,minmax(0,1fr))] border-b border-white/[0.08] bg-[#0d111b]">
                  <div aria-hidden="true" />

                  {days.map((day) => {
                    const iso = toISODateLocal(day);
                    const isToday = iso === todayISO;
                    // Read-only exam overlay (same source as month/day
                    // views): exams live in the study module.
                    const dayExams =
                      filter === "all" || filter === "exam"
                        ? studyExams.filter((exam) => exam.date === iso)
                        : [];

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

                        {dayExams.length > 0 && (
                          <div className="mt-1 space-y-1">
                            {dayExams.slice(0, 2).map((exam) => (
                              <Link
                                key={exam.id}
                                href="/study?tab=prep&prep=exams"
                                title={`Prüfung (Studium): ${exam.title}`}
                                className="block truncate rounded-md border-l-2 border-violet-300 bg-violet-300/10 px-1.5 py-0.5 text-left text-[10px] leading-tight text-violet-200 transition hover:bg-violet-300/20"
                              >
                                {exam.title}
                              </Link>
                            ))}
                            {dayExams.length > 2 && (
                              <Link
                                href="/study?tab=prep&prep=exams"
                                className="block text-left text-[10px] text-slate-500 transition hover:text-slate-300"
                              >
                                + {dayExams.length - 2} weitere
                              </Link>
                            )}
                          </div>
                        )}
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
                            createId(),
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
            {view === "week" &&
              "Tipp: Klicke auf eine freie Fläche, um einen Termin zu erstellen. Überschneidungen werden beim Bearbeiten als Hinweis angezeigt."}
            {view === "month" &&
              "Tipp: Klicke auf einen Tag für die Tagesansicht. Violette Einträge sind Prüfungen aus dem Studium (schreibgeschützt, Bearbeitung im Studium-Bereich)."}
            {view === "day" &&
              "Tipp: Alle Termine des Tages auf einen Blick — anklicken zum Bearbeiten. Prüfungen aus dem Studium sind schreibgeschützt verlinkt."}
          </p>

          <footer className="py-8 text-center text-xs text-slate-600">
            J.A.R.V.I.S. · Terminplaner ·{" "}
            {eventsStore.mode === "cloud"
              ? "Cloud-Synchronisierung"
              : "Lokale Speicherung"}
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

const MONTH_WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function MonthGrid({
  anchor,
  visibleEvents,
  studyExams,
  showExams,
  todayISO,
  onSelectDay,
  onEdit,
}: {
  anchor: Date;
  visibleEvents: CalendarEvent[];
  studyExams: Entry[];
  showExams: boolean;
  todayISO: string;
  onSelectDay: (iso: string) => void;
  onEdit: (event: CalendarEvent) => void;
}) {
  const cells = useMemo(
    () => monthCells(anchor.getFullYear(), anchor.getMonth()),
    [anchor],
  );
  const examsByDay = useMemo(() => {
    const map = new Map<string, Entry[]>();

    if (!showExams) return map;

    for (const exam of studyExams) {
      if (exam.date === undefined) continue;

      const list = map.get(exam.date) ?? [];
      list.push(exam);
      map.set(exam.date, list);
    }

    return map;
  }, [studyExams, showExams]);

  return (
    <div
      className="jarvis-enter mt-6 overflow-hidden rounded-3xl border border-white/[0.08] bg-[#0d111b]"
      style={{ "--enter-delay": "80ms" } as React.CSSProperties}
    >
      <div className="grid grid-cols-7 border-b border-white/[0.08]">
        {MONTH_WEEKDAYS.map((day) => (
          <div
            key={day}
            className="px-2 py-3 text-center text-[11px] uppercase tracking-wider text-slate-500"
          >
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((cell) => {
          const dayEvents = eventsOnDay(visibleEvents, cell.iso);
          const dayExams = examsByDay.get(cell.iso) ?? [];
          const isToday = cell.iso === todayISO;
          const shown = dayEvents.slice(0, 3);
          const hidden = dayEvents.length - shown.length;

          return (
            <div
              key={cell.iso}
              className={`min-h-24 border-b border-r border-white/[0.06] p-1.5 align-top last:border-r-0 [&:nth-child(7n)]:border-r-0 ${
                cell.inMonth ? "" : "bg-white/[0.015] opacity-60"
              } ${isToday ? "bg-cyan-300/[0.05]" : ""}`}
            >
              <button
                onClick={() => onSelectDay(cell.iso)}
                aria-label={`Tagesansicht: ${cell.iso}`}
                className={`mx-auto flex h-7 w-7 items-center justify-center rounded-full text-xs tabular-nums transition hover:bg-white/10 ${
                  isToday
                    ? "bg-cyan-300 font-semibold text-slate-950"
                    : "text-slate-300"
                }`}
              >
                {cell.date.getDate()}
              </button>

              <div className="mt-1 space-y-1">
                {dayExams.map((exam) => (
                  <Link
                    key={exam.id}
                    href="/study?tab=prep&prep=exams"
                    title={`Prüfung (Studium): ${exam.title}`}
                    className="block truncate rounded-md border-l-2 border-violet-300 bg-violet-300/10 px-1.5 py-0.5 text-[10px] leading-tight text-violet-200 transition hover:bg-violet-300/20"
                  >
                    {exam.title}
                  </Link>
                ))}

                {shown.map((event) => (
                  <button
                    key={event.id}
                    onClick={() => onEdit(event)}
                    title={`${event.title} (${event.start}–${event.end})`}
                    className={`block w-full truncate rounded-md border-l-2 px-1.5 py-0.5 text-left text-[10px] leading-tight transition ${EVENT_TYPE_STYLES[event.type].block}`}
                  >
                    {event.title}
                  </button>
                ))}

                {hidden > 0 && (
                  <button
                    onClick={() => onSelectDay(cell.iso)}
                    className="block w-full rounded-md px-1.5 py-0.5 text-left text-[10px] text-slate-500 transition hover:text-slate-300"
                  >
                    + {hidden} weitere
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayAgenda({
  anchor,
  visibleEvents,
  studyExams,
  showExams,
  onEdit,
  onNew,
}: {
  anchor: Date;
  visibleEvents: CalendarEvent[];
  studyExams: Entry[];
  showExams: boolean;
  onEdit: (event: CalendarEvent) => void;
  onNew: (date: string) => void;
}) {
  const iso = toISODateLocal(anchor);
  const list = eventsOnDay(visibleEvents, iso);
  const exams = showExams
    ? studyExams.filter((exam) => exam.date === iso)
    : [];

  return (
    <div
      className="jarvis-enter mt-6 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-5 sm:p-6"
      style={{ "--enter-delay": "80ms" } as React.CSSProperties}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-400">
          {list.length} {list.length === 1 ? "Termin" : "Termine"}
          {exams.length > 0 &&
            ` · ${exams.length} ${exams.length === 1 ? "Prüfung" : "Prüfungen"} aus dem Studium`}
        </p>
        <button
          onClick={() => onNew(iso)}
          className="flex items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
        >
          <Plus size={15} />
          Neuer Termin
        </button>
      </div>

      {exams.length > 0 && (
        <ul className="mt-4 space-y-2" aria-label="Prüfungen aus dem Studium">
          {exams.map((exam) => (
            <li key={exam.id}>
              <Link
                href="/study?tab=prep&prep=exams"
                className="flex items-center gap-3 rounded-2xl border border-violet-300/25 bg-violet-300/5 p-4 transition hover:bg-violet-300/10"
              >
                <span className="rounded-full bg-violet-300/15 px-2 py-1 text-[10px] font-medium text-violet-200">
                  Prüfung
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-100">
                    {exam.title}
                  </span>
                  {exam.subject !== undefined && exam.subject !== "" && (
                    <span className="mt-0.5 block truncate text-xs text-slate-500">
                      {exam.subject}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4">
        {list.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm text-slate-500">
            Keine Termine an diesem Tag. Lege oben einen neuen Termin an.
          </div>
        ) : (
          <ul className="space-y-2">
            {list.map((event) => {
              const style = EVENT_TYPE_STYLES[event.type];

              return (
                <li key={event.id}>
                  <button
                    onClick={() => onEdit(event)}
                    className={`flex w-full items-start gap-3 rounded-2xl border-l-2 p-4 text-left transition ${style.block}`}
                  >
                    <span className="shrink-0 text-xs tabular-nums opacity-80">
                      {event.start}–{event.end}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {event.title}
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] opacity-75">
                        <span>{EVENT_TYPE_LABELS[event.type]}</span>
                        {event.location !== "" && (
                          <span>· {event.location}</span>
                        )}
                      </span>
                      {event.description !== "" && (
                        <span className="mt-1 line-clamp-2 block text-xs opacity-70">
                          {event.description}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
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
  onDelete: (id: string) => void;
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
        className="jarvis-fade absolute inset-0 h-full w-full cursor-default bg-black/70"
      />

      <div className="jarvis-pop relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-white/10 bg-[#0d111b] p-6">
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
