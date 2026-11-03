import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseStudyTabs,
  studyHref,
} from "@/src/lib/study/tabs";
import {
  transcriptionStatusFromEnv,
  isTranscript,
  workerAuthHeaders,
} from "@/src/lib/lecture/transcription";
import {
  filterNewsByInterests,
  isNewsItem,
  parseInterests,
  parseRssFeed,
} from "@/src/lib/lifestyle/news";
import {
  buildNotifications,
  dueReviews,
  isQuizDue,
} from "@/src/lib/dashboard";
import {
  eventsOnDay,
  monthCells,
  monthGridLabel,
  shiftYearMonth,
} from "@/src/lib/calendar";
import {
  isTransaction,
  RECURRING_LABELS,
} from "@/src/lib/finance";
import {
  parseMemoryEnabled,
  visibleMemory,
  type MemoryEntry,
} from "@/src/lib/memory";
import { isLocalRecording } from "@/src/lib/lecture/types";
import type { QuizQuestion } from "@/src/lib/quiz";

function quizQuestion(patch: Partial<QuizQuestion>): QuizQuestion {
  return {
    id: "q1",
    subject: "Mathe",
    examId: null,
    topicId: null,
    question: "1+1?",
    options: ["1", "2"],
    correctIndex: 1,
    explanation: "",
    ...patch,
  };
}

