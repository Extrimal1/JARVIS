"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { useToday } from "./useToday";
import {
  useCalendarEvents,
  useConversationMessages,
  useConversationThreads,
  useFinance,
  useMemory,
  usePlaces,
  usePlans,
  usePrefs,
  useSavedIds,
  useStudy,
  useTasks,
} from "@/src/lib/db/useModules";
import type { Task } from "@/src/lib/tasks";
import { EMPTY_STUDY, type StudyData } from "@/src/lib/study";
import { createId } from "@/src/lib/ids";
import type { AssistantLocale } from "@/src/lib/assistant/actions";
import {
  createApiChat,
  type AgentOutcome,
  type AgentWriteUndo,
} from "@/src/lib/assistant/agent";
import {
  sendConversationTurn,
  threadMessages,
} from "@/src/lib/assistant/conversation";
import { createHeuristicChat } from "@/src/lib/assistant/heuristicChat";
import {
  transcriptToTurns,
  type ViewTurn,
} from "@/src/lib/assistant/transcript";
import {
  executePending,
  executeUndo,
  pendingForPick,
  type ActionPlan,
  type CandidateOption,
  type ExecutorDeps,
  type PendingAction,
} from "@/src/lib/assistant/executor";
import type {
  ConversationModule,
  ConversationThread,
} from "@/src/lib/conversation";
import {
  listStudyDocuments,
  retrieveStudy,
} from "@/src/lib/db/studyRetrieval";
import type { ProviderId } from "@/src/lib/assistant/providers";

/**
 * Shared conversation hook: the ONLY UI entry point to the
 * conversation engine. Dashboard and /assistant both use it, so both
 * show the same threads, the same history, and the same behavior —
 * there is exactly one chat implementation, one agent loop, and one
 * conversation store.
 *
 * Responsibilities: engine status (GET /api/llm), module data
 * assembly for tools, thread selection, send/cancel/retry, and the
 * ephemeral confirm/pick/undo/error cards for the latest turn.
 * Persistence itself lives in the conversation service + resources.
 */

const NO_TASKS: Task[] = [];

const SELECTED_THREAD_KEY = "jarvis-conversation-selected";

