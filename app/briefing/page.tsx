"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Bell,
  BellOff,
  CalendarDays,
  CloudSun,
  FlaskConical,
  Landmark,
  ListTodo,
  Newspaper,
  RefreshCw,
  Repeat,
  Sparkles,
  Sunrise,
  Timer,
  Trophy,
} from "lucide-react";
import Link from "next/link";
import Sidebar from "@/src/components/Sidebar";
import { useLocalStorage } from "@/src/hooks/useLocalStorage";
import { useWeather } from "@/src/hooks/useWeather";
import { CLOUD_ENABLED } from "@/src/lib/db/mode";
import {
  useCalendarEvents,
  useFinance,
  useQuiz,
  useStudy,
  useTasks,
} from "@/src/lib/db/useModules";
import { formatDayShort, formatDaysLeft } from "@/src/lib/briefing";
import {
  composeBriefing,
  type MorningBriefing,
} from "@/src/lib/briefing/compose";
import {
  BRIEFING_SETTINGS_KEY,
  DEFAULT_BRIEFING_SETTINGS,
  describeSchedule,
  isBriefingSettings,
  isTimezone,
  localDateInTimezone,
  type BriefingSettings,
} from "@/src/lib/briefing/schedule";
import { EMPTY_STUDY } from "@/src/lib/study";
import {
  DEFAULT_CITY,
  describeCode,
  isWeatherReport,
  type WeatherCity,
  type WeatherReport,
} from "@/src/lib/weather";
import {
  isNewsItem,
  type NewsItem,
} from "@/src/lib/lifestyle/news";

type ApiOk<T> = { ok: true; data: T };
type ApiFail = { ok: false; error: { code: string; message: string } };

async function api<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data: T } | { error: string }> {
  let res: Response;

  try {
    res = await fetch(path, init);
  } catch {
    return { error: "Netzwerkfehler — bitte Verbindung prüfen." };
  }

  const parsed = (await res.json().catch(() => null)) as
    | ApiOk<T>
    | ApiFail
    | null;

  if (parsed?.ok === true) return { data: parsed.data };

  return {
    error:
      parsed !== null && parsed.ok === false
        ? parsed.error.message
        : `Anfrage fehlgeschlagen (HTTP ${res.status}).`,
  };
}

function isBriefing(value: unknown): value is MorningBriefing {
  if (typeof value !== "object" || value === null) return false;

  const briefing = value as Record<string, unknown>;

  return (
    typeof briefing.dateISO === "string" &&
    typeof briefing.generatedAt === "string" &&
    typeof briefing.timezone === "string" &&
    typeof briefing.weather === "object" &&
    typeof briefing.events === "object" &&
    typeof briefing.tasks === "object" &&
    typeof briefing.deadlines === "object" &&
    typeof briefing.reviews === "object" &&
    typeof briefing.news === "object" &&
    typeof briefing.finance === "object" &&
    Array.isArray(briefing.gaps)
  );
}

type ServerSubscription = {
  id: string;
  host: string;
  createdAt: string;
  lastUsedAt: string | null;
};

function isServerSubscriptionList(value: unknown): value is ServerSubscription[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (typeof entry !== "object" || entry === null) return false;

      const row = entry as Record<string, unknown>;

      return (
        typeof row.id === "string" &&
        typeof row.host === "string" &&
        typeof row.createdAt === "string" &&
        (row.lastUsedAt === null || typeof row.lastUsedAt === "string")
      );
    })
  );
}

type TestResult = {
  delivered: number;
  total: number;
};

const CARD =
  "rounded-2xl border border-white/[0.08] bg-[#0d111b] px-4 py-4 sm:px-5";

function SectionTitle({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-cyan-300">{icon}</span>
      <h2 className="text-sm font-semibold tracking-wide">{title}</h2>
      {hint !== undefined && (
        <span className="text-xs text-slate-500">{hint}</span>
      )}
    </div>
  );
}

