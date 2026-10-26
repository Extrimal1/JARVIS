export type CalendarEventType = "lecture" | "exam" | "personal";

export type CalendarEvent = {
  id: number;
  title: string;
  /** Local date as YYYY-MM-DD. */
  date: string;
  /** 24h start time as HH:MM. */
  start: string;
  /** 24h end time as HH:MM. */
  end: string;
  type: CalendarEventType;
  description: string;
  location: string;
};

export const CALENDAR_STORAGE_KEY = "jarvis-calendar-events";

/** Shared empty initial value (never mutated; the storage hook replaces it). */
export const NO_EVENTS: CalendarEvent[] = [];

export const EVENT_TYPE_STYLES: Record<
  CalendarEventType,
  { label: string; dot: string; block: string; chip: string }
> = {
  lecture: {
    label: "Vorlesung",
    dot: "bg-cyan-300",
    block:
      "border-cyan-300 bg-cyan-300/15 text-cyan-100 hover:bg-cyan-300/25",
    chip: "border-cyan-300/40 bg-cyan-300/10 text-cyan-200",
  },
  exam: {
    label: "Prüfung",
    dot: "bg-rose-400",
    block: "border-rose-400 bg-rose-400/15 text-rose-100 hover:bg-rose-400/25",
    chip: "border-rose-400/40 bg-rose-400/10 text-rose-200",
  },
  personal: {
    label: "Persönlich",
    dot: "bg-emerald-400",
    block:
      "border-emerald-400 bg-emerald-400/15 text-emerald-100 hover:bg-emerald-400/25",
    chip: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  },
};

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function toISODateLocal(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function parseISODateLocal(value: string): Date | null {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

export function timeToMinutes(value: string): number | null {
  const match = TIME_PATTERN.exec(value);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

export function minutesToTime(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.floor(totalMinutes)));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

/** Monday (00:00 local) of the week containing the given date. */
export function startOfWeekMonday(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
}

export function weekLabel(weekStart: Date): string {
  const startFormat = new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "short",
  });
  const endFormat = new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${startFormat.format(weekStart)} – ${endFormat.format(addDays(weekStart, 6))}`;
}

export function isCalendarEvent(value: unknown): value is CalendarEvent {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.id === "number" &&
    typeof item.title === "string" &&
    typeof item.date === "string" &&
    parseISODateLocal(item.date) !== null &&
    typeof item.start === "string" &&
    timeToMinutes(item.start) !== null &&
    typeof item.end === "string" &&
    timeToMinutes(item.end) !== null &&
    (item.type === "lecture" ||
      item.type === "exam" ||
      item.type === "personal") &&
    typeof item.description === "string" &&
    typeof item.location === "string"
  );
}

export function isCalendarEventList(value: unknown): value is CalendarEvent[] {
  return Array.isArray(value) && value.every(isCalendarEvent);
}

/** Events on the same day whose [start, end) ranges intersect the candidate. */
export function findConflicts(
  events: CalendarEvent[],
  candidate: CalendarEvent,
): CalendarEvent[] {
  const candidateStart = timeToMinutes(candidate.start);
  const candidateEnd = timeToMinutes(candidate.end);
  if (candidateStart === null || candidateEnd === null) return [];

  return events.filter((event) => {
    if (event.id === candidate.id || event.date !== candidate.date) {
      return false;
    }

    const start = timeToMinutes(event.start);
    const end = timeToMinutes(event.end);
    if (start === null || end === null) return false;

    return candidateStart < end && start < candidateEnd;
  });
}

export type PositionedEvent = {
  event: CalendarEvent;
  column: number;
  columns: number;
};

/**
 * Greedy interval partitioning so overlapping events share the day width.
 * Non-overlapping clusters are laid out independently (full width).
 */
export function layoutDayEvents(dayEvents: CalendarEvent[]): PositionedEvent[] {
  const sorted = [...dayEvents].sort(
    (a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end),
  );
  const positioned: PositionedEvent[] = [];
  let cluster: PositionedEvent[] = [];
  let clusterEnd = -1;
  const columnEnds: number[] = [];

  function flushCluster() {
    const columns = Math.max(1, ...cluster.map((item) => item.column + 1));

    for (const item of cluster) {
      item.columns = columns;
    }

    cluster = [];
    clusterEnd = -1;
    columnEnds.length = 0;
  }

  for (const event of sorted) {
    const start = timeToMinutes(event.start) ?? 0;
    const end = timeToMinutes(event.end) ?? 0;

    if (cluster.length > 0 && start >= clusterEnd) {
      flushCluster();
    }

    let column = columnEnds.findIndex((columnEnd) => columnEnd <= start);

    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[column] = end;
    }

    const item: PositionedEvent = { event, column, columns: 1 };
    cluster.push(item);
    positioned.push(item);
    clusterEnd = Math.max(clusterEnd, end);
  }

  flushCluster();

  return positioned;
}
