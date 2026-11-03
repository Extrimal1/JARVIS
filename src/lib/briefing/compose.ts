import {
  collectDeadlines,
  formatDaysLeft,
  openTasks,
  type Deadline,
} from "@/src/lib/briefing";
import type { CalendarEvent } from "@/src/lib/calendar";
import {
  formatCents,
  type FinanceData,
  type Transaction,
} from "@/src/lib/finance";
import type { NewsItem } from "@/src/lib/lifestyle/news";
import { filterNewsByInterests } from "@/src/lib/lifestyle/news";
import { getQuizReviewInfo } from "@/src/lib/quizReview";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { StudyData } from "@/src/lib/study";
import type { Task } from "@/src/lib/tasks";
import {
  DEFAULT_CITY,
  describeCode,
  type WeatherCity,
  type WeatherReport,
} from "@/src/lib/weather";
import {
  pickRecommendation,
  type DueReviewSample,
  type FinanceFlag,
  type Recommendation,
} from "./recommend";

/**
 * Morning Briefing composition. Pure: every section is derived from
 * real caller-provided data only. Unavailable or empty sources yield
 * honest empty states collected in `gaps` — nothing is ever invented.
 */

export const BRIEFING_NEWS_LIMIT = 5;
export const BRIEFING_TASKS_LIMIT = 8;
export const BRIEFING_DEADLINES_LIMIT = 10;
export const BRIEFING_REVIEWS_SAMPLE = 5;

export type WeatherSection = {
  available: boolean;
  city: WeatherCity;
  /** Null when the provider failed; see `unavailableReason`. */
  report: WeatherReport | null;
  unavailableReason: string | null;
  /** True when the default city was used (no city configured). */
  usedDefaultCity: boolean;
};

export type EventsSection = {
  events: CalendarEvent[];
};

export type TasksSection = {
  tasks: Task[];
  /** Total open tasks (list may be truncated to the limit). */
  totalOpen: number;
};

export type DeadlinesSection = {
  deadlines: Deadline[];
  total: number;
};

export type ReviewsSection = {
  /** All questions due as of today (never-reviewed counts as due). */
  dueCount: number;
  overdueCount: number;
  sample: DueReviewSample[];
  totalQuestions: number;
};

export type NewsSection = {
  items: NewsItem[];
  unavailableReason: string | null;
};

export type FinanceReminder = {
  text: string;
  source: string;
};

export type FinanceSection = {
  reminders: FinanceReminder[];
  flags: FinanceFlag[];
};

export type MorningBriefing = {
  /** Local briefing date as YYYY-MM-DD. */
  dateISO: string;
  generatedAt: string;
  timezone: string;
  weather: WeatherSection;
  events: EventsSection;
  tasks: TasksSection;
  deadlines: DeadlinesSection;
  reviews: ReviewsSection;
  news: NewsSection;
  finance: FinanceSection;
  recommendation: Recommendation | null;
  /** Honest notes for empty/unavailable sections. */
  gaps: string[];
};

export type BriefingInput = {
  todayISO: string;
  generatedAt: string;
  timezone: string;
  city: WeatherCity | null;
  weatherReport: WeatherReport | null;
  weatherError: string | null;
  events: CalendarEvent[];
  tasks: Task[];
  study: StudyData;
  questions: QuizQuestion[];
  newsItems: NewsItem[] | null;
  newsError: string | null;
  interests: string;
  finance: FinanceData;
};

function monthOf(dateISO: string): string {
  return dateISO.length >= 7 ? dateISO.slice(0, 7) : "";
}

