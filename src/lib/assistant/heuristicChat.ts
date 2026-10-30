import { formatCents } from "@/src/lib/finance";
import {
  type AssistantLocale,
  type AssistantPlan,
  type NluContext,
} from "./actions";
import { isAgentLoopPrompt, type AgentChat, type AgentMessage } from "./agent";
import { parseCommand } from "./nlu";

/**
 * Heuristic chat transport: the explicit rule-based opt-in speaks the
 * same tool envelope as the LLM, so the agent loop, the conversation
 * service, and the shared UI work unchanged whichever engine the
 * server status reports. No silent substitution: the caller picks
 * this transport only when the provider is explicitly "heuristic".
 *
 * Mapping: action plans become `{"tool", "args"}` calls executed by
 * the loop; `clarify` becomes a final question with clickable
 * options; `unsupported` becomes a final help text. Follow-up
 * fragments ("morgen") re-parse against the previous user message
 * from the real history (replacing the old pending-base retry):
 * whenever the fragment alone yields no action, the combined text
 * wins unless it parses to nothing at all.
 *
 * After a tool executes, the next call sees the tool result as the
 * last message and answers with a deterministic German summary —
 * write reports reuse the executor message, read results are
 * formatted from real data (never raw JSON, never invented).
 * The loop's own repair prompts are never parsed as user input.
 */

export type HeuristicChatBase = {
  todayISO: string;
  nowTime: string;
  timezone: string;
  locale: AssistantLocale;
};

function detectLocale(text: string, fallback: AssistantLocale): AssistantLocale {
  return /[\u0400-\u04FF]/.test(text) ? "ru" : fallback;
}