function BriefingSections({ briefing }: { briefing: MorningBriefing }) {
  const report: WeatherReport | null = briefing.weather.report;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className={CARD}>
        <SectionTitle
          icon={<CloudSun size={16} />}
          title="Wetter"
          hint={briefing.weather.city.name}
        />
        {report === null ? (
          <p className="text-sm text-slate-400">
            {briefing.weather.unavailableReason ?? "Keine Wetterdaten."}
          </p>
        ) : (
          <p className="text-sm text-slate-200">
            {describeCode(report.now.code).label}, {report.now.temperature} °C
            <span className="text-slate-400">
              {" "}
              ({report.now.low}–{report.now.high} °C, gefühlt{" "}
              {report.now.feelsLike} °C)
            </span>
          </p>
        )}
        {briefing.weather.usedDefaultCity && (
          <p className="mt-1 text-xs text-slate-500">
            Standardort Stuttgart — eigener Ort in den Einstellungen.
          </p>
        )}
      </div>

      <div className={CARD}>
        <SectionTitle
          icon={<CalendarDays size={16} />}
          title="Heute im Kalender"
        />
        {briefing.events.events.length === 0 ? (
          <p className="text-sm text-slate-400">Keine Termine.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {briefing.events.events.map((event) => (
              <li key={event.id} className="text-slate-200">
                <span className="text-cyan-200">
                  {event.start}–{event.end}
                </span>{" "}
                {event.title}
                {event.location !== "" && (
                  <span className="text-slate-400"> ({event.location})</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={CARD}>
        <SectionTitle icon={<ListTodo size={16} />} title="Aufgaben" />
        {briefing.tasks.tasks.length === 0 ? (
          <p className="text-sm text-slate-400">Keine offenen Aufgaben.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {briefing.tasks.tasks.map((task) => (
              <li key={task.id} className="text-slate-200">
                <span className="text-amber-200">[{task.priority}]</span>{" "}
                {task.title}
                <span className="text-slate-400"> ({task.time})</span>
              </li>
            ))}
          </ul>
        )}
        {briefing.tasks.totalOpen > briefing.tasks.tasks.length && (
          <p className="mt-1 text-xs text-slate-500">
            … und {briefing.tasks.totalOpen - briefing.tasks.tasks.length}{" "}
            weitere.
          </p>
        )}
      </div>

      <div className={CARD}>
        <SectionTitle icon={<Trophy size={16} />} title="Prüfungen & Themen" />
        {briefing.deadlines.deadlines.length === 0 ? (
          <p className="text-sm text-slate-400">Keine Termine mit Datum.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {briefing.deadlines.deadlines.map((deadline) => (
              <li key={deadline.id} className="text-slate-200">
                {deadline.title}{" "}
                <span
                  className={
                    deadline.daysLeft < 0
                      ? "text-rose-300"
                      : "text-slate-400"
                  }
                >
                  — {formatDaysLeft(deadline.daysLeft)} (
                  {formatDayShort(deadline.date)})
                </span>
              </li>
            ))}
          </ul>
        )}
        {briefing.deadlines.total > briefing.deadlines.deadlines.length && (
          <p className="mt-1 text-xs text-slate-500">
            … und{" "}
            {briefing.deadlines.total - briefing.deadlines.deadlines.length}{" "}
            weitere.
          </p>
        )}
      </div>

      <div className={CARD}>
        <SectionTitle icon={<Repeat size={16} />} title="Wiederholungen" />
        {briefing.reviews.totalQuestions === 0 ? (
          <p className="text-sm text-slate-400">Keine Karten vorhanden.</p>
        ) : briefing.reviews.dueCount === 0 ? (
          <p className="text-sm text-slate-400">Heute nichts fällig.</p>
        ) : (
          <>
            <p className="text-sm text-slate-200">
              {briefing.reviews.dueCount} fällig
              {briefing.reviews.overdueCount > 0 && (
                <span className="text-rose-300">
                  {" "}
                  ({briefing.reviews.overdueCount} überfällig)
                </span>
              )}
            </p>
            <ul className="mt-1 space-y-1 text-sm text-slate-400">
              {briefing.reviews.sample.map((sample, index) => (
                <li key={`${sample.dueISO}-${index}`}>
                  • {sample.question}
                  {sample.subject !== "" && ` [${sample.subject}]`}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className={CARD}>
        <SectionTitle icon={<Newspaper size={16} />} title="Nachrichten" />
        {briefing.news.unavailableReason !== null ? (
          <p className="text-sm text-slate-400">
            {briefing.news.unavailableReason}
          </p>
        ) : briefing.news.items.length === 0 ? (
          <p className="text-sm text-slate-400">Keine Meldungen.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {briefing.news.items.map((item) => (
              <li key={item.id}>
                <a
                  href={item.link}
                  target="_blank"
                  rel="noreferrer"
                  className="text-slate-200 underline decoration-slate-600 underline-offset-2 hover:text-white"
                >
                  {item.title}
                </a>{" "}
                <span className="text-xs text-slate-500">
                  ({item.feedLabel})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={CARD}>
        <SectionTitle icon={<Landmark size={16} />} title="Finanzen" />
        {briefing.finance.reminders.length === 0 ? (
          <p className="text-sm text-slate-400">Keine Auffälligkeiten.</p>
        ) : (
          <ul className="space-y-1 text-sm text-slate-200">
            {briefing.finance.reminders.map((reminder, index) => (
              <li key={index}>• {reminder.text}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl border border-cyan-400/25 bg-cyan-400/5 px-4 py-4 sm:px-5">
        <SectionTitle icon={<Sparkles size={16} />} title="Empfehlung" />
        {briefing.recommendation === null ? (
          <p className="text-sm text-slate-400">
            Keine Datengrundlage — keine Empfehlung möglich.
          </p>
        ) : (
          <>
            <p className="text-sm font-medium text-slate-100">
              {briefing.recommendation.title}
            </p>
            <p className="mt-1 text-sm text-slate-300">
              {briefing.recommendation.detail}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {briefing.recommendation.source}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const TIMEZONES = [
  "Europe/Berlin",
  "Europe/Vienna",
  "Europe/Zurich",
  "UTC",
  "Europe/London",
  "America/New_York",
  "Asia/Dubai",
];

function SettingsForm({
  initial,
  showCity,
  saving,
  saveError,
  onSave,
}: {
  /** Loaded settings; the form owns its draft from mount on. */
  initial: BriefingSettings;
  showCity: boolean;
  saving: boolean;
  saveError: string | null;
  onSave: (next: BriefingSettings) => void;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [time, setTime] = useState(initial.time);
  const [timezone, setTimezone] = useState(initial.timezone);
  const [interests, setInterests] = useState(initial.interests);
  const [cityName, setCityName] = useState(initial.city?.name ?? "");
  const [cityLat, setCityLat] = useState(
    initial.city === null ? "" : String(initial.city.latitude),
  );
  const [cityLon, setCityLon] = useState(
    initial.city === null ? "" : String(initial.city.longitude),
  );
  const [formError, setFormError] = useState<string | null>(null);

  function save(): void {
    setFormError(null);

    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
      setFormError("Uhrzeit bitte als HH:MM angeben (z. B. 07:30).");
      return;
    }

    if (!isTimezone(timezone)) {
      setFormError("Unbekannte Zeitzone (z. B. Europe/Berlin).");
      return;
    }

    let city: WeatherCity | null = null;

    if (showCity && (cityName.trim() !== "" || cityLat !== "" || cityLon !== "")) {
      const lat = Number(cityLat.replace(",", "."));
      const lon = Number(cityLon.replace(",", "."));

      if (
        cityName.trim() === "" ||
        !Number.isFinite(lat) ||
        lat < -90 ||
        lat > 90 ||
        !Number.isFinite(lon) ||
        lon < -180 ||
        lon > 180
      ) {
        setFormError(
          "Wetterort braucht Name + gültige Koordinaten (Breite −90…90, Länge −180…180).",
        );
        return;
      }

      city = { name: cityName.trim(), latitude: lat, longitude: lon, detail: "" };
    }

    onSave({
      enabled,
      time,
      timezone,
      city,
      interests: interests.slice(0, 500),
    });
  }

  return (
    <div className={CARD}>
      <SectionTitle icon={<Timer size={16} />} title="Zeitplan" />
      <p className="mb-3 text-xs text-slate-500">
        {describeSchedule({ enabled, time, timezone })}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-4 w-4 accent-cyan-400"
          />
          Tägliches Briefing senden
        </label>

        <label className="text-sm text-slate-200">
          Uhrzeit
          <input
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
            className="mt-1 w-full rounded-xl border border-white/10 bg-[#080d18] px-3 py-2 text-sm text-white"
          />
        </label>

        <label className="text-sm text-slate-200">
          Zeitzone
          <input
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            list="briefing-timezones"
            placeholder="Europe/Berlin"
            className="mt-1 w-full rounded-xl border border-white/10 bg-[#080d18] px-3 py-2 text-sm text-white"
          />
          <datalist id="briefing-timezones">
            {TIMEZONES.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </label>

        <label className="text-sm text-slate-200">
          Nachrichten-Interessen (kommagetrennt, leer = alle)
          <input
            value={interests}
            onChange={(event) => setInterests(event.target.value)}
            placeholder="z. B. Klima, KI, Fußball"
            className="mt-1 w-full rounded-xl border border-white/10 bg-[#080d18] px-3 py-2 text-sm text-white"
          />
        </label>

        {showCity && (
          <>
            <label className="text-sm text-slate-200 sm:col-span-2">
              Wetterort (leer = Standardort Stuttgart)
              <input
                value={cityName}
                onChange={(event) => setCityName(event.target.value)}
                placeholder="z. B. München"
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#080d18] px-3 py-2 text-sm text-white"
              />
            </label>
            <label className="text-sm text-slate-200">
              Breite
              <input
                value={cityLat}
                onChange={(event) => setCityLat(event.target.value)}
                placeholder="48,13"
                inputMode="decimal"
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#080d18] px-3 py-2 text-sm text-white"
              />
            </label>
            <label className="text-sm text-slate-200">
              Länge
              <input
                value={cityLon}
                onChange={(event) => setCityLon(event.target.value)}
                placeholder="11,57"
                inputMode="decimal"
                className="mt-1 w-full rounded-xl border border-white/10 bg-[#080d18] px-3 py-2 text-sm text-white"
              />
            </label>
          </>
        )}
      </div>

      {(formError ?? saveError) !== null && (
        <p role="alert" className="mt-2 text-sm text-rose-300">
          {formError ?? saveError}
        </p>
      )}

      <button
        onClick={save}
        disabled={saving}
        className="mt-3 rounded-xl border border-cyan-300/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100 transition hover:bg-cyan-400/20 disabled:opacity-50"
      >
        {saving ? "Wird gespeichert …" : "Zeitplan speichern"}
      </button>
    </div>
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));

  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

function PushCard({
  subscriptions,
  onChanged,
}: {
  subscriptions: ServerSubscription[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<"sub" | "unsub" | "test" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [supported] = useState(
    () =>
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window,
  );

  const verified =
    test !== null
      ? test.delivered > 0
      : subscriptions.some((sub) => sub.lastUsedAt !== null);

  async function subscribe(): Promise<void> {
    setBusy("sub");
    setMessage(null);
    setError(null);

    try {
      if (!supported) {
        setError("Dieser Browser unterstützt kein Web Push.");
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();

      if (permission !== "granted") {
        setError("Mitteilungen wurden nicht erlaubt — Push bleibt aus.");
        return;
      }

      const keyed = await api<{ publicKey: string }>(
        "/api/briefing/public-key",
      );

      if ("error" in keyed) {
        setError(keyed.error);
        return;
      }

      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          keyed.data.publicKey,
        ) as unknown as ArrayBuffer,
      });
      const saved = await api(
        "/api/briefing/subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub.toJSON()),
        },
      );

      if ("error" in saved) {
        setError(saved.error);
        return;
      }

      setMessage("Gerät registriert. Sende jetzt einen Test, um Push zu verifizieren.");
      onChanged();
    } catch {
      setError("Registrierung fehlgeschlagen — bitte erneut versuchen.");
    } finally {
      setBusy(null);
    }
  }

  async function unsubscribe(): Promise<void> {
    setBusy("unsub");
    setMessage(null);
    setError(null);

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const sub = await registration?.pushManager.getSubscription();
      const endpoint = sub?.endpoint ?? "";

      if (sub !== undefined && sub !== null) {
        await sub.unsubscribe();
      }

      if (endpoint !== "") {
        const removed = await api(
          `/api/briefing/subscriptions?endpoint=${encodeURIComponent(endpoint)}`,
          { method: "DELETE" },
        );

        if ("error" in removed) {
          setError(removed.error);
          return;
        }
      }

      setTest(null);
      setMessage("Push für dieses Gerät deaktiviert.");
      onChanged();
    } catch {
      setError("Abmeldung fehlgeschlagen — bitte erneut versuchen.");
    } finally {
      setBusy(null);
    }
  }

  async function sendTest(): Promise<void> {
    setBusy("test");
    setMessage(null);
    setError(null);

    const result = await api<TestResult & { results: unknown }>(
      "/api/briefing/test",
      { method: "POST" },
    );

    setBusy(null);

    if ("error" in result) {
      setError(result.error);
      return;
    }

    setTest({
      delivered: result.data.delivered,
      total: result.data.total,
    });

    if (result.data.delivered > 0) {
      setMessage(
        `Test zugestellt an ${result.data.delivered}/${result.data.total} Geräte — prüfe dein Handy.`,
      );
    } else {
      setError(
        "Test wurde an kein Gerät zugestellt — Registrierung prüfen und erneut versuchen.",
      );
    }

    onChanged();
  }

  return (
    <div className={CARD}>
      <SectionTitle icon={<Bell size={16} />} title="Push aufs Handy" />
      <p className="mb-2 text-xs text-slate-500">
        Status:{" "}
        {subscriptions.length === 0 ? (
          <span className="text-slate-300">kein Gerät registriert</span>
        ) : verified ? (
          <span className="text-emerald-300">
            aktiv — Zustellung nachgewiesen
          </span>
        ) : (
          <span className="text-amber-200">
            registriert, aber noch nie nachgewiesen — Test senden
          </span>
        )}
      </p>

      {subscriptions.length > 0 && (
        <ul className="mb-2 space-y-1 text-xs text-slate-400">
          {subscriptions.map((sub) => (
            <li key={sub.id}>
              {sub.host === "" ? "Unbekannter Push-Dienst" : sub.host}
              {sub.lastUsedAt !== null
                ? ` — zuletzt zugestellt ${new Date(sub.lastUsedAt).toLocaleString("de-DE")}`
                : " — noch nie zugestellt"}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void subscribe()}
          disabled={busy !== null}
          className="rounded-xl border border-cyan-300/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100 transition hover:bg-cyan-400/20 disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-2">
            <Bell size={14} />
            {busy === "sub" ? "Wird aktiviert …" : "Dieses Gerät aktivieren"}
          </span>
        </button>
        <button
          onClick={() => void unsubscribe()}
          disabled={busy !== null}
          className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:bg-white/5 disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-2">
            <BellOff size={14} />
            {busy === "unsub" ? "Wird deaktiviert …" : "Deaktivieren"}
          </span>
        </button>
        <button
          onClick={() => void sendTest()}
          disabled={busy !== null || subscriptions.length === 0}
          className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:bg-white/5 disabled:opacity-50"
        >
          <span className="inline-flex items-center gap-2">
            <FlaskConical size={14} />
            {busy === "test" ? "Wird gesendet …" : "Test senden"}
          </span>
        </button>
      </div>

      {message !== null && (
        <p className="mt-2 text-sm text-emerald-300">{message}</p>
      )}
      {error !== null && (
        <p role="alert" className="mt-2 text-sm text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

function Gaps({ gaps }: { gaps: string[] }) {
  if (gaps.length === 0) return null;

  return (
    <div className={CARD}>
      <SectionTitle icon={<Sunrise size={16} />} title="Hinweise" />
      <ul className="space-y-1 text-xs text-slate-500">
        {gaps.map((gap, index) => (
          <li key={index}>• {gap}</li>
        ))}
      </ul>
    </div>
  );
}

function Shell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
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
              <h1 className="text-xl font-semibold">{title}</h1>
              <p className="text-sm text-slate-400">{subtitle}</p>
            </div>
          </header>
          <div className="mt-4 grid gap-3">{children}</div>
        </section>
      </div>
    </main>
  );
}

function CloudBriefingPage() {
  const [briefing, setBriefing] = useState<MorningBriefing | null>(null);
  const [settings, setSettings] = useState<BriefingSettings | null>(null);
  const [subscriptions, setSubscriptions] = useState<ServerSubscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    const [briefed, stored, subs] = await Promise.all([
      api<unknown>("/api/briefing"),
      api<unknown>("/api/briefing/settings"),
      api<unknown>("/api/briefing/subscriptions"),
    ]);

    if ("error" in briefed || !isBriefing(briefed.data)) {
      setError(
        "error" in briefed
          ? briefed.error
          : "Briefing konnte nicht geladen werden.",
      );
      setLoading(false);
      return;
    }

    setBriefing(briefed.data);

    if (!("error" in stored) && isBriefingSettings(stored.data)) {
      setSettings(stored.data);
    } else {
      setSettings({ ...DEFAULT_BRIEFING_SETTINGS });
    }

    if (!("error" in subs) && isServerSubscriptionList(subs.data)) {
      setSubscriptions(subs.data);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    // Mount-gated initial load (same pattern as other pages).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function saveSettings(next: BriefingSettings): Promise<void> {
    setSaving(true);
    setSaveError(null);

    const saved = await api<unknown>("/api/briefing/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });

    setSaving(false);

    if ("error" in saved || !isBriefingSettings(saved.data)) {
      setSaveError(
        "error" in saved ? saved.error : "Speichern fehlgeschlagen.",
      );
      return;
    }

    setSettings(saved.data);
  }

  const refreshSubs = useCallback(async () => {
    const subs = await api<unknown>("/api/briefing/subscriptions");

    if (!("error" in subs) && isServerSubscriptionList(subs.data)) {
      setSubscriptions(subs.data);
    }
  }, []);

  return (
    <Shell
      title="Morgen-Briefing"
      subtitle={
        briefing === null
          ? "Dein Tag auf einen Blick"
          : `Stand ${new Date(briefing.generatedAt).toLocaleString("de-DE")} · ${briefing.timezone}`
      }
    >
      {loading && (
        <p
          aria-live="polite"
          className="rounded-2xl border border-white/[0.08] bg-[#0d111b] px-4 py-3 text-sm text-slate-400"
        >
          Briefing wird zusammengestellt …
        </p>
      )}

      {error !== null && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-400/25 bg-rose-400/5 px-4 py-3 text-sm text-rose-200"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            onClick={() => void load()}
            className="rounded-xl border border-rose-300/30 px-3 py-1.5 text-xs transition hover:bg-rose-400/10"
          >
            Erneut versuchen
          </button>
        </div>
      )}

      {briefing !== null && (
        <>
          <BriefingSections briefing={briefing} />
          <Gaps gaps={briefing.gaps} />
        </>
      )}

      {settings !== null && (
        <SettingsForm
          key={`cloud-${JSON.stringify(settings)}`}
          initial={settings}
          showCity
          saving={saving}
          saveError={saveError}
          onSave={(next) => void saveSettings(next)}
        />
      )}

      <PushCard subscriptions={subscriptions} onChanged={() => void refreshSubs()} />
    </Shell>
  );
}

function LocalBriefingPage() {
  const tasksStore = useTasks([]);
  const eventsStore = useCalendarEvents();
  const studyStore = useStudy(EMPTY_STUDY);
  const quizStore = useQuiz();
  const financeStore = useFinance();
  const weather = useWeather();
  const [settings, setSettings, settingsLoaded] =
    useLocalStorage<BriefingSettings>(
      BRIEFING_SETTINGS_KEY,
      DEFAULT_BRIEFING_SETTINGS,
      isBriefingSettings,
    );
  const [news, setNews] = useState<NewsItem[] | null>(null);
  const [newsError, setNewsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadNews(): Promise<void> {
      const result = await api<{ items: unknown }>("/api/lifestyle/news");

      if (cancelled) return;

      if ("error" in result) {
        setNews(null);
        setNewsError(result.error);
        return;
      }

      const items = result.data.items;

      setNews(
        Array.isArray(items) && items.every(isNewsItem) ? items : [],
      );
      setNewsError(null);
    }

    void loadNews();

    return () => {
      cancelled = true;
    };
  }, []);

  const briefing = useMemo<MorningBriefing | null>(() => {
    if (!settingsLoaded) return null;

    const todayISO = localDateInTimezone(new Date(), settings.timezone);

    return composeBriefing({
      todayISO,
      generatedAt: new Date().toISOString(),
      timezone: settings.timezone,
      city: null,
      weatherReport: isWeatherReport(weather.report) ? weather.report : null,
      weatherError: weather.report === null ? weather.error : null,
      events: eventsStore.items,
      tasks: tasksStore.items,
      study: studyStore.data,
      questions: quizStore.items,
      newsItems: news,
      newsError,
      interests: settings.interests,
      finance: financeStore.data,
    });
  }, [
    settingsLoaded,
    settings,
    weather.report,
    weather.error,
    eventsStore.items,
    tasksStore.items,
    studyStore.data,
    quizStore.items,
    news,
    newsError,
    financeStore.data,
  ]);

  const loading =
    tasksStore.loading ||
    eventsStore.loading ||
    studyStore.loading ||
    quizStore.loading ||
    financeStore.loading ||
    weather.loading;

  return (
    <Shell
      title="Morgen-Briefing"
      subtitle="Lokaler Modus — Briefing nur auf diesem Gerät"
    >
      {loading && (
        <p
          aria-live="polite"
          className="rounded-2xl border border-white/[0.08] bg-[#0d111b] px-4 py-3 text-sm text-slate-400"
        >
          Briefing wird zusammengestellt …
        </p>
      )}

      {briefing !== null && (
        <>
          <BriefingSections briefing={briefing} />
          <Gaps gaps={briefing.gaps} />
        </>
      )}

      <SettingsForm
        key={settingsLoaded ? "local" : "local-loading"}
        initial={settings}
        showCity={false}
        saving={saving}
        saveError={null}
        onSave={(next) => {
          setSaving(true);
          setSettings({ ...next, city: null });
          setSaving(false);
        }}
      />

      <div className={CARD}>
        <SectionTitle icon={<Bell size={16} />} title="Push aufs Handy" />
        <p className="text-sm text-slate-400">
          Im lokalen Modus wird das Briefing nur hier angezeigt — Push und
          automatischer Versand brauchen die Cloud (Supabase + gehostetes
          Next.js + externer Cron). Nach dem Cloud-Setup erscheint hier die
          Geräte-Aktivierung. Wetterort folgt der Wetter-Seite (
          {weather.city.name || DEFAULT_CITY.name}).
        </p>
        <button
          onClick={() => {
            void tasksStore.refresh();
            void eventsStore.refresh();
            void studyStore.refresh();
            void quizStore.refresh();
            void financeStore.refresh();
            weather.retry();
          }}
          className="mt-2 rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:bg-white/5"
        >
          <span className="inline-flex items-center gap-2">
            <RefreshCw size={14} />
            Aktualisieren
          </span>
        </button>
      </div>
    </Shell>
  );
}

export default function BriefingPage() {
  if (CLOUD_ENABLED) return <CloudBriefingPage />;

  return <LocalBriefingPage />;
}