function financeReminders(
  finance: FinanceData,
  todayISO: string,
): { reminders: FinanceReminder[]; flags: FinanceFlag[] } {
  const reminders: FinanceReminder[] = [];
  const flags: FinanceFlag[] = [];
  const month = monthOf(todayISO);

  const monthTx: Transaction[] = finance.transactions.filter(
    (tx) => month !== "" && monthOf(tx.date) === month,
  );
  const expenses = monthTx
    .filter((tx) => tx.type === "expense")
    .reduce((sum, tx) => sum + tx.amount, 0);

  if (finance.monthlyBudgetCents > 0) {
    const usage = expenses / finance.monthlyBudgetCents;
    const label = `Monatsbudget: ${formatCents(expenses)} von ${formatCents(finance.monthlyBudgetCents)} (${Math.round(usage * 100)} %)`;

    if (usage >= 1) {
      reminders.push({
        text: `${label} — Budget überschritten.`,
        source: "Quelle: Monatsbudget vs. Ausgaben im laufenden Monat",
      });
      flags.push({ kind: "budget-exceeded", label, usage });
    } else if (usage >= 0.8) {
      reminders.push({
        text: `${label} — fast aufgebraucht.`,
        source: "Quelle: Monatsbudget vs. Ausgaben im laufenden Monat",
      });
      flags.push({ kind: "budget-near", label, usage });
    } else {
      reminders.push({
        text: `${label} ausgegeben.`,
        source: "Quelle: Monatsbudget vs. Ausgaben im laufenden Monat",
      });
    }
  }

  for (const [category, budget] of Object.entries(finance.categoryBudgets)) {
    if (budget <= 0) continue;

    const spent = monthTx
      .filter((tx) => tx.type === "expense" && tx.category === category)
      .reduce((sum, tx) => sum + tx.amount, 0);
    const usage = spent / budget;

    if (usage >= 1) {
      const label = `Kategorie „${category}“: ${formatCents(spent)} von ${formatCents(budget)}`;

      reminders.push({
        text: `${label} — überschritten.`,
        source: `Quelle: Kategoriebudget „${category}“`,
      });
      flags.push({ kind: "category-exceeded", label, usage });
    } else if (usage >= 0.8) {
      reminders.push({
        text: `Kategorie „${category}“: ${formatCents(spent)} von ${formatCents(budget)} — fast aufgebraucht.`,
        source: `Quelle: Kategoriebudget „${category}“`,
      });
    }
  }

  for (const goal of finance.goals) {
    if (goal.targetCents <= 0) continue;

    const ratio = goal.savedCents / goal.targetCents;

    if (ratio >= 1) {
      reminders.push({
        text: `Sparziel „${goal.title}“ erreicht (${formatCents(goal.savedCents)}).`,
        source: `Quelle: Sparziel „${goal.title}“`,
      });
    } else if (ratio >= 0.75) {
      reminders.push({
        text: `Sparziel „${goal.title}“: ${formatCents(goal.savedCents)} von ${formatCents(goal.targetCents)} — fast geschafft.`,
        source: `Quelle: Sparziel „${goal.title}“`,
      });
    }
  }

  return { reminders, flags };
}

