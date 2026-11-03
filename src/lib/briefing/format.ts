import { formatDaysLeft } from "@/src/lib/briefing";
import { describeCode } from "@/src/lib/weather";
import { summarizeBriefing, type MorningBriefing } from "./compose";

/**
 * Briefing rendering: Web Push payload (short, truncated) and full
 * plain text (settings page preview, fallback). Pure functions.
 */

export const PUSH_TITLE_LIMIT = 64;
export const PUSH_BODY_LIMIT = 1000;
export const PUSH_URL = "/briefing";

export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
  date: string;
};

export function truncate(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();

  if (clean.length <= limit) return clean;

  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function weekdayLabel(dateISO: string): string {
  const parsed = new Date(`${dateISO}T12:00:00Z`);

  if (Number.isNaN(parsed.getTime())) return dateISO;

  return new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(parsed);
}

/** Short push notification: title + top lines, truncated to limits. */
export function toPushPayload(briefing: MorningBriefing): PushPayload {
  const lines = summarizeBriefing(briefing);
  const head = lines.slice(0, 4).join("\n");

  return {
    title: truncate(
      `Guten Morgen — ${weekdayLabel(briefing.dateISO)}`,
      PUSH_TITLE_LIMIT,
    ),
    body: truncate(
      head === "" ? "Dein Morgen-Briefing ist da." : head,
      PUSH_BODY_LIMIT,
    ),
    url: PUSH_URL,
    tag: `morning-briefing-${briefing.dateISO}`,
    date: briefing.dateISO,
  };
}

/** Full plain-text briefing (preview + fallback channel). */
export function toText(briefing: MorningBriefing): string {
  const out: string[] = [
    `Morgen-Briefing — ${weekdayLabel(briefing.dateISO)}`,
    "",
  ];

  out.push("WETTER");

  if (briefing.weather.report !== null) {
    const now = briefing.weather.report.now;
    const condition = describeCode(now.code);

    out.push(
      `${briefing.weather.city.name}: ${condition.label}, ${now.temperature} °C (Tiefst ${now.low} °/Höchst ${now.high} °, gefühlt ${now.feelsLike} °C).`,
    );
  } else {
    out.push(briefing.weather.unavailableReason ?? "Keine Wetterdaten.");
  }

  out.push("", "HEUTE IM KALENDER");

  if (briefing.events.events.length === 0) {
    out.push("Keine Termine.");
  } else {
    for (const event of briefing.events.events) {
      out.push(
        `${event.start}–${event.end}: ${event.title}${event.location === "" ? "" : ` (${event.location})`}`,
      );
    }
  }

  out.push("", "AUFGABEN");

  if (briefing.tasks.tasks.length === 0) {
    out.push("Keine offenen Aufgaben.");
  } else {
    for (const task of briefing.tasks.tasks) {
      out.push(`[${task.priority}] ${task.title} (${task.time})`);
    }

    if (briefing.tasks.totalOpen > briefing.tasks.tasks.length) {
      out.push(
        `… und ${briefing.tasks.totalOpen - briefing.tasks.tasks.length} weitere.`,
      );
    }
  }

  out.push("", "PRÜFUNGEN & THEMEN");

  if (briefing.deadlines.deadlines.length === 0) {
    out.push("Keine Termine mit Datum.");
  } else {
    for (const deadline of briefing.deadlines.deadlines) {
      out.push(
        `${deadline.title}: ${formatDaysLeft(deadline.daysLeft)} (${deadline.date})`,
      );
    }

    if (briefing.deadlines.total > briefing.deadlines.deadlines.length) {
      out.push(
        `… und ${briefing.deadlines.total - briefing.deadlines.deadlines.length} weitere.`,
      );
    }
  }

  out.push("", "WIEDERHOLUNGEN");

  if (briefing.reviews.totalQuestions === 0) {
    out.push("Keine Karten vorhanden.");
  } else if (briefing.reviews.dueCount === 0) {
    out.push("Heute nichts fällig.");
  } else {
    out.push(
      `${briefing.reviews.dueCount} fällig${briefing.reviews.overdueCount > 0 ? ` (${briefing.reviews.overdueCount} überfällig)` : ""}:`,
    );

    for (const sample of briefing.reviews.sample) {
      out.push(
        `• ${sample.question}${sample.subject === "" ? "" : ` [${sample.subject}]`} (fällig ${sample.dueISO})`,
      );
    }
  }

  out.push("", "NACHRICHTEN");

  if (briefing.news.unavailableReason !== null) {
    out.push(briefing.news.unavailableReason);
  } else if (briefing.news.items.length === 0) {
    out.push("Keine Meldungen.");
  } else {
    for (const item of briefing.news.items) {
      out.push(`• ${item.title} (${item.feedLabel})`);
    }
  }

  out.push("", "FINANZEN");

  if (briefing.finance.reminders.length === 0) {
    out.push("Keine Auffälligkeiten.");
  } else {
    for (const reminder of briefing.finance.reminders) {
      out.push(`• ${reminder.text}`);
    }
  }

  out.push("", "EMPFEHLUNG");

  if (briefing.recommendation === null) {
    out.push("Keine Datengrundlage — keine Empfehlung möglich.");
  } else {
    out.push(briefing.recommendation.title);
    out.push(briefing.recommendation.detail);
    out.push(briefing.recommendation.source);
  }

  return out.join("\n");
}