function planToEnvelope(plan: AssistantPlan): string {
  if (plan.type === "clarify") {
    return JSON.stringify({
      final: plan.question,
      clarify: { options: plan.options },
    });
  }

  if (plan.type === "unsupported") {
    return JSON.stringify({ final: plan.message });
  }

  const { type, ...args } = plan;

  return JSON.stringify({ tool: type, args });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function dayMonth(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`
    : iso;
}

function bullets(lines: string[]): string {
  const shown = lines.slice(0, 10);
  const rest = lines.length - shown.length;

  return (
    shown.map((line) => `• ${line}`).join("\n") +
    (rest > 0 ? `\n…und ${rest} weitere.` : "")
  );
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function itemsOf(data: unknown, key: string): Record<string, unknown>[] {
  if (!isRecord(data)) return [];

  const list = data[key];

  if (!Array.isArray(list)) return [];

  return list.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry),
  );
}

/** Deterministic German summary of a read result (total, no throws). */
function summarizeRead(toolId: string | null, data: unknown): string {
  switch (toolId) {
    case "calendar.today":
    case "calendar.upcoming":
    case "calendar.list": {
      const events = itemsOf(data, "events");

      if (events.length === 0) return "Keine Termine gefunden.";

      return bullets(
        events.map(
          (event) =>
            `${str(event.title) || "Termin"} · ${dayMonth(str(event.date))} ${str(event.start)}–${str(event.end)}`,
        ),
      );
    }
    case "tasks.open": {
      const open = itemsOf(data, "open");
      const overdue = itemsOf(data, "overdue");

      if (open.length === 0) return "Keine offenen Aufgaben.";

      const lines = open.map(
        (task) => `${str(task.title) || "Aufgabe"} (${str(task.time)})`,
      );

      return overdue.length > 0
        ? `${bullets(lines)}\nDavon überfällig: ${overdue.length}.`
        : bullets(lines);
    }
    case "study.deadlines": {
      const deadlines = itemsOf(data, "deadlines");

      if (deadlines.length === 0) return "Keine Prüfungen oder Fristen.";

      return bullets(
        deadlines.map((deadline) => {
          const daysLeft = num(deadline.daysLeft);
          const when =
            daysLeft === null
              ? dayMonth(str(deadline.date))
              : daysLeft < 0
                ? `überfällig seit ${-daysLeft} Tagen`
                : `in ${daysLeft} Tagen`;

          return `${str(deadline.title) || "Frist"} (${when})`;
        }),
      );
    }
    case "study.progress": {
      if (!isRecord(data)) return "Kein Lernfortschritt verfügbar.";

      const done = num(data.topicsDone) ?? 0;
      const open = num(data.topicsOpen) ?? 0;
      const pct = num(data.completionPct);
      const exams = num(data.examsUpcoming) ?? 0;
      const examsTotal = num(data.examsTotal) ?? 0;

      return (
        `Lernstand: ${done} von ${done + open} Themen erledigt` +
        (pct === null ? "" : ` (${Math.round(pct * 100)} %)`) +
        `, ${exams} von ${examsTotal} Prüfungen anstehend.`
      );
    }
    case "study.attention": {
      const exams = Array.isArray(data)
        ? data.filter((entry): entry is Record<string, unknown> =>
            isRecord(entry),
          )
        : [];

      if (exams.length === 0) {
        return "Keine Prüfungen mit offenen Themen in der Nähe.";
      }

      return bullets(
        exams.map(
          (exam) =>
            `${str(exam.title) || "Prüfung"} (${dayMonth(str(exam.date))}, noch ${num(exam.openTopics) ?? 0} offene Themen)`,
        ),
      );
    }
    case "finance.monthSummary":
    case "finance.summary": {
      if (!isRecord(data)) return "Keine Finanzdaten verfügbar.";

      const expense = num(data.expenseCents);
      const income = num(data.incomeCents);

      if (expense === null || income === null) {
        return "Keine Finanzdaten verfügbar.";
      }

      const pct = num(data.budgetUsedPct);

      return (
        `Monat ${str(data.monthKey)}: Ausgaben ${formatCents(expense)}, ` +
        `Einnahmen ${formatCents(income)}.` +
        (pct === null ? "" : ` Budget zu ${Math.round(pct * 100)} % aufgebraucht.`)
      );
    }
    case "finance.largest":
    case "finance.list": {
      const rows = Array.isArray(data)
        ? data.filter((entry): entry is Record<string, unknown> =>
            isRecord(entry),
          )
        : [];

      if (rows.length === 0) return "Keine Buchungen gefunden.";

      return bullets(
        rows.map((row) => {
          const amount = num(row.amountCents);
          const foreign =
            typeof row.currency === "string" && row.currency !== "EUR"
              ? ` [${row.currency}]`
              : "";

          return (
            `${str(row.title) || "Buchung"}, ` +
            `${amount === null ? "–" : formatCents(amount)} ` +
            `(${dayMonth(str(row.date))})${foreign}`
          );
        }),
      );
    }
    case "lifestyle.preferences": {
      const prefs = isRecord(data) ? data.preferences : null;

      if (!isRecord(prefs) || data === null || !isRecord(data)) {
        return "Keine Vorlieben gespeichert.";
      }

      if (data.configured !== true) return "Keine Vorlieben gespeichert.";

      const city = str(prefs.city) || "–";
      const radius = num(prefs.radiusKm);

      return `Stadt: ${city}, Umkreis: ${radius === null ? "–" : `${radius} km`}.`;
    }
    case "lifestyle.saved": {
      const saved = itemsOf(data, "saved");

      if (saved.length === 0) return "Keine gemerkten Orte.";

      return bullets(
        saved.map(
          (place) =>
            `${str(place.name) || "Ort"} (${str(place.address) || str(place.category) || "–"})`,
        ),
      );
    }
    case "lifestyle.upcomingPlans": {
      const plans = itemsOf(data, "plans");

      if (plans.length === 0) return "Keine geplanten Ausflüge.";

      return bullets(
        plans.map(
          (plan) =>
            `${str(plan.title) || "Ausflug"} (${dayMonth(str(plan.date))})`,
        ),
      );
    }
    case "memory.approved": {
      const entries = itemsOf(data, "entries");

      if (entries.length === 0) return "Keine Einträge.";

      return bullets(
        entries.map(
          (entry) =>
            `${str(entry.title) || "Eintrag"}: ${str(entry.content).slice(0, 120)}`,
        ),
      );
    }
    default:
      return "Abfrage abgeschlossen.";
  }
}

/** Final answer from a just-executed tool result. */
function finalFromToolResult(raw: string, toolId: string | null): string {
  const parsed = tryParseJson(raw);

  if (!isRecord(parsed)) {
    return JSON.stringify({
      final: "Das Ergebnis war zu lang für eine Antwort. Bitte Frage eingrenzen.",
    });
  }

  if (parsed.ok !== true) {
    const message =
      isRecord(parsed.error) && typeof parsed.error.message === "string"
        ? parsed.error.message
        : "Unbekannter Fehler.";

    return JSON.stringify({ final: `Fehler: ${message}` });
  }

  // Write reports already speak German (executor message).
  if (typeof parsed.message === "string") {
    return JSON.stringify({ final: parsed.message });
  }

  return JSON.stringify({ final: summarizeRead(toolId, parsed.data) });
}

/** Tool id of the latest assistant tool call, if any. */
function lastToolId(messages: AgentMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role !== "assistant") continue;

    const parsed = tryParseJson(message.content);

    if (isRecord(parsed) && typeof parsed.tool === "string") {
      return parsed.tool;
    }
  }

  return null;
}

export function createHeuristicChat(base: HeuristicChatBase): AgentChat {
  return async (messages: AgentMessage[]): Promise<string> => {
    const last = messages[messages.length - 1];

    // Mid-turn, right after an execution: persisted transcripts never
    // end with a tool message (turns end with assistant finals or
    // bare user messages), so this branch only answers fresh results.
    if (last?.role === "tool") {
      return finalFromToolResult(last.content, lastToolId(messages));
    }

    const users = messages.filter(
      (message) =>
        message.role === "user" && !isAgentLoopPrompt(message.content),
    );
    const current = users[users.length - 1]?.content ?? "";
    const previous =
      users.length >= 2 ? users[users.length - 2].content : undefined;
    const ctx: NluContext = {
      todayISO: base.todayISO,
      nowTime: base.nowTime,
      timezone: base.timezone,
      locale: detectLocale(current, base.locale),
    };
    const first = parseCommand(current, ctx).plan;

    if (
      previous === undefined ||
      (first.type !== "unsupported" && first.type !== "clarify")
    ) {
      return planToEnvelope(first);
    }

    // Follow-up fragment: retry against the previous user message.
    // The combined text wins unless it parses to nothing at all.
    const retry = parseCommand(`${previous} ${current}`, ctx).plan;

    return planToEnvelope(retry.type === "unsupported" ? first : retry);
  };
}
