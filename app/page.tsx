
"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  Clock3,
  Command,
  Mic,
  Plus,
  Sparkles,
  Wallet,
} from "lucide-react";

type Task = {
  id: number;
  title: string;
  time: string;
  done: boolean;
};

const initialTasks: Task[] = [
  {
    id: 1,
    title: "Vererbung in Java wiederholen",
    time: "10:30",
    done: false,
  },
  {
    id: 2,
    title: "Unterlagen für die nächste Vorlesung vorbereiten",
    time: "13:00",
    done: false,
  },
  {
    id: 3,
    title: "Aufgaben für die Woche überprüfen",
    time: "16:30",
    done: true,
  },
];

function getGreeting(hour: number) {
  if (hour >= 5 && hour < 11) return "Guten Morgen.";
  if (hour >= 11 && hour < 18) return "Guten Tag.";
  if (hour >= 18 && hour < 22) return "Guten Abend.";
  return "Gute Nacht.";
}

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  const [command, setCommand] = useState("");
  const [message, setMessage] = useState("");
  const [greeting, setGreeting] = useState("Willkommen.");
  const [currentTime, setCurrentTime] = useState("");

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
    const title = window.prompt("Wie lautet die neue Aufgabe?");

    if (!title?.trim()) return;

    setTasks((current) => [
      ...current,
      {
        id: Date.now(),
        title: title.trim(),
        time: "Keine Frist",
        done: false,
      },
    ]);
  }

  return (
    <main className="min-h-screen bg-[#080b12] text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-[1500px]">
        <aside className="hidden w-64 shrink-0 border-r border-white/[0.07] p-6 md:flex md:flex-col">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-300">
              <Command size={22} />
            </div>

            <div>
              <div className="font-semibold tracking-[0.18em]">
                J.A.R.V.I.S.
              </div>
              <div className="text-[10px] tracking-[0.22em] text-slate-500">
                PERSONAL AI
              </div>
            </div>
          </div>

          <nav className="mt-12 space-y-2">
            <p className="mb-4 text-[10px] uppercase tracking-[0.2em] text-slate-500">
              Arbeitsbereich
            </p>

            <NavItem icon={<Activity size={18} />} label="Übersicht" active />
            <NavItem
              icon={<BookOpen size={18} />}
              label="Studium & Wissen"
            />
            <NavItem
              icon={<CalendarDays size={18} />}
              label="Terminplaner"
            />
            <NavItem icon={<Wallet size={18} />} label="Finanzen" />
          </nav>

          <div className="mt-auto rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              System aktiv
            </div>

            <p className="mt-2 text-xs leading-5 text-slate-500">
              Oberfläche bereit. KI-Dienste sind noch nicht verbunden.
            </p>
          </div>
        </aside>

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

          <div className="mt-7 grid gap-5 lg:grid-cols-[1.3fr_1fr]">
            <section className="rounded-3xl border border-white/[0.08] bg-[#0d111b] p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-semibold">Aufgaben für heute</h2>

                  <p className="mt-1 text-xs text-slate-500">
                    {completed} von {tasks.length} Aufgaben erledigt
                  </p>
                </div>

                <button
                  onClick={addTask}
                  className="flex items-center gap-1 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30"
                >
                  <Plus size={15} />
                  Hinzufügen
                </button>
              </div>

              <div className="mt-5 space-y-2">
                {tasks.map((task) => (
                  <button
                    key={task.id}
                    onClick={() =>
                      setTasks((current) =>
                        current.map((item) =>
                          item.id === task.id
                            ? { ...item, done: !item.done }
                            : item
                        )
                      )
                    }
                    aria-pressed={task.done}
                    className="flex w-full items-center gap-3 rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4 text-left transition hover:bg-white/[0.04]"
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                        task.done
                          ? "border-cyan-300 bg-cyan-300 text-slate-950"
                          : "border-slate-600"
                      }`}
                    >
                      {task.done && <Check size={13} />}
                    </span>

                    <span
                      className={`min-w-0 flex-1 text-sm ${
                        task.done
                          ? "text-slate-500 line-through"
                          : "text-slate-200"
                      }`}
                    >
                      {task.title}
                    </span>

                    <span className="shrink-0 text-xs text-slate-500">
                      {task.time}
                    </span>
                  </button>
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

function NavItem({
  icon,
  label,
  active = false,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition ${
        active
          ? "border border-cyan-300/10 bg-cyan-300/10 text-cyan-200"
          : "text-slate-400 hover:bg-white/[0.04] hover:text-white"
      }`}
    >
      {icon}
      {label}
    </button>
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
