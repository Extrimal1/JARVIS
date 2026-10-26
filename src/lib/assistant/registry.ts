/**
 * Assistant tool registry: the integration boundary for a future model.
 *
 * Each entry describes one read-only tool — its purpose, inputs, output,
 * and permission. A future AI adapter may only call tools listed here,
 * must validate inputs against the schema, and must never bypass the
 * tool functions in `./tools` (which re-validate everything).
 */

export type ToolPermission = "read" | "write";

export type ToolInputField = {
  name: string;
  /** JSON-ish type name for future model adapters. */
  type: string;
  required: boolean;
  description: string;
};

export type ToolDefinition = {
  id: string;
  title: string;
  description: string;
  permission: ToolPermission;
  inputs: ToolInputField[];
  /** Name of the TypeScript result type in `./tools`. */
  output: string;
  /** Storage keys the caller must load before invoking. */
  requiresKeys: string[];
};

const TODAY_FIELD: ToolInputField = {
  name: "todayISO",
  type: "string|null",
  required: true,
  description: "Heutiges Datum (YYYY-MM-DD, lokal) oder null vor dem Laden.",
};

export const ASSISTANT_TOOLS: ToolDefinition[] = [
  {
    id: "calendar.today",
    title: "Heutige Termine",
    description:
      "Liest die Kalendereinträge von heute, sortiert nach Startzeit.",
    permission: "read",
    inputs: [
      {
        name: "events",
        type: "CalendarEvent[]",
        required: true,
        description: "Validierte Kalenderdaten.",
      },
      TODAY_FIELD,
    ],
    output: "TodayEvents",
    requiresKeys: ["jarvis-calendar-events"],
  },
  {
    id: "calendar.upcoming",
    title: "Anstehende Termine",
    description: "Termine von heute bis N Tage voraus (Standard 7, max. 60).",
    permission: "read",
    inputs: [
      {
        name: "events",
        type: "CalendarEvent[]",
        required: true,
        description: "Validierte Kalenderdaten.",
      },
      TODAY_FIELD,
      {
        name: "days",
        type: "number?",
        required: false,
        description: "Zeitraum in Tagen (0–60).",
      },
    ],
    output: "UpcomingEvents",
    requiresKeys: ["jarvis-calendar-events"],
  },
  {
    id: "tasks.open",
    title: "Offene Aufgaben",
    description:
      "Unerledigte Aufgaben nach Priorität, plus zeitlich überfällige (Dashboard-Aufgaben gelten als Tagesliste).",
    permission: "read",
    inputs: [
      {
        name: "tasks",
        type: "Task[]",
        required: true,
        description: "Validierte Aufgabenliste.",
      },
      {
        name: "nowTime",
        type: "string|null",
        required: true,
        description: "Aktuelle Uhrzeit (HH:MM) oder null.",
      },
    ],
    output: "OpenTasks",
    requiresKeys: ["jarvis-tasks"],
  },
  {
    id: "study.deadlines",
    title: "Prüfungen & Fristen",
    description:
      "Prüfungen und offene Lernthemen mit gültigem Datum, überfällige zuerst.",
    permission: "read",
    inputs: [
      {
        name: "study",
        type: "StudyData",
        required: true,
        description: "Validierte Studiendaten.",
      },
      TODAY_FIELD,
    ],
    output: "StudyDeadlines",
    requiresKeys: ["jarvis-study"],
  },
  {
    id: "study.progress",
    title: "Lernfortschritt",
    description:
      "Anzahlen zu Fächern, Prüfungen und Themen plus Erledigungsquote.",
    permission: "read",
    inputs: [
      {
        name: "study",
        type: "StudyData",
        required: true,
        description: "Studiendaten; ungültige werden als leer gewertet.",
      },
      TODAY_FIELD,
    ],
    output: "StudyProgress",
    requiresKeys: ["jarvis-study"],
  },
  {
    id: "study.attention",
    title: "Prüfungen mit offenen Themen",
    description:
      "Anstehende Prüfungen (Standard 14 Tage), zu denen noch Themen offen sind.",
    permission: "read",
    inputs: [
      {
        name: "study",
        type: "StudyData",
        required: true,
        description: "Validierte Studiendaten.",
      },
      TODAY_FIELD,
      {
        name: "withinDays",
        type: "number?",
        required: false,
        description: "Zeitraum in Tagen (0–90).",
      },
    ],
    output: "ExamAttention[]",
    requiresKeys: ["jarvis-study"],
  },
  {
    id: "finance.monthSummary",
    title: "Monatsübersicht Finanzen",
    description:
      "Bestätigte Euro-Buchungen eines Monats (YYYY-MM) mit Budgets. Fremdwährungen werden gezählt, aber nicht umgerechnet.",
    permission: "read",
    inputs: [
      {
        name: "finance",
        type: "FinanceData",
        required: true,
        description: "Finanzdaten; ungültige werden als leer gewertet.",
      },
      {
        name: "monthKey",
        type: "string",
        required: true,
        description: "Monat als YYYY-MM.",
      },
    ],
    output: "FinanceMonthSummary",
    requiresKeys: ["jarvis-finance"],
  },
  {
    id: "finance.largest",
    title: "Größte Buchungen",
    description:
      "Größte bestätigte Euro-Buchungen eines Monats (ohne Notizen, ohne Kontodaten).",
    permission: "read",
    inputs: [
      {
        name: "finance",
        type: "FinanceData",
        required: true,
        description: "Validierte Finanzdaten.",
      },
      {
        name: "monthKey",
        type: "string",
        required: true,
        description: "Monat als YYYY-MM.",
      },
      {
        name: "limit",
        type: "number?",
        required: false,
        description: "Max. Anzahl (1–20, Standard 5).",
      },
    ],
    output: "LargestTransaction[]",
    requiresKeys: ["jarvis-finance"],
  },
  {
    id: "lifestyle.preferences",
    title: "Freizeit-Vorlieben",
    description:
      "Gespeicherte Freizeit-Vorlieben (Stadt, Budget, Filter). Nur Opt-in-Daten.",
    permission: "read",
    inputs: [
      {
        name: "preferences",
        type: "LifestylePreferences",
        required: true,
        description: "Validierte Vorlieben.",
      },
    ],
    output: "LifestylePrefs",
    requiresKeys: ["jarvis-lifestyle-prefs"],
  },
  {
    id: "lifestyle.saved",
    title: "Gemerke Orte",
    description:
      "Gemerke Orte mit Details. Enthält nur gespeicherte Koordinaten.",
    permission: "read",
    inputs: [
      {
        name: "places",
        type: "Place[]",
        required: true,
        description: "Validierte Orte.",
      },
      {
        name: "savedIds",
        type: "string[]",
        required: true,
        description: "Gemerke IDs (nicht mehr vorhandene werden gemeldet).",
      },
    ],
    output: "SavedPlaces",
    requiresKeys: ["jarvis-lifestyle-places", "jarvis-lifestyle-saved"],
  },
  {
    id: "lifestyle.upcomingPlans",
    title: "Anstehende Ausflüge",
    description: "Ausflugspläne von heute an, chronologisch sortiert.",
    permission: "read",
    inputs: [
      {
        name: "plans",
        type: "OutingPlan[]",
        required: true,
        description: "Validierte Ausflugspläne.",
      },
      TODAY_FIELD,
    ],
    output: "UpcomingPlans",
    requiresKeys: ["jarvis-lifestyle-plans"],
  },
  {
    id: "memory.approved",
    title: "Freigegebene Erinnerungen",
    description:
      "Nutzer-Einträge plus freigegebene abgeleitete Einträge. Entwürfe, archivierte und abgelaufene Einträge werden nie geliefert.",
    permission: "read",
    inputs: [
      {
        name: "memory",
        type: "MemoryEntry[]",
        required: true,
        description: "Validierte Memory-Einträge.",
      },
      TODAY_FIELD,
    ],
    output: "ApprovedMemory",
    requiresKeys: ["jarvis-memory"],
  },
];

/** Registry lookup; returns null for unknown ids (never throws). */
export function getToolDefinition(id: string): ToolDefinition | null {
  return ASSISTANT_TOOLS.find((tool) => tool.id === id) ?? null;
}

/** True only for tools the caller is allowed to invoke. */
export function mayInvoke(toolId: string, granted: ToolPermission[]): boolean {
  const tool = getToolDefinition(toolId);

  if (tool === null) return false;

  return granted.includes(tool.permission);
}
