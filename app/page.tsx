
"use client";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  Clock3,
  GraduationCap,
  ListTodo,
  Mic,
  Plus,
  Sparkles,
  Sunrise,
  Trash2,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import Sidebar from "@/src/components/Sidebar";
import { useLocalStorage } from "@/src/hooks/useLocalStorage";
import { useToday } from "@/src/hooks/useToday";
import {
  CALENDAR_STORAGE_KEY,
  EVENT_TYPE_STYLES,
  NO_EVENTS,
  isCalendarEventList,
} from "@/src/lib/calendar";
import {
  collectDeadlines,
  formatDayShort,
  formatDaysLeft,
  openTasks,
} from "@/src/lib/briefing";
import {
  EMPTY_FINANCE,
  FINANCE_STORAGE_KEY,
  formatCents,
  formatSignedCents,
  isFinanceData,
  monthLabel,
} from "@/src/lib/finance";
import {
  EMPTY_STUDY,
  STUDY_STORAGE_KEY,
  isStudyData,
} from "@/src/lib/study";
import {
  TASKS_STORAGE_KEY,
  isTaskList,
  type Task,
} from "@/src/lib/tasks";

const initialTasks: Task[] = [
  {
    id: 1,
    title: "Vererbung in Java wiederholen",
    time: "10:30",
    done: false,
    priority:"Hoch",
  },
  {
    id: 2,
    title: "Unterlagen für die nächste Vorlesung vorbereiten",
    time: "13:00",
    done: false,
    priority:"Mittel",
  },
  {
    id: 3,
    title: "Aufgaben für die Woche überprüfen",
    time: "16:30",
    done: true,
    priority:"Niedrig",
  },
];

function getGreeting(hour: number) {
  if (hour >= 5 && hour < 11) return "Guten Morgen.";
  if (hour >= 11 && hour < 18) return "Guten Tag.";
  if (hour >= 18 && hour < 22) return "Guten Abend.";
  return "Gute Nacht.";
}

