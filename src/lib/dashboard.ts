import type { CalendarEvent } from "@/src/lib/calendar";
import type { FinanceData } from "@/src/lib/finance";
import type { QuizQuestion } from "@/src/lib/quiz";
import type { Deadline } from "@/src/lib/briefing";
import type { Task } from "@/src/lib/tasks";

/**
 * Dashboard notifications derived ONLY from real loaded data. Each
 * notification links to the module that owns the underlying record —
 * nothing is fabricated, and an empty inbox is a valid state.
 */

export type NotificationSeverity = "alert" | "warning" | "info";

export type DashboardNotification = {
  id: string;
  severity: NotificationSeverity;
  title: string;
  detail: string;
  href: string;
};

export function isQuizDue(
  question: QuizQuestion,
  todayISO: string,
): boolean {
  if (question.reviewStatus === "mastered") return false;

  const next = question.nextReviewAt ?? null;

  // Absent/nextReviewAt null = due now (never reviewed or unscheduled).
  if (next === null || next === undefined || next === "") return true;

  return next <= todayISO;
}

export function dueReviews(
  questions: QuizQuestion[],
  todayISO: string,
): QuizQuestion[] {
  return questions.filter((question) => isQuizDue(question, todayISO));
}

export function buildNotifications(input: {
  todayISO: string;
  tasks: Task[];
  events: CalendarEvent[];
  deadlines: Deadline[];
  finance: FinanceData;
  financeExpenseCents: number;
  questions: QuizQuestion[];
  loaded: {
    tasks: boolean;
    events: boolean;
    study: boolean;
    finance: boolean;
    quiz: boolean;
  };
}): DashboardNotification[] {
  const notifications: DashboardNotification[] = [];

  if (input.loaded.tasks) {
    // The task model carries a free-form time field (no dates), so
    // "overdue" is unknowable — high-priority open tasks are the
    // honest urgency signal. Never guess dates.
    const urgent = input.tasks.filter(
      (task) => !task.done && task.priority === "Hoch",
    );

    if (urgent.length > 0) {
      notifications.push({
        id: "tasks-urgent",
        severity: "warning",
        title: `${urgent.length} dringende ${urgent.length === 1 ? "Aufgabe" : "Aufgaben"}`,
        detail:
          urgent
            .slice(0, 2)
            .map((task) => task.title)
            .join(" · ") + (urgent.length > 2 ? " · …" : ""),
        href: "/#aufgaben",
      });
    }

  }

  if (input.loaded.events) {
    const todayCount = input.events.filter(
      (event) => event.date === input.todayISO,
    ).length;

    if (todayCount > 0) {
      notifications.push({
        id: "events-today",
        severity: "info",
        title: `${todayCount} ${todayCount === 1 ? "Termin" : "Termine"} heute`,
        detail: "Tagesübersicht im Terminplaner prüfen.",
        href: "/calendar",
      });
    }
  }

  if (input.loaded.study) {
    const soon = input.deadlines.filter(
      (deadline) => deadline.daysLeft >= 0 && deadline.daysLeft <= 7,
    );

    for (const deadline of soon.slice(0, 3)) {
      notifications.push({
        id: `deadline-${deadline.id}`,
        severity: deadline.daysLeft <= 1 ? "alert" : "warning",
        title: `${deadline.kind === "exam" ? "Prüfung" : "Frist"}: ${deadline.title}`,
        detail:
          deadline.daysLeft === 0
            ? "Heute fällig."
            : deadline.daysLeft === 1
              ? "Morgen fällig."
              : `In ${deadline.daysLeft} Tagen fällig.`,
        href: "/study?tab=prep&prep=overview",
      });
    }
  }

  if (input.loaded.finance) {
    const budget = input.finance.monthlyBudgetCents;

    if (budget > 0 && input.financeExpenseCents > budget) {
      notifications.push({
        id: "finance-budget",
        severity: "alert",
        title: "Monatsbudget überschritten",
        detail: "Ausgaben im Finanzbereich prüfen.",
        href: "/finance",
      });
    }
  }

  if (input.loaded.quiz) {
    const due = dueReviews(input.questions, input.todayISO);

    if (due.length > 0) {
      notifications.push({
        id: "quiz-due",
        severity: "info",
        title: `${due.length} ${due.length === 1 ? "Wiederholung" : "Wiederholungen"} fällig`,
        detail: "Offene Karteikarten in der Prüfungsvorbereitung.",
        href: "/study?tab=prep&prep=progress",
      });
    }
  }

  return notifications;
}
