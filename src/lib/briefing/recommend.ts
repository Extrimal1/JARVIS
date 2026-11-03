import type { Deadline } from "@/src/lib/briefing";
import type { CalendarEvent } from "@/src/lib/calendar";
import type { Task } from "@/src/lib/tasks";
import { describeCode } from "@/src/lib/weather";

/**
 * The one grounded daily recommendation. Deterministic and rule-based:
 * every candidate is derived from real briefing data and carries the
 * exact source it was grounded in — nothing is ever invented. Priority
 * order: overdue deadlines → imminent exam → due reviews → today's
 * first event → budget overrun → bad weather → top task.
 */

export type DueReviewSample = {
  subject: string;
  question: string;
  dueISO: string;
  daysOverdue: number;
};

export type FinanceFlag = {
  kind: "budget-exceeded" | "budget-near" | "category-exceeded";
  label: string;
  /** 0..1+ usage ratio when known. */
  usage: number | null;
};

export type RecommendationInput = {
  deadlines: Deadline[];
  dueReviewCount: number;
  dueReviewSample: DueReviewSample[];
  todaysEvents: CalendarEvent[];
  openTasks: Task[];
  financeFlags: FinanceFlag[];
  weatherCode: number | null;
  weatherHigh: number | null;
};

export type Recommendation = {
  title: string;
  detail: string;
  /** Exact data the recommendation was grounded in. */
  source: string;
};

function firstLine(value: string, max = 90): string {
  const line = value.replace(/\s+/g, " ").trim();

  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export function pickRecommendation(
  input: RecommendationInput,
): Recommendation | null {
  const overdue = input.deadlines.find(
    (deadline) => deadline.daysLeft < 0,
  );

  if (overdue !== undefined) {
    const days = -overdue.daysLeft;

    return {
      title: `Heute nachholen: ${firstLine(overdue.title)}`,
      detail:
        `${overdue.kind === "exam" ? "Die Prüfung" : "Das Thema"}` +
        ` ist seit ${days === 1 ? "gestern" : `${days} Tagen`} überfällig — blocke heute die erste freie Stunde dafür.`,
      source: `Quelle: ${overdue.kind === "exam" ? "Prüfung" : "Lernthema"} „${overdue.title}“ (fällig ${overdue.date})`,
    };
  }

  const nextExam = input.deadlines.find(
    (deadline) => deadline.kind === "exam" && deadline.daysLeft <= 7,
  );

  if (nextExam !== undefined) {
    const when =
      nextExam.daysLeft === 0
        ? "heute"
        : nextExam.daysLeft === 1
          ? "morgen"
          : `in ${nextExam.daysLeft} Tagen`;

    return {
      title: `Prüfungsfokus: ${firstLine(nextExam.title)}`,
      detail: `Die Prüfung ist ${when} (${nextExam.date}). Plane heute eine Lerneinheit ein und wiederhole zuerst die fälligen Karten dazu.`,
      source: `Quelle: Prüfung „${nextExam.title}“ am ${nextExam.date}`,
    };
  }

  if (input.dueReviewCount > 0) {
    const oldest = input.dueReviewSample[0];
    const sample =
      oldest === undefined
        ? ""
        : ` Älteste fällige Karte: „${firstLine(oldest.question, 70)}“${oldest.subject === "" ? "" : ` (${firstLine(oldest.subject, 30)})`}.`;

    return {
      title:
        input.dueReviewCount === 1
          ? "1 Wiederholung ist fällig"
          : `${input.dueReviewCount} Wiederholungen sind fällig`,
      detail: `Starte den Tag mit einer kurzen Wiederholungsrunde, bevor neue Themen dazukommen.${sample}`,
      source:
        oldest === undefined
          ? `Quelle: ${input.dueReviewCount} fällige Wiederholungskarten`
          : `Quelle: fällige Karte „${firstLine(oldest.question, 60)}“ (fällig ${oldest.dueISO})`,
    };
  }

  const firstEvent = [...input.todaysEvents].sort((a, b) =>
    a.start.localeCompare(b.start),
  )[0];

  if (firstEvent !== undefined) {
    return {
      title: `Tag startet um ${firstEvent.start}: ${firstLine(firstEvent.title)}`,
      detail: `Bereite ${firstEvent.start} Uhr vor — ${firstLine(firstEvent.title)}${firstEvent.location === "" ? "" : ` (${firstLine(firstEvent.location, 40)})`} dauert bis ${firstEvent.end}. Lege alles Nötige heute früh bereit.`,
      source: `Quelle: Termin „${firstEvent.title}“ heute ${firstEvent.start}–${firstEvent.end}`,
    };
  }

  const exceeded = input.financeFlags.find(
    (flag) => flag.kind === "budget-exceeded" || flag.kind === "category-exceeded",
  );

  if (exceeded !== undefined) {
    return {
      title: `Budget-Achtung: ${firstLine(exceeded.label, 60)}`,
      detail:
        "Dein Budget ist überschritten. Prüfe heute die letzten Ausgaben und plane große Käufe erst nach dem Monatswechsel.",
      source: `Quelle: ${exceeded.label}`,
    };
  }

  if (input.weatherCode !== null) {
    const condition = describeCode(input.weatherCode);

    if (
      condition.kind === "rain" ||
      condition.kind === "storm" ||
      condition.kind === "snow"
    ) {
      return {
        title: `${condition.label} heute — plane drinnen`,
        detail: `Es wird ${condition.label.toLowerCase()}${input.weatherHigh === null ? "" : ` bei bis zu ${input.weatherHigh} °C`}. Lege Outdoor-Termine um oder nimm wetterfeste Kleidung mit.`,
        source: `Quelle: Wettervorhersage (${condition.label})`,
      };
    }
  }

  const topTask = input.openTasks.find(
    (task) => task.priority === "Hoch",
  );

  if (topTask !== undefined) {
    return {
      title: `Wichtigste Aufgabe: ${firstLine(topTask.title)}`,
      detail: "Erledige die wichtigste offene Aufgabe zuerst — alles andere ist heute zweitrangig.",
      source: `Quelle: Aufgabe „${topTask.title}“ (Priorität Hoch)`,
    };
  }

  const nextDeadline = input.deadlines.find(
    (deadline) => deadline.daysLeft >= 0,
  );

  if (nextDeadline !== undefined) {
    return {
      title: `Vorausplanen: ${firstLine(nextDeadline.title)}`,
      detail: `Nächster Termin dieser Art ist am ${nextDeadline.date} — ein kleiner Schritt heute nimmt Druck aus der Woche.`,
      source: `Quelle: ${nextDeadline.kind === "exam" ? "Prüfung" : "Lernthema"} „${nextDeadline.title}“ am ${nextDeadline.date}`,
    };
  }

  const anyTask = input.openTasks[0];

  if (anyTask !== undefined) {
    return {
      title: `Klein anfangen: ${firstLine(anyTask.title)}`,
      detail: "Keine Termine, keine Fälligkeiten — nutze den ruhigen Tag für eine offene Aufgabe.",
      source: `Quelle: Aufgabe „${anyTask.title}“`,
    };
  }

  return null;
}
