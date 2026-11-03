import { crudHandlers } from "@/src/lib/api/crud";
import { calendarConfig } from "@/src/lib/api/modules/calendar";
import { getFinanceDoc } from "@/src/lib/api/modules/finance";
import { quizConfig } from "@/src/lib/api/modules/quiz";
import {
  studyConfig,
  type StudyRow,
} from "@/src/lib/api/modules/study";
import { tasksConfig } from "@/src/lib/api/modules/tasks";
import type { BriefingInput } from "@/src/lib/briefing/compose";
import {
  DEFAULT_BRIEFING_SETTINGS,
  isBriefingSettings,
  localDateInTimezone,
  type BriefingSettings,
} from "@/src/lib/briefing/schedule";
import {
  isCalendarEventList,
  type CalendarEvent,
} from "@/src/lib/calendar";
import { getNews } from "@/src/lib/lifestyle/newsProvider";
import type { NewsItem } from "@/src/lib/lifestyle/news";
import { isQuizQuestionList, type QuizQuestion } from "@/src/lib/quiz";
import { EMPTY_STUDY, type StudyData } from "@/src/lib/study";
import { isTaskList, type Task } from "@/src/lib/tasks";
import {
  DEFAULT_CITY,
  isWeatherCity,
  type WeatherReport,
} from "@/src/lib/weather";
import { weatherForCity } from "@/src/lib/weatherProvider";
import {
  dbFor,
  dbList,
  type DbClient,
} from "@/src/lib/supabase/db";
import type { SupabaseEnv } from "@/src/lib/supabase/supabase";

/**
 * Server-side briefing data (SERVER-ONLY). Loads one user's real data
 * for composition: tasks, calendar, study, quiz reviews, finance,
 * weather, and news. DB failures throw (no user data = no briefing);
 * weather/news failures degrade to honest gaps instead.
 */

export function serviceEnv(): SupabaseEnv | null {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SECRET_KEY ?? "";

  if (url === "" || key === "") return null;

  return { url, anonKey: key };
}

/** Service-role client scoped to one user (RLS bypassed, user_id forced). */
export function serviceDbFor(userId: string): DbClient | null {
  const env = serviceEnv();

  return env === null ? null : dbFor(env, env.anonKey, userId);
}

export type StoredBriefingSettings = {
  settings: BriefingSettings;
  lastSentDate: string | null;
};

export function rowToSettings(
  row: Record<string, unknown>,
): StoredBriefingSettings {
  const candidate: BriefingSettings = {
    enabled: row.enabled !== false,
    time: typeof row.time === "string" ? row.time : "07:30",
    timezone:
      typeof row.timezone === "string" ? row.timezone : "Europe/Berlin",
    city: isWeatherCity(row.city) ? row.city : null,
    interests: typeof row.interests === "string" ? row.interests : "",
  };

  return {
    settings: isBriefingSettings(candidate)
      ? candidate
      : { ...DEFAULT_BRIEFING_SETTINGS },
    lastSentDate:
      typeof row.last_sent_date === "string" ? row.last_sent_date : null,
  };
}

export async function loadBriefingSettings(
  db: DbClient,
): Promise<StoredBriefingSettings> {
  const rows = await dbList<Record<string, unknown>>(db, "briefing_settings", {
    limit: 1,
  });

  if (rows[0] === undefined) {
    return { settings: { ...DEFAULT_BRIEFING_SETTINGS }, lastSentDate: null };
  }

  return rowToSettings(rows[0]);
}

async function listOrThrow<T>(
  label: string,
  run: () => Promise<{ ok: boolean; data?: unknown; message?: string }>,
  isValid: (value: unknown) => value is T[],
): Promise<T[]> {
  const outcome = await run();

  if (!outcome.ok) {
    throw new Error(`briefing: ${label} unavailable`);
  }

  const data: unknown = (outcome as { data?: unknown }).data;

  return isValid(data) ? data : [];
}

export async function loadBriefingInput(
  db: DbClient,
  stored: StoredBriefingSettings,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<BriefingInput> {
  const todayISO = localDateInTimezone(now, stored.settings.timezone);

  const tasksHandlers = crudHandlers(tasksConfig);
  const calendarHandlers = crudHandlers(calendarConfig);
  const studyHandlers = crudHandlers(studyConfig);
  const quizHandlers = crudHandlers(quizConfig);

  const [tasks, events, studyRows, questions, finance] = await Promise.all([
    listOrThrow<Task>("tasks", () => tasksHandlers.list(db), isTaskList),
    listOrThrow<CalendarEvent>(
      "calendar",
      () => calendarHandlers.list(db),
      isCalendarEventList,
    ),
    (async (): Promise<StudyData> => {
      const outcome = await studyHandlers.list(db);

      if (!outcome.ok) throw new Error("briefing: study unavailable");

      const rows = (outcome as { data?: unknown }).data;
      const doc: StudyData = { ...EMPTY_STUDY, subjects: [], exams: [], topics: [], materials: [] };

      if (!Array.isArray(rows)) return doc;

      for (const row of rows as StudyRow[]) {
        if (
          row.section === "subjects" ||
          row.section === "exams" ||
          row.section === "topics" ||
          row.section === "materials"
        ) {
          const { section, ...entry } = row;
          void section;
          doc[row.section].push(entry);
        }
      }

      return doc;
    })(),
    listOrThrow<QuizQuestion>(
      "quiz",
      () => quizHandlers.list(db),
      isQuizQuestionList,
    ),
    getFinanceDoc(db),
  ]);

  const city = stored.settings.city ?? DEFAULT_CITY;

  const [weather, news] = await Promise.all([
    (async (): Promise<{
      report: WeatherReport | null;
      error: string | null;
    }> => {
      try {
        return { report: await weatherForCity(city, fetchImpl), error: null };
      } catch (error) {
        return {
          report: null,
          error:
            error instanceof Error
              ? error.message
              : "Wetterdaten konnten nicht geladen werden.",
        };
      }
    })(),
    (async (): Promise<{
      items: NewsItem[] | null;
      error: string | null;
    }> => {
      try {
        const payload = await getNews(fetchImpl);

        return { items: payload.items, error: null };
      } catch {
        return {
          items: null,
          error: "Nachrichten konnten nicht geladen werden.",
        };
      }
    })(),
  ]);

  return {
    todayISO,
    generatedAt: now.toISOString(),
    timezone: stored.settings.timezone,
    city: stored.settings.city,
    weatherReport: weather.report,
    weatherError: weather.error,
    events,
    tasks,
    study: studyRows,
    questions,
    newsItems: news.items,
    newsError: news.error,
    interests: stored.settings.interests,
    finance,
  };
}