function isSelectedId(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export type EngineStatus = {
  provider: ProviderId;
  configured: boolean;
  available: boolean;
  contextChars: number;
};

function isEngineStatusPayload(value: unknown): value is {
  ok: true;
  data: EngineStatus;
} {
  if (typeof value !== "object" || value === null) return false;

  const envelope = value as { ok?: unknown; data?: unknown };

  if (envelope.ok !== true) return false;
  if (typeof envelope.data !== "object" || envelope.data === null) {
    return false;
  }

  const data = envelope.data as Record<string, unknown>;

  return (
    (data.provider === "heuristic" || data.provider === "ollama") &&
    typeof data.configured === "boolean" &&
    typeof data.available === "boolean" &&
    typeof data.contextChars === "number"
  );
}

export type LiveCard =
  | { kind: "confirm"; summary: string; pending: PendingAction }
  | {
      kind: "pick";
      question: string;
      options: CandidateOption[];
      plan: ActionPlan;
    };

export type UndoEntry = {
  tool: string;
  undone: boolean;
  result: string | null;
  undo: AgentWriteUndo["undo"];
};

export type UseConversationOptions = {
  module: ConversationModule;
  locale: AssistantLocale;
  /**
   * Stable starter data when storage is empty (the dashboard passes
   * its seeds). Must be module-level stable; defaults add nothing.
   */
  initialTasks?: Task[];
  initialStudy?: StudyData;
};

export function useConversation(options: UseConversationOptions) {
  const { module, locale } = options;

  const calendar = useCalendarEvents();
  const finance = useFinance();
  const tasks = useTasks(options.initialTasks ?? NO_TASKS);
  const study = useStudy(options.initialStudy ?? EMPTY_STUDY);
  const places = usePlaces();
  const plans = usePlans();
  const prefs = usePrefs();
  const savedIds = useSavedIds();
  const memory = useMemory();
  const threads = useConversationThreads();
  const messages = useConversationMessages();
  const today = useToday();

  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useLocalStorage<string | null>(
    SELECTED_THREAD_KEY,
    null,
    isSelectedId,
  );
  const [draftNew, setDraftNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryText, setRetryText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [liveCard, setLiveCard] = useState<LiveCard | null>(null);
  const [undos, setUndos] = useState<UndoEntry[]>([]);
  const busyRef = useRef(false);
  const sendToken = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadEngine(): Promise<void> {
      try {
        const res = await fetch("/api/llm");
        const parsed: unknown = await res.json();

        if (cancelled) return;

        if (isEngineStatusPayload(parsed)) {
          setEngine(parsed.data);
          setEngineError(null);
        } else {
          setEngineError(
            res.status === 401
              ? "Sitzung abgelaufen. Bitte melde dich erneut an."
              : `Engine-Status ungültig (${res.status}).`,
          );
        }
      } catch {
        if (!cancelled) {
          setEngineError(
            "Keine Verbindung zum Server. Prüfe deine Verbindung und versuche es erneut.",
          );
        }
      }
    }

    void loadEngine();

    return () => {
      cancelled = true;
    };
  }, []);

  const sortedThreads = useMemo<ConversationThread[]>(
    () =>
      [...threads.items].sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
      ),
    [threads.items],
  );

  const effectiveId = draftNew
    ? null
    : (selectedId !== null &&
        sortedThreads.some((thread) => thread.id === selectedId)
        ? selectedId
        : (sortedThreads[0]?.id ?? null));

  const turns: ViewTurn[] = useMemo(
    () =>
      effectiveId === null
        ? []
        : transcriptToTurns(threadMessages(messages.items, effectiveId)),
    [effectiveId, messages.items],
  );

  const storesLoading =
    calendar.loading ||
    finance.loading ||
    tasks.loading ||
    study.loading ||
    places.loading ||
    plans.loading ||
    prefs.loading ||
    savedIds.loading ||
    memory.loading ||
    threads.loading ||
    messages.loading;

  const storesError =
    calendar.error ??
    finance.error ??
    tasks.error ??
    study.error ??
    places.error ??
    plans.error ??
    prefs.error ??
    savedIds.error ??
    memory.error ??
    threads.error ??
    messages.error ??
    null;

  const ready =
    today !== null && !storesLoading && engine !== null && engineError === null;

  const deps = useMemo<ExecutorDeps>(
    () => ({
      events: calendar.items,
      finance: finance.data,
      calendar: {
        create: calendar.create,
        update: calendar.update,
        remove: calendar.remove,
      },
      transactions: {
        saveTransaction: finance.saveTransaction,
        deleteTransaction: finance.deleteTransaction,
      },
      locale,
    }),
    [calendar, finance, locale],
  );

  const selectThread = useCallback(
    (id: string | null) => {
      setDraftNew(false);
      setSelectedId(id);
      setLiveCard(null);
      setUndos([]);
      setError(null);
      setRetryText(null);
      setNotice(null);
    },
    [setSelectedId],
  );

  const newThread = useCallback(() => {
    setDraftNew(true);
    setSelectedId(null);
    setLiveCard(null);
    setUndos([]);
    setError(null);
    setRetryText(null);
    setNotice(null);
  }, [setSelectedId]);

  const handleOutcome = useCallback(
    (outcome: AgentOutcome, text: string) => {
      if (outcome.status === "done") {
        setUndos(
          outcome.undos.map((entry) => ({
            tool: entry.tool,
            undone: false,
            result: null,
            undo: entry.undo,
          })),
        );

        return;
      }

      if (outcome.status === "confirm") {
        setLiveCard({
          kind: "confirm",
          summary: outcome.summary,
          pending: outcome.pending,
        });

        return;
      }

      if (outcome.status === "pick") {
        setLiveCard({
          kind: "pick",
          question: outcome.question,
          options: outcome.options,
          plan: outcome.plan,
        });

        return;
      }

      setError(outcome.message);
      setRetryText(text);
    },
    [],
  );

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();

      if (text === "" || busyRef.current) return;

      const currentEngine = engine;
      const currentToday = today;

      if (currentEngine === null || currentToday === null || storesLoading) {
        setError(
          locale === "ru"
            ? "Данные ещё загружаются. Подожди немного."
            : "Daten werden noch geladen. Bitte warte kurz.",
        );

        return;
      }

      if (
        currentEngine.provider === "ollama" &&
        !currentEngine.configured
      ) {
        setError(
          "Kein KI-Modell konfiguriert. Setze OLLAMA_MODEL auf dem Server oder nutze das lokale Regelwerk (ASSISTANT_PROVIDER=heuristic).",
        );

        return;
      }

      busyRef.current = true;
      setBusy(true);
      setError(null);
      setRetryText(null);
      setNotice(null);
      setLiveCard(null);
      setUndos([]);

      const controller = new AbortController();
      abortRef.current = controller;
      const token = (sendToken.current += 1);
      const now = new Date();
      const nowTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const chat =
        currentEngine.provider === "heuristic"
          ? createHeuristicChat({
              todayISO: currentToday,
              nowTime,
              timezone:
                Intl.DateTimeFormat().resolvedOptions().timeZone ??
                "Europe/Berlin",
              locale,
            })
          : createApiChat(fetch, controller.signal);

      try {
        const result = await sendConversationTurn({
          threadId: effectiveId,
          text,
          locale,
          module,
          chat,
          data: {
            events: calendar.items,
            finance: finance.data,
            tasks: tasks.items,
            study: study.data,
            places: places.items,
            savedIds: savedIds.ids,
            plans: plans.items,
            prefs: prefs.data,
            memory: memory.items,
            todayISO: currentToday,
            nowTime,
          },
          stores: {
            calendar: {
              create: calendar.create,
              update: calendar.update,
              remove: calendar.remove,
            },
            transactions: {
              saveTransaction: finance.saveTransaction,
              deleteTransaction: finance.deleteTransaction,
            },
          },
          threads,
          messages,
          history: { maxChars: currentEngine.contextChars },
          agent: {
            signal: controller.signal,
            challengeBareFinals: currentEngine.provider !== "heuristic",
            asyncReads: {
              "study.documents": async () => listStudyDocuments(),
              "study.retrieve": async (args) =>
                retrieveStudy({
                  query:
                    typeof args.query === "string" ? args.query : "",
                  documentId:
                    typeof args.documentId === "string"
                      ? args.documentId
                      : undefined,
                  limit:
                    typeof args.limit === "number" ? args.limit : undefined,
                }),
            },
          },
        });

        if (sendToken.current !== token) return;

        if (result.thread !== null) {
          setSelectedId(result.thread.id);
          setDraftNew(false);
        }

        handleOutcome(result.outcome, text);
      } catch (error: unknown) {
        if (sendToken.current !== token) return;

        setError(
          error instanceof Error && error.message !== ""
            ? error.message
            : "Unbekannter Fehler.",
        );
        setRetryText(text);
      } finally {
        if (sendToken.current === token) {
          busyRef.current = false;
          setBusy(false);
          abortRef.current = null;
        }
      }
    },
    [
      calendar,
      effectiveId,
      engine,
      finance,
      locale,
      memory,
      messages,
      module,
      handleOutcome,
      places,
      plans,
      prefs,
      savedIds,
      setSelectedId,
      storesLoading,
      study,
      tasks,
      threads,
      today,
    ],
  );

  const cancel = useCallback(() => {
    if (!busyRef.current) return;

    sendToken.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    setBusy(false);
  }, []);

  const retry = useCallback(() => {
    if (retryText === null) return;

    void send(retryText);
  }, [retryText, send]);

  const confirmTurn = useCallback(
    async (accept: boolean) => {
      if (liveCard?.kind !== "confirm") return;

      if (!accept) {
        setLiveCard(null);
        setNotice(
          locale === "ru"
            ? "Отменено — ничего не изменено."
            : "Abgebrochen — es wurde nichts geändert.",
        );

        return;
      }

      const report = await executePending(liveCard.pending, createId(), deps);

      if (report.status === "confirm") {
        setLiveCard({
          kind: "confirm",
          summary: report.summary,
          pending: report.pending,
        });

        return;
      }

      setLiveCard(null);

      if (report.status === "error") {
        setNotice(report.message);

        return;
      }

      if (report.status === "pick") {
        setNotice(report.question);

        return;
      }

      setNotice(report.message);

      const undo = report.undo;

      if (undo !== undefined) {
        setUndos((current) => [
          ...current,
          { tool: "confirm", undone: false, result: null, undo },
        ]);
      }
    },
    [deps, liveCard, locale],
  );

  const pickTurn = useCallback(
    async (eventId: string) => {
      if (liveCard?.kind !== "pick") return;

      const event = deps.events.find((item) => item.id === eventId);

      if (event === undefined) {
        setLiveCard(null);
        setNotice(
          locale === "ru"
            ? "Эта встреча больше не существует."
            : "Dieser Termin existiert nicht mehr.",
        );

        return;
      }

      const pending = pendingForPick(liveCard.plan, event, locale);

      if (pending === null) {
        setLiveCard(null);
        setNotice(
          locale === "ru"
            ? "Этот выбор больше не подходит."
            : "Diese Auswahl passt nicht mehr.",
        );

        return;
      }

      if (pending.kind === "calendar.update") {
        setLiveCard({
          kind: "confirm",
          summary: `Wirklich ändern? ${event.title} wird aktualisiert.`,
          pending,
        });

        return;
      }

      const report = await executePending(pending, createId(), deps);

      setLiveCard(null);
      setNotice(
        report.status === "error" || report.status === "done"
          ? report.message
          : report.status === "confirm"
            ? report.summary
            : report.question,
      );
    },
    [deps, liveCard, locale],
  );

  const undoTurn = useCallback(
    async (index: number) => {
      const entry = undos[index];

      if (entry === undefined || entry.undone) return;

      const report = await executeUndo(entry.undo, deps);

      setUndos((current) =>
        current.map((item, position) =>
          position === index
            ? {
                ...item,
                undone: report.ok,
                result: report.ok
                  ? report.message
                  : `Rückgängig fehlgeschlagen: ${report.message}`,
              }
            : item,
        ),
      );
    },
    [deps, undos],
  );

  return {
    engine,
    engineError,
    ready,
    storesLoading,
    storesError,
    sortedThreads,
    effectiveId,
    turns,
    busy,
    error,
    notice,
    liveCard,
    undos,
    canRetry: retryText !== null && !busy,
    send,
    cancel,
    retry,
    selectThread,
    newThread,
    confirmTurn,
    pickTurn,
    undoTurn,
  };
}

export type UseConversation = ReturnType<typeof useConversation>;