export default function Home() {
  const [tasks, setTasks] = useLocalStorage<Task[]>(
    TASKS_STORAGE_KEY,
    initialTasks,
    isTaskList,
  );
  const [events, , eventsLoaded] = useLocalStorage(
    CALENDAR_STORAGE_KEY,
    NO_EVENTS,
    isCalendarEventList,
  );
  const today = useToday();
  const todaysEvents =
    today === null
      ? null
      : events
          .filter((event) => event.date === today)
          .sort((a, b) => a.start.localeCompare(b.start));
  const [study, , studyLoaded] = useLocalStorage(
    STUDY_STORAGE_KEY,
    EMPTY_STUDY,
    isStudyData,
  );
  const [finance, , financeLoaded] = useLocalStorage(
    FINANCE_STORAGE_KEY,
    EMPTY_FINANCE,
    isFinanceData,
  );
  const deadlines =
    today === null ? null : collectDeadlines(study, today);
  const briefingTasks = openTasks(tasks);
  const financeMonthKey = today === null ? "" : today.slice(0, 7);
  const financeMonthTransactions =
    financeMonthKey === ""
      ? []
      : finance.transactions.filter((transaction) =>
          transaction.date.startsWith(financeMonthKey),
        );
  const financeIncome = financeMonthTransactions
    .filter((transaction) => transaction.type === "income")
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const financeSpent = financeMonthTransactions
    .filter((transaction) => transaction.type === "expense")
    .reduce((sum, transaction) => sum + transaction.amount, 0);
  const financeMonthLabel =
    financeMonthKey === ""
      ? ""
      : monthLabel({
          year: Number(financeMonthKey.slice(0, 4)),
          month: Number(financeMonthKey.slice(5, 7)) - 1,
        });
  const [command, setCommand] = useState("");
  const [message, setMessage] = useState("");
  const [greeting, setGreeting] = useState("Willkommen.");
  const [currentTime, setCurrentTime] = useState("");
  const [showTaskForm, setShowTaskForm] = useState(false);
const [newTaskTitle, setNewTaskTitle] = useState("");
const [newTaskTime, setNewTaskTime] = useState("");
const [newTaskPriority, setNewTaskPriority] =
  useState<Task["priority"]>("Mittel");

  useEffect(() => {
    function updateClock() {
      const now = new Date();

      setGreeting(getGreeting(now.getHours()));
      setCurrentTime(
        new Intl.DateTimeFormat("de-DE", {
          hour: "2-digit",
          minute: "2-digit",
        }).format(now)
      );
    }

    updateClock();

    const intervalId = window.setInterval(updateClock, 60_000);

    return () => window.clearInterval(intervalId);
  }, []);

  const completed = tasks.filter((task) => task.done).length;

  function submitCommand() {
    if (!command.trim()) return;

    setMessage(
      `Anfrage empfangen: „${command.trim()}“. Die KI-Anbindung folgt im nächsten Entwicklungsschritt.`
    );

    setCommand("");
  }

  function addTask() {
  if (!newTaskTitle.trim()) return;

  const newTask: Task = {
    id: Date.now(),
    title: newTaskTitle.trim(),
    time: newTaskTime || "Keine Frist",
    done: false,
    priority: newTaskPriority,
  };

  setTasks((current) => [...current, newTask]);

  setNewTaskTitle("");
  setNewTaskTime("");
  setNewTaskPriority("Mittel");
  setShowTaskForm(false);
}

  return (
    <main className="min-h-screen bg-[#080b12] text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col md:flex-row">
        <Sidebar />

        <section className="min-w-0 flex-1 px-5 py-7 sm:px-8 lg:px-12">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm text-slate-500">
                PERSONAL COMMAND CENTER
              </p>

              <h1 className="mt-2 text-2xl font-semibold sm:text-3xl">
                {greeting}
              </h1>

              <p className="mt-2 text-sm text-slate-400">
                Lass uns deinen Tag produktiv gestalten.
              </p>
            </div>

            <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-sm text-slate-300">
              <Clock3 className="mr-2 inline" size={16} />
              {currentTime || "--:--"} · JARVIS
            </div>
          </header>

          <div className="mt-9 grid gap-5 xl:grid-cols-[1.5fr_1fr]">
            <section className="relative overflow-hidden rounded-3xl border border-cyan-300/15 bg-gradient-to-br from-[#102333] via-[#101827] to-[#111321] p-6 sm:p-9">
              <div className="pointer-events-none absolute -right-16 -top-20 h-64 w-64 rounded-full bg-cyan-400/[0.09] blur-3xl" />

              <div className="relative">
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-cyan-300">
                  <Sparkles size={15} />
                  Dein persönlicher KI-Assistent
                </div>

                <h2 className="mt-5 text-3xl font-medium leading-tight sm:text-4xl">
                  Wie kann ich dir
                  <br />
                  <span className="text-cyan-300">heute helfen?</span>
                </h2>

                <p className="mt-4 max-w-lg text-sm leading-6 text-slate-400">
                  Studium, Aufgaben und Termine – alles an einem Ort.
                  Was möchtest du heute erledigen?
                </p>

                <div className="mt-8 flex items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-2">
                  <Sparkles
                    className="ml-2 shrink-0 text-cyan-300"
                    size={19}
                  />

                  <input
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitCommand();
                    }}
                    placeholder="Stelle JARVIS eine Frage ..."
                    aria-label="Nachricht an JARVIS"
                    className="min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-slate-600"
                  />

                  <button
                    onClick={submitCommand}
                    aria-label="Anfrage senden"
                    className="rounded-xl bg-cyan-300 p-3 text-slate-950 transition hover:bg-cyan-200"
                  >
                    <ArrowUpRight size={19} />
                  </button>
                </div>

                {message && (
                  <p
                    role="status"
                    className="mt-4 rounded-xl border border-cyan-300/15 bg-cyan-300/5 p-3 text-sm text-cyan-100"
                  >
                    {message}
                  </p>
                )}

                <div className="mt-5 flex flex-wrap gap-2">
                  {[
                    "Plane meinen Tag",
                    "Erkläre mir Java",
                    "Zeige meine Aufgaben",
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => setCommand(suggestion)}
                      className="rounded-full border border-white/10 px-3 py-2 text-xs text-slate-400 transition hover:border-cyan-300/40 hover:text-cyan-200"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="flex flex-col items-center justify-center rounded-3xl border border-white/[0.08] bg-[#0d111b] p-7">
              <div className="relative flex h-48 w-48 items-center justify-center">
                <div className="absolute inset-0 rounded-full border border-cyan-300/10" />
                <div className="absolute inset-4 rounded-full border border-cyan-300/20" />
                <div className="absolute inset-8 rounded-full border border-cyan-300/25" />
                <div className="absolute inset-12 rounded-full border border-cyan-300/30" />

                <div className="flex h-20 w-20 items-center justify-center rounded-full border border-cyan-200/40 bg-cyan-300/10 text-cyan-200 shadow-[0_0_50px_rgba(34,211,238,0.12)]">
                  <Activity size={34} />
                </div>
              </div>

              <p className="mt-5 text-sm font-medium tracking-wide">
                J.A.R.V.I.S.
              </p>

              <p className="mt-2 text-xs text-slate-500">
                Ich bin bereit für deine Anweisungen.
              </p>

              <button
                onClick={() =>
                  setMessage(
                    "Der Sprachmodus wird in einem späteren Entwicklungsschritt integriert."
                  )
                }
                className="mt-5 flex items-center gap-2 rounded-full border border-cyan-300/25 px-5 py-3 text-sm text-cyan-200 transition hover:bg-cyan-300/10"
              >
                <Mic size={17} />
                Sprachmodus
              </button>
            </section>
          </div>

          <section
            aria-label="Tagesbriefing"
            className="mt-7 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-6"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
                <Sunrise size={19} />
              </div>

              <div>
                <h2 className="font-semibold">Tagesbriefing</h2>
                <p className="mt-1 text-xs text-slate-500">
                  {today === null
                    ? "…"
                    : new Intl.DateTimeFormat("de-DE", {
                        dateStyle: "long",
                        timeZone: "UTC",
                      }).format(new Date(`${today}T12:00:00Z`))}
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                    <CalendarDays size={16} className="text-cyan-300" />
                    Heute
                  </h3>
                  <Link
                    href="/calendar"
                    className="shrink-0 text-xs text-slate-500 transition hover:text-cyan-200"
                  >
                    Zum Kalender
                  </Link>
                </div>

                <div className="mt-3">
                  {todaysEvents === null || !eventsLoaded ? (
                    <p className="text-sm text-slate-500">
                      Termine werden geladen …
                    </p>
                  ) : todaysEvents.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      Heute stehen keine Termine an.
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {todaysEvents.slice(0, 5).map((event) => (
                        <li
                          key={event.id}
                          className="flex items-center gap-2.5 text-sm"
                        >
                          <span
                            aria-hidden="true"
                            className={`h-2 w-2 shrink-0 rounded-full ${EVENT_TYPE_STYLES[event.type].dot}`}
                          />
                          <span className="shrink-0 text-xs tabular-nums text-slate-400">
                            {event.start}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-slate-200">
                            {event.title}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {todaysEvents !== null &&
                    eventsLoaded &&
                    todaysEvents.length > 5 && (
                      <p className="mt-2 text-xs text-slate-500">
                        + {todaysEvents.length - 5} weitere Termine
                      </p>
                    )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                    <GraduationCap size={16} className="text-cyan-300" />
                    Deadlines
                  </h3>
                  <Link
                    href="/study"
                    className="shrink-0 text-xs text-slate-500 transition hover:text-cyan-200"
                  >
                    Zum Studium
                  </Link>
                </div>

                <div className="mt-3">
                  {deadlines === null || !studyLoaded ? (
                    <p className="text-sm text-slate-500">
                      Deadlines werden geladen …
                    </p>
                  ) : deadlines.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      Keine anstehenden Prüfungen oder Fristen.
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {deadlines.slice(0, 5).map((deadline) => (
                        <li
                          key={deadline.id}
                          className="flex items-start gap-2.5 text-sm"
                        >
                          <span
                            className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                              deadline.daysLeft < 0
                                ? "bg-rose-400/10 text-rose-300"
                                : deadline.daysLeft <= 1
                                  ? "bg-amber-400/10 text-amber-300"
                                  : "bg-cyan-300/10 text-cyan-200"
                            }`}
                          >
                            {formatDaysLeft(deadline.daysLeft)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-slate-200">
                              {deadline.title}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-slate-500">
                              {deadline.kind === "exam"
                                ? "Prüfung"
                                : "Lernthema"}
                              {deadline.subject
                                ? ` · ${deadline.subject}`
                                : ""}
                              {" · "}
                              {formatDayShort(deadline.date)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {deadlines !== null &&
                    studyLoaded &&
                    deadlines.length > 5 && (
                      <p className="mt-2 text-xs text-slate-500">
                        + {deadlines.length - 5} weitere Deadlines
                      </p>
                    )}
                </div>
              </div>

              <div className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-medium text-slate-200">
                    <ListTodo size={16} className="text-cyan-300" />
                    Aufgaben
                  </h3>
                  <Link
                    href="#aufgaben"
                    className="shrink-0 text-xs text-slate-500 transition hover:text-cyan-200"
                  >
                    Zu den Aufgaben
                  </Link>
                </div>

                <div className="mt-3">
                  {briefingTasks.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      Keine offenen Aufgaben. Stark!
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {briefingTasks.slice(0, 5).map((task) => (
                        <li
                          key={task.id}
                          className="flex items-center gap-2.5 text-sm"
                        >
                          <span
                            aria-hidden="true"
                            className={`h-2 w-2 shrink-0 rounded-full ${
                              task.priority === "Hoch"
                                ? "bg-rose-400"
                                : task.priority === "Mittel"
                                  ? "bg-amber-400"
                                  : "bg-slate-500"
                            }`}
                          />
                          <span className="min-w-0 flex-1 truncate text-slate-200">
                            {task.title}
                          </span>
                          {task.priority === "Hoch" && (
                            <span className="shrink-0 rounded-full bg-rose-400/10 px-2 py-0.5 text-[10px] text-rose-300">
                              Hoch
                            </span>
                          )}
                          <span className="shrink-0 text-xs text-slate-500">
                            {task.time}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {briefingTasks.length > 5 && (
                    <p className="mt-2 text-xs text-slate-500">
                      + {briefingTasks.length - 5} weitere Aufgaben
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] px-4 py-3">
              <Wallet size={17} className="shrink-0 text-cyan-300" />

              <div className="min-w-0 flex-1 text-sm">
                {!financeLoaded || today === null ? (
                  <p className="text-slate-500">Finanzen werden geladen …</p>
                ) : financeMonthTransactions.length === 0 &&
                  finance.monthlyBudgetCents === 0 ? (
                  <p className="text-slate-500">
                    Noch keine Buchungen in diesem Monat.
                  </p>
                ) : (
                  <p className="text-slate-300">
                    {financeMonthLabel}:{" "}
                    <span
                      className={`font-medium tabular-nums ${
                        financeIncome - financeSpent < 0
                          ? "text-rose-200"
                          : "text-cyan-200"
                      }`}
                    >
                      {formatSignedCents(financeIncome - financeSpent)}
                    </span>{" "}
                    <span className="text-slate-500">
                      · Ausgaben {formatCents(financeSpent)}
                    </span>
                    {finance.monthlyBudgetCents > 0 && (
                      <span
                        className={
                          financeSpent > finance.monthlyBudgetCents
                            ? "text-rose-300"
                            : "text-slate-500"
                        }
                      >
                        {" "}
                        · Budget {formatCents(financeSpent)} /{" "}
                        {formatCents(finance.monthlyBudgetCents)}
                        {financeSpent > finance.monthlyBudgetCents
                          ? " überschritten"
                          : ""}
                      </span>
                    )}
                  </p>
                )}
              </div>

              <Link
                href="/finance"
                className="shrink-0 text-xs text-slate-500 transition hover:text-cyan-200"
              >
                Zu den Finanzen
              </Link>
            </div>
          </section>

          <div className="mt-7 grid gap-5 lg:grid-cols-[1.3fr_1fr]">
            <section
              id="aufgaben"
              className="scroll-mt-4 rounded-3xl border border-white/[0.08] bg-[#0d111b] p-6"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Aufgaben für heute</h2>

                  <p className="mt-1 text-xs text-slate-500">
                    {completed} von {tasks.length} Aufgaben erledigt
                  </p>
                </div>

              <button
  onClick={() => setShowTaskForm((current) => !current)}
  className="flex items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30"
>
  <Plus size={15} />
  Hinzufügen
</button>
              </div>

{showTaskForm && (
  <form
    onSubmit={(event) => {
      event.preventDefault();
      addTask();
    }}
    className="mb-4 space-y-3 rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.03] p-4"
  >
    <label className="block text-xs text-slate-400">
      Aufgabenname
      <input
        value={newTaskTitle}
        onChange={(event) => setNewTaskTitle(event.target.value)}
        placeholder="z. B. Java lernen"
        required
        className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
      />
    </label>

    <label className="block text-xs text-slate-400">
      Uhrzeit (optional)
      <input
        type="time"
        value={newTaskTime}
        onChange={(event) => setNewTaskTime(event.target.value)}
        className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
      />
    </label>

    <label className="block text-xs text-slate-400">
      Priorität
      <select
        value={newTaskPriority}
        onChange={(event) =>
          setNewTaskPriority(event.target.value as Task["priority"])
        }
        className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-3 text-sm text-white outline-none focus:border-cyan-300/50"
      >
        <option value="Niedrig">Niedrig</option>
        <option value="Mittel">Mittel</option>
        <option value="Hoch">Hoch</option>
      </select>
    </label>

    <div className="flex gap-2 pt-1">
      <button
        type="submit"
        className="flex-1 rounded-xl bg-cyan-300 px-4 py-3 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
      >
        Aufgabe speichern
      </button>

      <button
        type="button"
        onClick={() => setShowTaskForm(false)}
        className="rounded-xl border border-white/10 px-4 py-3 text-sm text-slate-300 hover:bg-white/5"
      >
        Abbrechen
      </button>
    </div>
  </form>
)}

              <div className="mt-5 space-y-2">
                
{tasks.map((task) => (
  <div
    key={task.id}
    className="flex items-center gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4 transition hover:bg-white/[0.04]"
  >
    <button
      onClick={() =>
        setTasks((current) =>
          current.map((item) =>
            item.id === task.id
              ? { ...item, done: !item.done }
              : item
          )
        )
      }
      aria-label={
        task.done
          ? "Aufgabe als offen markieren"
          : "Aufgabe als erledigt markieren"
      }
      aria-pressed={task.done}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
        task.done
          ? "border-cyan-300 bg-cyan-300 text-slate-950"
          : "border-slate-600"
      }`}
    >
      {task.done && <Check size={13} />}
    </button>

    <div className="min-w-0 flex-1">
      <p
        className={`text-sm ${
          task.done
            ? "text-slate-500 line-through"
            : "text-slate-200"
        }`}
      >
        {task.title}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">
          <Clock3 className="mr-1 inline" size={12} />
          {task.time}
        </span>

        <span
          className={`rounded-full px-2 py-1 text-[10px] ${
            task.priority === "Hoch"
              ? "bg-rose-400/10 text-rose-300"
              : task.priority === "Mittel"
                ? "bg-amber-400/10 text-amber-300"
                : "bg-slate-400/10 text-slate-400"
          }`}
        >
          {task.priority}
        </span>
      </div>
    </div>

    <button
      onClick={() =>
        setTasks((current) =>
          current.filter((item) => item.id !== task.id)
        )
      }
      aria-label={`Aufgabe löschen: ${task.title}`}
      title="Aufgabe löschen"
      className="shrink-0 rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
    >
      <Trash2 size={16} />
    </button>
  </div>
))}

              </div>
            </section>

            <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-6">
              <h2 className="font-semibold">Systemmodule</h2>

              <p className="mt-1 text-xs text-slate-500">
                Deine persönliche Kommandozentrale
              </p>

              <div className="mt-5 space-y-3">
                <Module
                  icon={<BookOpen size={19} />}
                  title="Smart Memory"
                  detail="PDFs, Lernmaterialien und Prüfungsvorbereitung"
                />

                <Module
                  icon={<CalendarDays size={19} />}
                  title="Daily Briefing"
                  detail="Tagesplanung, Termine und Erinnerungen"
                />

                <Module
                  icon={<Wallet size={19} />}
                  title="Financial Intelligence"
                  detail="Ausgaben, Budget und Finanzanalysen"
                />
              </div>

              <p className="mt-5 text-xs leading-5 text-slate-600">
                Früher Prototyp: KI-Funktionen und dauerhafte Datenspeicherung
                werden schrittweise ergänzt.
              </p>
            </section>
          </div>

          <footer className="py-8 text-center text-xs text-slate-600">
            J.A.R.V.I.S. · Personal AI Workspace · Früher Prototyp
          </footer>
        </section>
      </div>
    </main>
  );
}

function Module({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-white/[0.06] p-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
        {icon}
      </div>

      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p>
      </div>
    </div>
  );
}