function memoryEntry(patch: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: "m1",
    version: 1,
    category: "preferences",
    title: "Tee",
    content: "Trinkt Tee.",
    origin: "user",
    approved: true,
    pinned: false,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("study tabs deep links", () => {
  it("parses tab + prep params", () => {
    assert.deepEqual(
      parseStudyTabs(new URLSearchParams("tab=prep&prep=plan")),
      { tab: "prep", prep: "plan" },
    );
  });

  it("falls back to overview for unknown values", () => {
    assert.deepEqual(parseStudyTabs(new URLSearchParams("tab=nope&prep=x")), {
      tab: "overview",
      prep: "overview",
    });
    assert.deepEqual(parseStudyTabs(new URLSearchParams("")), {
      tab: "overview",
      prep: "overview",
    });
  });

  it("builds canonical deep links", () => {
    assert.equal(studyHref("overview"), "/study");
    assert.equal(studyHref("documents"), "/study?tab=documents");
    assert.equal(studyHref("prep"), "/study?tab=prep");
    assert.equal(studyHref("prep", "exams"), "/study?tab=prep&prep=exams");
  });
});

describe("transcription integration point", () => {
  it("is unconfigured without env", () => {
    for (const value of [undefined, null, "", "   "]) {
      const status = transcriptionStatusFromEnv(value);

      assert.equal(status.configured, false);
      assert.match(
        (status as { reason: string }).reason,
        /LECTURE_WORKER_URL/,
      );
    }
  });

  it("rejects non-http worker urls", () => {
    const status = transcriptionStatusFromEnv("ftp://worker");

    assert.equal(status.configured, false);
  });

  it("accepts http(s) worker urls and trims slashes", () => {
    const status = transcriptionStatusFromEnv("http://127.0.0.1:8123///");

    assert.deepEqual(status, {
      configured: true,
      workerUrl: "http://127.0.0.1:8123",
    });
  });

  it("validates transcripts strictly", () => {
    assert.equal(
      isTranscript({
        recordingId: "r1",
        language: "de",
        fullText: "Hallo",
        transcribedAt: "2026-01-01T00:00:00.000Z",
        segments: [{ start: 0, end: 1.5, text: "Hallo" }],
      }),
      true,
    );
    assert.equal(isTranscript({ fullText: "x" }), false);
    assert.equal(
      isTranscript({
        recordingId: "r1",
        language: "de",
        fullText: "x",
        transcribedAt: "t",
        segments: [{ start: "0", end: 1, text: "x" }],
      }),
      false,
    );
  });

  it("forwards the worker token as a bearer header", () => {
    assert.deepEqual(workerAuthHeaders("secret-token"), {
      Authorization: "Bearer secret-token",
    });
    assert.deepEqual(workerAuthHeaders("  padded  "), {
      Authorization: "Bearer padded",
    });
  });

  it("sends no auth header without a token", () => {
    for (const value of [undefined, null, "", "   "]) {
      assert.equal(workerAuthHeaders(value), undefined);
    }
  });
});

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
<item><title><![CDATA[Klima &amp; Zukunft]]></title><link>https://ex.de/1</link><pubDate>Tue, 03 Nov 2026 08:00:00 GMT</pubDate><description><p>Kurz <b>text</b>.</p></description></item>
<item><title>Ohne Link</title><description>nichts</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title>
<entry><title>Atom Eintrag</title><link href="https://ex.de/a"/><updated>2026-11-02T10:00:00Z</updated><summary>Summe</summary></entry>
</feed>`;

describe("lifestyle news parser", () => {
  it("parses RSS items and skips link-less entries", () => {
    const items = parseRssFeed(
      RSS,
      { id: "f", label: "Feed" },
      "2026-11-03T00:00:00.000Z",
    );

    assert.equal(items.length, 1);
    assert.equal(items[0]?.title, "Klima & Zukunft");
    assert.equal(items[0]?.link, "https://ex.de/1");
    assert.equal(items[0]?.excerpt, "Kurz text .");
    assert.equal(items[0]?.publishedAt, "2026-11-03T08:00:00.000Z");
    assert.ok(items[0] !== undefined && isNewsItem(items[0]));
  });

  it("parses Atom entries via link href", () => {
    const items = parseRssFeed(
      ATOM,
      { id: "a", label: "Atom" },
      "2026-11-03T00:00:00.000Z",
    );

    assert.equal(items.length, 1);
    assert.equal(items[0]?.link, "https://ex.de/a");
    assert.equal(items[0]?.publishedAt, "2026-11-02T10:00:00.000Z");
  });

  it("respects maxItems and never invents fields", () => {
    const items = parseRssFeed(
      RSS,
      { id: "f", label: "Feed" },
      "2026-11-03T00:00:00.000Z",
      0,
    );

    assert.deepEqual(items, []);
    assert.equal(
      parseRssFeed("kein xml", { id: "f", label: "F" }, "t").length,
      0,
    );
  });

  it("filters by comma-separated interests (case-insensitive)", () => {
    const items = parseRssFeed(
      RSS,
      { id: "f", label: "Feed" },
      "2026-11-03T00:00:00.000Z",
    );

    assert.equal(filterNewsByInterests(items, "").length, 1);
    assert.equal(filterNewsByInterests(items, "klima").length, 1);
    assert.equal(filterNewsByInterests(items, "kino, KLIMA").length, 1);
    assert.equal(filterNewsByInterests(items, "kino").length, 0);
    assert.deepEqual(parseInterests(" a,, b "), ["a", "b"]);
  });
});

describe("dashboard notifications", () => {
  it("isQuizDue treats missing dates as due, mastered as done", () => {
    assert.equal(isQuizDue(quizQuestion({}), "2026-11-03"), true);
    assert.equal(
      isQuizDue(quizQuestion({ nextReviewAt: "2026-11-03" }), "2026-11-03"),
      true,
    );
    assert.equal(
      isQuizDue(quizQuestion({ nextReviewAt: "2026-11-04" }), "2026-11-03"),
      false,
    );
    assert.equal(
      isQuizDue(
        quizQuestion({ nextReviewAt: null, reviewStatus: "mastered" }),
        "2026-11-03",
      ),
      false,
    );
  });

  it("dueReviews filters the question pool", () => {
    const questions = [
      quizQuestion({ id: "due", nextReviewAt: "2026-11-01" }),
      quizQuestion({ id: "later", nextReviewAt: "2026-12-01" }),
    ];

    assert.deepEqual(
      dueReviews(questions, "2026-11-03").map((item) => item.id),
      ["due"],
    );
  });

  it("builds notifications only from loaded modules", () => {
    const input = {
      todayISO: "2026-11-03",
      tasks: [
        { id: "t1", title: "Dringend", time: "10:00", done: false, priority: "Hoch" as const },
      ],
      events: [
        {
          id: "e1",
          title: "Vorlesung",
          date: "2026-11-03",
          start: "09:00",
          end: "10:00",
          type: "lecture" as const,
          description: "",
          location: "",
        },
      ],
      deadlines: [
        {
          id: "d1",
          title: "Klausur",
          kind: "exam" as const,
          date: "2026-11-04",
          daysLeft: 1,
          subject: "Mathe",
        },
      ],
      finance: {
        transactions: [],
        monthlyBudgetCents: 10000,
        categoryBudgets: {},
        goals: [],
      },
      financeExpenseCents: 12000,
      questions: [quizQuestion({ id: "due" })],
      loaded: {
        tasks: true,
        events: true,
        study: true,
        finance: true,
        quiz: true,
      },
    };

    const ids = buildNotifications(input).map((item) => item.id);

    assert.deepEqual(ids, [
      "tasks-urgent",
      "events-today",
      "deadline-d1",
      "finance-budget",
      "quiz-due",
    ]);

    const unloaded = buildNotifications({
      ...input,
      loaded: {
        tasks: false,
        events: false,
        study: false,
        finance: false,
        quiz: false,
      },
    });

    assert.deepEqual(unloaded, []);
  });

  it("stays silent when everything is calm", () => {
    const empty = buildNotifications({
      todayISO: "2026-11-03",
      tasks: [],
      events: [],
      deadlines: [],
      finance: {
        transactions: [],
        monthlyBudgetCents: 0,
        categoryBudgets: {},
        goals: [],
      },
      financeExpenseCents: 0,
      questions: [],
      loaded: {
        tasks: true,
        events: true,
        study: true,
        finance: true,
        quiz: true,
      },
    });

    assert.deepEqual(empty, []);
  });
});

describe("calendar month/day helpers", () => {
  it("builds a Monday-first full-week grid", () => {
    // November 2026: the 1st is a Sunday -> 6 leading days, 30 days + 6 = 36 -> 42 cells.
    const cells = monthCells(2026, 10);

    assert.equal(cells.length % 7, 0);
    assert.equal(cells[0]?.iso, "2026-10-26");
    assert.equal(cells[0]?.inMonth, false);
    assert.equal(cells[6]?.iso, "2026-11-01");
    assert.equal(cells[6]?.inMonth, true);
    assert.ok(cells.some((cell) => cell.iso === "2026-11-30" && cell.inMonth));
  });

  it("shifts year/month across year boundaries", () => {
    assert.deepEqual(shiftYearMonth(2026, 0, -1), { year: 2025, month: 11 });
    assert.deepEqual(shiftYearMonth(2026, 11, 1), { year: 2027, month: 0 });
  });

  it("labels months in German", () => {
    assert.match(monthGridLabel(2026, 10), /November 2026/);
  });

  it("eventsOnDay filters and sorts by start time", () => {
    const events = [
      {
        id: "b",
        title: "B",
        date: "2026-11-03",
        start: "10:00",
        end: "11:00",
        type: "lecture" as const,
        description: "",
        location: "",
      },
      {
        id: "a",
        title: "A",
        date: "2026-11-03",
        start: "08:00",
        end: "09:00",
        type: "exam" as const,
        description: "",
        location: "",
      },
      {
        id: "other",
        title: "C",
        date: "2026-11-04",
        start: "08:00",
        end: "09:00",
        type: "exam" as const,
        description: "",
        location: "",
      },
    ];

    assert.deepEqual(
      eventsOnDay(events, "2026-11-03").map((event) => event.id),
      ["a", "b"],
    );
  });
});

describe("finance recurring marker", () => {
  it("accepts recurring cadences and keeps old records valid", () => {
    const base = {
      id: "t1",
      title: "Miete",
      amount: 50000,
      type: "expense",
      category: "Miete",
      date: "2026-11-01",
    };

    assert.equal(isTransaction(base), true);
    assert.equal(isTransaction({ ...base, recurring: "monthly" }), true);
    assert.equal(isTransaction({ ...base, recurring: "weekly" }), false);
  });

  it("labels every cadence in German", () => {
    assert.deepEqual(RECURRING_LABELS, {
      none: "Einmalig",
      monthly: "Monatlich",
      quarterly: "Quartalsweise",
      yearly: "Jährlich",
    });
  });
});

describe("memory kill-switch", () => {
  it("defaults to enabled unless explicitly 0", () => {
    assert.equal(parseMemoryEnabled(null), true);
    assert.equal(parseMemoryEnabled("1"), true);
    assert.equal(parseMemoryEnabled(""), true);
    assert.equal(parseMemoryEnabled("0"), false);
  });

  it("visibleMemory returns nothing when disabled", () => {
    const entries = [memoryEntry({})];

    assert.equal(visibleMemory(entries, "2026-01-02", true).length, 1);
    assert.deepEqual(visibleMemory(entries, "2026-01-02", false), []);
  });
});

describe("lecture recording extensions", () => {
  it("accepts notes/subject/transcript and keeps old records valid", () => {
    const base = {
      id: "r1",
      sessionId: null,
      courseId: null,
      title: "VO 1",
      language: "de",
      mimeType: "audio/webm",
      durationSeconds: 60,
      sizeBytes: 100,
      sha256: "abc",
      status: "saved_locally",
      errorCode: "",
      consentAt: null,
      createdAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    };

    assert.equal(isLocalRecording(base), true);
    assert.equal(
      isLocalRecording({
        ...base,
        notes: "Notiz",
        subjectId: "s1",
        transcript: "Hallo",
        transcribedAt: "2026-11-03T01:00:00.000Z",
      }),
      true,
    );
    assert.equal(isLocalRecording({ ...base, notes: 42 }), false);
    assert.equal(
      isLocalRecording({ ...base, transcribedAt: "kein-datum" }),
      false,
    );
  });
});
