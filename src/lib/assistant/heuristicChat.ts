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
    case "lifestyle.placesSearch": {
      const places = itemsOf(data, "places");
      const notice = isRecord(data) ? str(data.notice) : "";
      const provider =
        isRecord(data) && isRecord(data.diagnostics)
          ? str(data.diagnostics.provider)
          : "";

      if (places.length === 0) {
        return (
          notice ||
          "Keine Orte gefunden. Versuche einen allgemeineren Suchtext oder eine andere Umgebung."
        );
      }

      // Real tool results only: name + provider address + map link.
      // Generic ideas are never mixed in — an empty tool result stays
      // an honest empty state, never invented venues.
      const lines = places.map((place) => {
        const address = str(place.address);
        const hours = str(place.openingHours);
        const lat = num(place.latitude);
        const lon = num(place.longitude);
        const map =
          lat === null || lon === null
            ? ""
            : ` – Karte: https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;

        return (
          `${str(place.name) || "Ort"}` +
          (address === "" ? "" : ` – ${address}`) +
          (hours === "" ? "" : ` (laut OpenStreetMap: ${hours})`) +
          map
        );
      });
      const source =
        provider === "overpass"
          ? "Quelle: OpenStreetMap (live, Umkreissuche)."
          : provider === "nominatim"
            ? "Quelle: OpenStreetMap (live, Textsuche)."
            : "Quelle: OpenStreetMap (live).";

      return (
        bullets(lines) +
        (notice === "" ? "" : `\nHinweis: ${notice}`) +
        `\n${source}`
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
    case "briefing.today": {
      if (!isRecord(data)) return "Kein Tagesbriefing verfügbar.";

      const sections: string[] = [];
      const todayData = isRecord(data.today) ? data.today : null;
      const events = todayData !== null ? itemsOf(todayData, "events") : [];

      sections.push(
        events.length === 0
          ? "Heute: keine Termine."
          : `Heute: ${events.length} ${events.length === 1 ? "Termin" : "Termine"} — ` +
              events
                .slice(0, 5)
                .map(
                  (event) =>
                    `${str(event.title) || "Termin"} ${str(event.start)}`,
                )
                .join("; ") +
              (events.length > 5 ? ` (+${events.length - 5} weitere)` : "") +
              ".",
      );

      const tasksData = isRecord(data.tasks) ? data.tasks : null;
      const open = tasksData !== null ? itemsOf(tasksData, "open") : [];
      const overdue = tasksData !== null ? itemsOf(tasksData, "overdue") : [];

      sections.push(
        open.length === 0
          ? "Aufgaben: keine offen."
          : `Aufgaben: ${open.length} offen` +
              (overdue.length > 0 ? ` (${overdue.length} überfällig)` : "") +
              ".",
      );

      const deadlinesData = isRecord(data.deadlines) ? data.deadlines : null;
      const deadlines =
        deadlinesData !== null ? itemsOf(deadlinesData, "deadlines") : [];
      const urgent = deadlines.filter((deadline) => {
        const daysLeft = num(deadline.daysLeft);

        return daysLeft !== null && daysLeft <= 7;
      });

      sections.push(
        urgent.length === 0
          ? "Prüfungen/Fristen: nichts Dringendes in den nächsten 7 Tagen."
          : `Prüfungen/Fristen: ${bullets(
              urgent.slice(0, 5).map((deadline) => {
                const daysLeft = num(deadline.daysLeft);

                return `${str(deadline.title) || "Frist"} (${daysLeft === null ? "?" : daysLeft < 0 ? `überfällig seit ${-daysLeft} Tagen` : daysLeft === 0 ? "heute" : `in ${daysLeft} Tagen`})`;
              }),
            )}`,
      );

      const financeData = isRecord(data.finance) ? data.finance : null;
      const expense =
        financeData !== null ? num(financeData.expenseCents) : null;
      const income = financeData !== null ? num(financeData.incomeCents) : null;

      sections.push(
        expense === null || income === null
          ? "Finanzen: keine Daten."
          : `Finanzen (${str(financeData?.monthKey)}): Ausgaben ${formatCents(expense)}, Einnahmen ${formatCents(income)}.`,
      );

      return sections.join("\n");
    }
    case "study.documents": {
      const docs = itemsOf(data, "documents");

      if (docs.length === 0) return "Keine Dokumente hochgeladen.";

      return bullets(
        docs.map((doc) => {
          const status = str(doc.extractionStatus);
          const statusNote =
            status === "" || status === "completed"
              ? ""
              : ` (${status})`;

          return `${str(doc.name) || "Dokument"}${statusNote}`;
        }),
      );
    }
    case "study.retrieve": {
      const sources = itemsOf(data, "sources");

      if (sources.length === 0) {
        return "Die Unterlagen enthalten nichts zu dieser Frage.";
      }

      return (
        bullets(
          sources.map((source) => {
            const marker = str(source.marker);
            const name = str(source.documentName) || "Dokument";
            const ref = str(source.refLabel);
            const text = str(source.text).slice(0, 200);

            return `${marker === "" ? "•" : marker} ${name}${ref === "" ? "" : `, ${ref}`}: ${text}`;
          }),
        ) + "\nNur diese Quellen wurden verwendet."
      );
    }
    case "lecture.overview": {
      if (!isRecord(data)) return "Keine Vorlesungsdaten verfügbar.";

      const sessions = num(data.sessionCount) ?? 0;
      const recordings = num(data.recordingCount) ?? 0;

      if (sessions === 0 && recordings === 0) {
        return "Keine Vorlesungen oder Aufnahmen vorhanden.";
      }

      const recent = itemsOf(data, "recent");
      const head = `${sessions} ${sessions === 1 ? "Sitzung" : "Sitzungen"}, ${recordings} ${recordings === 1 ? "Aufnahme" : "Aufnahmen"}.`;

      if (recent.length === 0) return head;

      return (
        head +
        "\n" +
        bullets(
          recent.slice(0, 5).map((recording) => {
            const seconds = num(recording.durationSeconds) ?? 0;
            const minutes = Math.round(seconds / 60);

            return `${str(recording.title) || "Aufnahme"} (${minutes} Min.)`;
          }),
        )
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

  if (typeof parsed.gekürzt === "string") {
    return JSON.stringify({ final: parsed.gekürzt });
  }

  if (parsed.ok !== true) {
    const message =
      isRecord(parsed.error) && typeof parsed.error.message === "string"
        ? parsed.error.message
        : typeof parsed.error === "string"
          ? parsed.error
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
