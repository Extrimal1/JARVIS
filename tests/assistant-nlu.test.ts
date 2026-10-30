/**
 * NLU tests: German/Russian command understanding, clarification
 * behavior, and relative-date resolution. Fixed "today" (Tuesday,
 * 2026-10-27) keeps every expectation deterministic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "@/src/lib/assistant/nlu";
import type { NluContext } from "@/src/lib/assistant/actions";

const CTX: NluContext = {
  todayISO: "2026-10-27",
  nowTime: "10:00",
  timezone: "Europe/Berlin",
  locale: "de",
};

function planOf(text: string, ctx: NluContext = CTX) {
  return parseCommand(text, ctx);
}

describe("calendar.create (German)", () => {
  it("parses the spec example with relative date and duration word", () => {
    const { plan, locale } = planOf(
      "Plane morgen um 15:30 Uhr ein einstündiges Treffen mit Max.",
    );

    assert.equal(locale, "de");
    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.date, "2026-10-28");
    assert.equal(plan.event.start, "15:30");
    assert.equal(plan.event.end, "16:30");
    assert.equal(plan.event.title, "Treffen mit Max");
    assert.equal(plan.event.type, "personal");
  });

  it("detects lectures and weekday dates", () => {
    const { plan } = planOf("Erstelle am Freitag um 9:00 eine Vorlesung Mathe");

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.date, "2026-10-30");
    assert.equal(plan.event.start, "09:00");
    assert.equal(plan.event.end, "10:00");
    assert.equal(plan.event.type, "lecture");
    assert.equal(plan.event.title, "Vorlesung Mathe");
  });

  it("honors explicit end times (bis HH:MM)", () => {
    const { plan } = planOf("Plane heute von 14 bis 15.30 Uhr ein Meeting");

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.date, "2026-10-27");
    assert.equal(plan.event.start, "14:00");
    assert.equal(plan.event.end, "15:30");
  });

  it("keeps von-start and bis-end apart", () => {
    const { plan } = planOf("Plane morgen ein Meeting von 14 bis 15:30");

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.start, "14:00");
    assert.equal(plan.event.end, "15:30");
    assert.equal(plan.event.title, "Meeting");
  });

  it("ignores greetings (Guten Morgen is not the date)", () => {
    const { plan } = planOf(
      "Guten Morgen, plane heute um 9 Uhr ein Standup",
    );

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.date, "2026-10-27");
    assert.equal(plan.event.title, "Standup");
  });

  it("honors minute durations", () => {
    const { plan } = planOf(
      "Plane morgen um 10 Uhr ein Meeting von 30 Minuten",
    );

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.start, "10:00");
    assert.equal(plan.event.end, "10:30");
  });

  it("resolves halb + daypart to the afternoon", () => {
    const { plan } = planOf("Plane morgen halb 4 nachmittags einen Arzttermin");

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.start, "15:30");
    assert.equal(plan.event.end, "16:30");
    assert.equal(plan.event.title, "Arzttermin");
  });

  it("splits trailing locations (im Büro)", () => {
    const { plan } = planOf(
      "Plane morgen um 15:30 ein Treffen mit Max im Büro",
    );

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.title, "Treffen mit Max");
    assert.equal(plan.event.location, "Büro");
  });

  it("resolves explicit dates to the next occurrence", () => {
    const upcoming = planOf("Plane am 5.11. um 10:00 ein Meeting");

    assert.equal(upcoming.plan.type, "calendar.create");

    if (upcoming.plan.type === "calendar.create") {
      assert.equal(upcoming.plan.event.date, "2026-11-05");
    }

    // Past day-month without a year → next year (calendar outlook).
    const wrapped = planOf("Plane am 5.3. um 10:00 ein Meeting");

    assert.equal(wrapped.plan.type, "calendar.create");

    if (wrapped.plan.type === "calendar.create") {
      assert.equal(wrapped.plan.event.date, "2027-03-05");
    }
  });

  it("resolves weekdays (same day = today, nächsten = +7)", () => {
    const same = planOf("Plane am Dienstag um 10 Uhr ein Standup");
    assert.equal(same.plan.type, "calendar.create");

    if (same.plan.type === "calendar.create") {
      assert.equal(same.plan.event.date, "2026-10-27");
    }

    const coming = planOf("Plane am Montag um 10 Uhr ein Standup");
    assert.equal(coming.plan.type, "calendar.create");

    if (coming.plan.type === "calendar.create") {
      assert.equal(coming.plan.event.date, "2026-11-02");
    }

    const nextWeek = planOf("Plane nächsten Montag um 10 Uhr ein Standup");
    assert.equal(nextWeek.plan.type, "calendar.create");

    if (nextWeek.plan.type === "calendar.create") {
      assert.equal(nextWeek.plan.event.date, "2026-11-09");
    }
  });

  it("accepts date+time+title without a trigger verb", () => {
    const { plan } = planOf("Morgen 15:30 Treffen mit Max");

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.date, "2026-10-28");
    assert.equal(plan.event.start, "15:30");
  });
});

describe("calendar.create (Russian)", () => {
  it("parses a Russian create command and detects the locale", () => {
    const { plan, locale } = planOf("Создай встречу завтра в 15:30 с Максом");

    assert.equal(locale, "ru");
    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.date, "2026-10-28");
    assert.equal(plan.event.start, "15:30");
    assert.equal(plan.event.end, "16:30");
    assert.equal(plan.event.title, "Встреча с Максом");
  });

  it("reads Russian hour durations (на час)", () => {
    const { plan } = planOf("Создай встречу завтра в 10:00 на час");

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.start, "10:00");
    assert.equal(plan.event.end, "11:00");
  });

  it("resolves Russian weekdays and cleans titles", () => {
    const { plan } = planOf("Создай встречу в пятницу в 10:00, планёрка");

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.date, "2026-10-30");
    assert.equal(plan.event.title, "Встреча, планёрка");
  });
});

describe("calendar clarification", () => {
  it("asks instead of inventing a date", () => {
    const { plan } = planOf("Plane um 15 Uhr ein Treffen mit Max");

    assert.equal(plan.type, "clarify");

    if (plan.type !== "clarify") return;

    assert.match(plan.question, /Tag/);
    assert.deepEqual(
      plan.options.map((option) => option.label),
      ["Heute", "Morgen"],
    );
  });

  it("asks instead of inventing a time", () => {
    const { plan } = planOf("Plane morgen ein Treffen mit Max");

    assert.equal(plan.type, "clarify");

    if (plan.type !== "clarify") return;

    assert.match(plan.question, /Uhr/);
  });

  it("clarifies ambiguous bare hours (3:00 vs 15:00)", () => {
    const { plan } = planOf("Plane morgen um 3 ein Treffen");

    assert.equal(plan.type, "clarify");

    if (plan.type !== "clarify") return;

    assert.match(plan.question, /3:00/);
    assert.match(plan.question, /15:00/);
  });

  it("accepts a clarification answer appended to the original", () => {
    const first = planOf("Plane ein Treffen mit Max");
    assert.equal(first.plan.type, "clarify");

    const second = planOf("Plane ein Treffen mit Max morgen um 15:00");
    assert.equal(second.plan.type, "calendar.create");

    if (second.plan.type !== "calendar.create") return;

    assert.equal(second.plan.event.date, "2026-10-28");
    assert.equal(second.plan.event.start, "15:00");
    assert.equal(second.plan.event.title, "Treffen mit Max");
  });

  it("resolves an ambiguous hour via the appended HH:MM answer", () => {
    const first = planOf("Plane morgen Treffen mit Max um 3");
    assert.equal(first.plan.type, "clarify");

    const { plan } = planOf("Plane morgen Treffen mit Max um 3 15:00");

    assert.equal(plan.type, "calendar.create");

    if (plan.type !== "calendar.create") return;

    assert.equal(plan.event.date, "2026-10-28");
    assert.equal(plan.event.start, "15:00");
    assert.equal(plan.event.title, "Treffen mit Max");
  });
});

describe("calendar.list", () => {
  it("lists a single day", () => {
    const { plan } = planOf("Was habe ich morgen?");

    assert.equal(plan.type, "calendar.list");

    if (plan.type !== "calendar.list") return;

    assert.equal(plan.from, "2026-10-28");
    assert.equal(plan.to, "2026-10-28");
  });

  it("resolves week ranges", () => {
    const next = planOf("Zeige meine Termine nächste Woche");

    assert.equal(next.plan.type, "calendar.list");

    if (next.plan.type === "calendar.list") {
      assert.equal(next.plan.from, "2026-11-02");
      assert.equal(next.plan.to, "2026-11-08");
    }

    const current = planOf("Termine diese Woche");

    assert.equal(current.plan.type, "calendar.list");

    if (current.plan.type === "calendar.list") {
      assert.equal(current.plan.from, "2026-10-26");
      assert.equal(current.plan.to, "2026-11-01");
    }
  });

  it("answers Russian list questions", () => {
    const { plan, locale } = planOf("Что у меня завтра?");

    assert.equal(locale, "ru");
    assert.equal(plan.type, "calendar.list");

    if (plan.type !== "calendar.list") return;

    assert.equal(plan.from, "2026-10-28");
    assert.equal(plan.to, "2026-10-28");
  });
});

describe("calendar.update / calendar.delete", () => {
  it("parses move commands with date and time", () => {
    const { plan } = planOf("Verschiebe das Treffen mit Max auf morgen 16 Uhr");

    assert.equal(plan.type, "calendar.update");

    if (plan.type !== "calendar.update") return;

    assert.equal(plan.ref.titleQuery, "mit Max");
    assert.equal(plan.patch.date, "2026-10-28");
    assert.equal(plan.patch.start, "16:00");
  });

  it("accepts date-only moves", () => {
    const { plan } = planOf("Verschiebe das Treffen mit Max auf morgen");

    assert.equal(plan.type, "calendar.update");

    if (plan.type !== "calendar.update") return;

    assert.equal(plan.patch.date, "2026-10-28");
    assert.equal(plan.patch.start, undefined);
  });

  it("parses delete commands with a reference", () => {
    const { plan } = planOf("Lösche den Termin beim Zahnarzt");

    assert.equal(plan.type, "calendar.delete");

    if (plan.type !== "calendar.delete") return;

    assert.equal(plan.ref.titleQuery, "beim Zahnarzt");
  });

  it("asks when the reference is missing", () => {
    const { plan } = planOf("Lösche den Termin");

    assert.equal(plan.type, "clarify");
  });

  it("parses Russian deletes", () => {
    const { plan, locale } = planOf("Удали встречу с Максом");

    assert.equal(locale, "ru");
    assert.equal(plan.type, "calendar.delete");

    if (plan.type !== "calendar.delete") return;

    assert.equal(plan.ref.titleQuery, "с Максом");
  });
});

describe("finance.create (German)", () => {
  it("parses the spec example exactly", () => {
    const { plan } = planOf(
      "Ich habe heute 24,50 Euro bei Lidl für Lebensmittel ausgegeben.",
    );

    assert.equal(plan.type, "finance.create");

    if (plan.type !== "finance.create") return;

    assert.equal(plan.transaction.amountCents, 2450);
    assert.equal(plan.transaction.currency, "EUR");
    assert.equal(plan.transaction.type, "expense");
    assert.equal(plan.transaction.title, "Lidl");
    assert.equal(plan.transaction.category, "Lebensmittel");
    assert.equal(plan.transaction.date, "2026-10-27");
  });

  it("infers categories from the merchant via existing rules", () => {
    const { plan } = planOf("Habe gestern 12 Euro bei Rewe bezahlt");

    assert.equal(plan.type, "finance.create");

    if (plan.type !== "finance.create") return;

    assert.equal(plan.transaction.amountCents, 1200);
    assert.equal(plan.transaction.title, "Rewe");
    assert.equal(plan.transaction.category, "Lebensmittel");
    assert.equal(plan.transaction.date, "2026-10-26");
  });

  it("parses income with explicit signals", () => {
    const { plan } = planOf("Gehalt 2500 Euro erhalten");

    assert.equal(plan.type, "finance.create");

    if (plan.type !== "finance.create") return;

    assert.equal(plan.transaction.amountCents, 250000);
    assert.equal(plan.transaction.type, "income");
    assert.equal(plan.transaction.category, "Gehalt");
  });

  it("reads thousands separators in amounts", () => {
    const { plan } = planOf("1.234,56 Euro Gehalt erhalten");

    assert.equal(plan.type, "finance.create");

    if (plan.type !== "finance.create") return;

    assert.equal(plan.transaction.amountCents, 123456);
  });

  it("reads spoken euros and cents", () => {
    const { plan } = planOf("24 Euro 50 bei Lidl ausgegeben");

    assert.equal(plan.type, "finance.create");

    if (plan.type !== "finance.create") return;

    assert.equal(plan.transaction.amountCents, 2450);
    assert.equal(plan.transaction.title, "Lidl");
  });

  it("accepts bare amounts with a finance verb", () => {
    const { plan } = planOf("Habe 24 bei Lidl bezahlt");

    assert.equal(plan.type, "finance.create");

    if (plan.type !== "finance.create") return;

    assert.equal(plan.transaction.amountCents, 2400);
    assert.equal(plan.transaction.currency, "EUR");
  });

  it("asks for expense-vs-income on bare amounts", () => {
    const { plan } = planOf("24,50 Euro");

    assert.equal(plan.type, "clarify");

    if (plan.type !== "clarify") return;

    assert.match(plan.question, /Ausgabe/);
  });

  it("asks for the amount instead of inventing one", () => {
    const { plan } = planOf("Habe bei Lidl bezahlt");

    assert.equal(plan.type, "clarify");

    if (plan.type !== "clarify") return;

    assert.match(plan.question, /Betrag/);
  });

  it("never mistakes a date for an amount", () => {
    const { plan } = planOf("Habe am 5.11. bezahlt");

    assert.equal(plan.type, "clarify");

    if (plan.type !== "clarify") return;

    assert.match(plan.question, /Betrag/);
  });
});

describe("finance.create (Russian)", () => {
  it("parses rubles, merchants, and categories", () => {
    const { plan, locale } = planOf(
      "Потратил 500 рублей в Пятёрочке на продукты",
    );

    assert.equal(locale, "ru");
    assert.equal(plan.type, "finance.create");

    if (plan.type !== "finance.create") return;

    assert.equal(plan.transaction.amountCents, 50000);
    assert.equal(plan.transaction.currency, "RUB");
    assert.equal(plan.transaction.type, "expense");
    assert.equal(plan.transaction.title, "Пятёрочке");
    assert.equal(plan.transaction.category, "Lebensmittel");
  });

  it("reads rubles and kopeks", () => {
    const { plan } = planOf("Потратил 10 рублей 50 копеек");

    assert.equal(plan.type, "finance.create");

    if (plan.type !== "finance.create") return;

    assert.equal(plan.transaction.amountCents, 1050);
  });
});

describe("finance.list / finance.summary", () => {
  it("parses count-limited list requests", () => {
    const { plan } = planOf("Zeige meine letzten 5 Buchungen");

    assert.equal(plan.type, "finance.list");

    if (plan.type !== "finance.list") return;

    assert.equal(plan.limit, 5);
  });

  it("routes how-much questions to summaries, not creates", () => {
    const { plan } = planOf("Wie viel habe ich diesen Monat ausgegeben?");

    assert.equal(plan.type, "finance.summary");

    if (plan.type !== "finance.summary") return;

    assert.equal(plan.monthKey, "2026-10");
  });

  it("resolves named months to the most recent past occurrence", () => {
    const past = planOf("Wie viel habe ich im Mai ausgegeben?");

    assert.equal(past.plan.type, "finance.summary");

    if (past.plan.type === "finance.summary") {
      assert.equal(past.plan.monthKey, "2026-05");
    }

    const future = planOf("Wie viel habe ich im Dezember ausgegeben?");

    assert.equal(future.plan.type, "finance.summary");

    if (future.plan.type === "finance.summary") {
      assert.equal(future.plan.monthKey, "2025-12");
    }
  });

  it("scopes summaries to a category in the current month", () => {
    const { plan } = planOf("Wie viel habe ich für Lebensmittel ausgegeben?");

    assert.equal(plan.type, "finance.summary");

    if (plan.type !== "finance.summary") return;

    assert.equal(plan.category, "Lebensmittel");
    assert.equal(plan.from, "2026-10-01");
    assert.equal(plan.to, "2026-10-31");
  });
});

describe("unsupported input", () => {
  it("declines gracefully in German", () => {
    const { plan, locale } = planOf("Erzähle mir einen Witz");

    assert.equal(locale, "de");
    assert.equal(plan.type, "unsupported");
  });

  it("declines gracefully in Russian", () => {
    const { plan, locale } = planOf("Привет, как дела?");

    assert.equal(locale, "ru");
    assert.equal(plan.type, "unsupported");

    if (plan.type !== "unsupported") return;

    assert.match(plan.message, /не понял/);
  });
});