export function composeBriefing(input: BriefingInput): MorningBriefing {
  const gaps: string[] = [];

  const city = input.weatherReport?.city ?? input.city ?? DEFAULT_CITY;
  const weather: WeatherSection = {
    available: input.weatherReport !== null,
    city,
    report: input.weatherReport,
    unavailableReason:
      input.weatherReport !== null
        ? null
        : (input.weatherError ?? "Wetterdaten konnten nicht geladen werden."),
    usedDefaultCity: input.city === null,
  };

  if (input.weatherReport === null) {
    gaps.push("Wetter: keine Daten — Abschnitt ausgelassen.");
  }

  if (input.city === null) {
    gaps.push("Wetter: kein Ort konfiguriert — Standardort Stuttgart.");
  }

  const events = [...input.events]
    .filter((event) => event.date === input.todayISO)
    .sort((a, b) => a.start.localeCompare(b.start));

  if (events.length === 0) {
    gaps.push("Kalender: heute keine Termine.");
  }

  const open = openTasks(input.tasks);
  const tasks: TasksSection = {
    tasks: open.slice(0, BRIEFING_TASKS_LIMIT),
    totalOpen: open.length,
  };

  if (open.length === 0) {
    gaps.push("Aufgaben: keine offenen Aufgaben.");
  }

  const allDeadlines = collectDeadlines(input.study, input.todayISO);
  const deadlines: DeadlinesSection = {
    deadlines: allDeadlines.slice(0, BRIEFING_DEADLINES_LIMIT),
    total: allDeadlines.length,
  };

  if (allDeadlines.length === 0) {
    gaps.push("Prüfungen & Themen: keine Termine mit Datum.");
  }

  const due: DueReviewSample[] = [];
  let overdueCount = 0;

  for (const question of input.questions) {
    const info = getQuizReviewInfo(question, input.todayISO);

    if (info.status === "later") continue;
    if (info.status === "overdue") overdueCount += 1;

    due.push({
      subject: question.subject,
      question: question.question,
      dueISO: info.dueISO,
      daysOverdue: info.daysLeft < 0 ? -info.daysLeft : 0,
    });
  }

  due.sort(
    (a, b) =>
      b.daysOverdue - a.daysOverdue || a.dueISO.localeCompare(b.dueISO),
  );

  const reviews: ReviewsSection = {
    dueCount: due.length,
    overdueCount,
    sample: due.slice(0, BRIEFING_REVIEWS_SAMPLE),
    totalQuestions: input.questions.length,
  };

  if (input.questions.length === 0) {
    gaps.push("Wiederholungen: keine Karten vorhanden.");
  } else if (due.length === 0) {
    gaps.push("Wiederholungen: heute nichts fällig.");
  }

  const news: NewsSection =
    input.newsItems === null
      ? {
          items: [],
          unavailableReason:
            input.newsError ?? "Nachrichten konnten nicht geladen werden.",
        }
      : {
          items: filterNewsByInterests(input.newsItems, input.interests).slice(
            0,
            BRIEFING_NEWS_LIMIT,
          ),
          unavailableReason: null,
        };

  if (input.newsItems === null) {
    gaps.push("Nachrichten: keine Daten — Abschnitt ausgelassen.");
  } else if (news.items.length === 0) {
    gaps.push(
      input.interests.trim() === ""
        ? "Nachrichten: keine Meldungen verfügbar."
        : "Nachrichten: keine Meldungen zu deinen Interessen.",
    );
  }

  const { reminders, flags } = financeReminders(input.finance, input.todayISO);
  const finance: FinanceSection = { reminders, flags };

  if (reminders.length === 0) {
    gaps.push(
      input.finance.transactions.length === 0 &&
        input.finance.monthlyBudgetCents === 0 &&
        Object.keys(input.finance.categoryBudgets).length === 0 &&
        input.finance.goals.length === 0
        ? "Finanzen: keine Daten vorhanden."
        : "Finanzen: keine Auffälligkeiten — alles im Budget.",
    );
  }

  const recommendation = pickRecommendation({
    deadlines: allDeadlines,
    dueReviewCount: due.length,
    dueReviewSample: due.slice(0, BRIEFING_REVIEWS_SAMPLE),
    todaysEvents: events,
    openTasks: open,
    financeFlags: flags,
    weatherCode: input.weatherReport?.now.code ?? null,
    weatherHigh: input.weatherReport?.now.high ?? null,
  });

  if (recommendation === null) {
    gaps.push("Empfehlung: keine Datengrundlage — keine Empfehlung möglich.");
  }

  return {
    dateISO: input.todayISO,
    generatedAt: input.generatedAt,
    timezone: input.timezone,
    weather,
    events: { events },
    tasks,
    deadlines,
    reviews,
    news,
    finance,
    recommendation,
    gaps,
  };
}

/** Short German summary line per section (used by UI + push fallback). */
export function summarizeBriefing(briefing: MorningBriefing): string[] {
  const lines: string[] = [];

  if (briefing.weather.report !== null) {
    const now = briefing.weather.report.now;
    const condition = describeCode(now.code);

    lines.push(
      `Wetter ${briefing.weather.city.name}: ${condition.label}, ${now.temperature} °C (${now.low}–${now.high} °C)`,
    );
  }

  if (briefing.events.events.length > 0) {
    const first = briefing.events.events[0]!;

    lines.push(
      briefing.events.events.length === 1
        ? `1 Termin: ${first.start} ${first.title}`
        : `${briefing.events.events.length} Termine, Start ${first.start} (${first.title})`,
    );
  }

  if (briefing.tasks.totalOpen > 0) {
    lines.push(
      `${briefing.tasks.totalOpen} offene Aufgaben (wichtigste: ${briefing.tasks.tasks[0]?.title ?? "–"})`,
    );
  }

  const next = briefing.deadlines.deadlines.find(
    (deadline) => deadline.daysLeft >= 0,
  );
  const overdueCount = briefing.deadlines.deadlines.filter(
    (deadline) => deadline.daysLeft < 0,
  ).length;

  if (overdueCount > 0) {
    lines.push(`${overdueCount} überfällige Prüfung(en)/Themen`);
  }

  if (next !== undefined) {
    lines.push(
      `Nächste Fälligkeit: ${next.title} (${formatDaysLeft(next.daysLeft)})`,
    );
  }

  if (briefing.reviews.dueCount > 0) {
    lines.push(`${briefing.reviews.dueCount} Wiederholungen fällig`);
  }

  if (briefing.news.items.length > 0) {
    lines.push(`Top-News: ${briefing.news.items[0]!.title}`);
  }

  for (const reminder of briefing.finance.reminders.slice(0, 2)) {
    lines.push(reminder.text);
  }

  if (briefing.recommendation !== null) {
    lines.push(`Empfehlung: ${briefing.recommendation.title}`);
  }

  return lines;
}
