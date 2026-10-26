"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalStorage } from "@/src/hooks/useLocalStorage";
import { CLOUD_ENABLED } from "./mode";
import {
  apiUnknown,
  useListResource,
  useSingletonResource,
  type ListResource,
  type RemoteResult,
  type SingletonResource,
} from "./useRemoteResource";
import {
  TASKS_STORAGE_KEY,
  isTask,
  isTaskList,
  type Task,
} from "@/src/lib/tasks";
import {
  CALENDAR_STORAGE_KEY,
  NO_EVENTS,
  isCalendarEvent,
  isCalendarEventList,
  type CalendarEvent,
} from "@/src/lib/calendar";
import {
  EMPTY_STUDY,
  STUDY_STORAGE_KEY,
  isStudyData,
  type Entry,
  type StudyData,
} from "@/src/lib/study";
import {
  EMPTY_QUIZ,
  QUIZ_STORAGE_KEY,
  isQuizQuestion,
  isQuizQuestionList,
  type QuizQuestion,
} from "@/src/lib/quiz";
import {
  EMPTY_FINANCE,
  FINANCE_STORAGE_KEY,
  isFinanceData,
  isTransaction,
  type FinanceData,
  type SavingsGoal,
  type Transaction,
} from "@/src/lib/finance";
import {
  IMPORT_BATCHES_KEY,
  deleteImportPdf,
  getImportPdf,
  isImportBatchMeta,
  isImportBatchMetaList,
  saveImportPdf,
  type ImportBatchMeta,
} from "@/src/lib/finance/importStore";
import type { CategoryCorrection } from "@/src/lib/finance/categories";
import {
  CATEGORY_CORRECTIONS_KEY,
  isCategoryCorrectionList,
} from "@/src/lib/finance/importStore";
import {
  DEFAULT_PREFERENCES,
  EMPTY_PLACES,
  EMPTY_PLANS,
  EMPTY_SAVED,
  LIFESTYLE_PLACES_KEY,
  LIFESTYLE_PLANS_KEY,
  LIFESTYLE_PREFS_KEY,
  LIFESTYLE_SAVED_KEY,
  isLifestylePreferences,
  isOutingPlan,
  isOutingPlanList,
  isPlace,
  isPlaceEvent,
  isPlaceEventList,
  isPlaceList,
  isSavedList,
  type LifestylePreferences,
  type OutingPlan,
  type Place,
  type PlaceEvent,
} from "@/src/lib/lifestyle/types";
import {
  MEMORY_STORAGE_KEY,
  isMemoryEntry,
  isMemoryEntryList,
  type MemoryEntry,
} from "@/src/lib/memory";
import {
  DEFAULT_USER_SETTINGS,
  USER_SETTINGS_KEY,
  isUserSettings,
  type UserSettings,
} from "@/src/lib/settings";

/** Per-module hooks over useListResource / useSingletonResource. */

export function useTasks(initial: Task[]): ListResource<Task> {
  return useListResource<Task>(
    TASKS_STORAGE_KEY,
    initial,
    isTaskList,
    isTask,
    "/api/tasks",
  );
}

export function useCalendarEvents(): ListResource<CalendarEvent> {
  return useListResource<CalendarEvent>(
    CALENDAR_STORAGE_KEY,
    NO_EVENTS,
    isCalendarEventList,
    isCalendarEvent,
    "/api/calendar",
  );
}

export function useQuiz(): ListResource<QuizQuestion> {
  return useListResource<QuizQuestion>(
    QUIZ_STORAGE_KEY,
    EMPTY_QUIZ,
    isQuizQuestionList,
    isQuizQuestion,
    "/api/quiz",
  );
}

export function useMemory(): ListResource<MemoryEntry> {
  return useListResource<MemoryEntry>(
    MEMORY_STORAGE_KEY,
    [],
    isMemoryEntryList,
    isMemoryEntry,
    "/api/memory",
  );
}

export function usePlaces(): ListResource<Place> {
  return useListResource<Place>(
    LIFESTYLE_PLACES_KEY,
    EMPTY_PLACES,
    isPlaceList,
    isPlace,
    "/api/lifestyle/places",
  );
}

export function usePlaceEvents(): ListResource<PlaceEvent> {
  return useListResource<PlaceEvent>(
    "jarvis-lifestyle-events",
    [],
    isPlaceEventList,
    isPlaceEvent,
    "/api/lifestyle/events",
  );
}

export function usePlans(): ListResource<OutingPlan> {
  return useListResource<OutingPlan>(
    LIFESTYLE_PLANS_KEY,
    EMPTY_PLANS,
    isOutingPlanList,
    isOutingPlan,
    "/api/lifestyle/plans",
  );
}

export function usePrefs(): SingletonResource<LifestylePreferences> {
  return useSingletonResource<LifestylePreferences>(
    LIFESTYLE_PREFS_KEY,
    DEFAULT_PREFERENCES,
    isLifestylePreferences,
    "/api/lifestyle/preferences",
  );
}

export function useBatches(): ListResource<ImportBatchMeta> {
  return useListResource<ImportBatchMeta>(
    IMPORT_BATCHES_KEY,
    [],
    isImportBatchMetaList,
    isImportBatchMeta,
    "/api/finance/batches",
  );
}

export function useCorrections(): SingletonResource<CategoryCorrection[]> {
  return useSingletonResource<CategoryCorrection[]>(
    CATEGORY_CORRECTIONS_KEY,
    [],
    isCategoryCorrectionList,
    "/api/finance/corrections",
  );
}

export function useUserSettings(): SingletonResource<UserSettings> {
  return useSingletonResource<UserSettings>(
    USER_SETTINGS_KEY,
    DEFAULT_USER_SETTINGS,
    isUserSettings,
    "/api/user/settings",
  );
}

export type SavedIdsResource = {
  ids: string[];
  loading: boolean;
  error: string | null;
  mode: "local" | "cloud";
  refresh: () => Promise<void>;
  save: (placeId: string) => Promise<RemoteResult<null>>;
  unsave: (placeId: string) => Promise<RemoteResult<null>>;
  clearError: () => void;
};

export function useSavedIds(): SavedIdsResource {
  const [local, setLocal, localLoaded] = useLocalStorage<string[]>(
    LIFESTYLE_SAVED_KEY,
    EMPTY_SAVED,
    isSavedList,
  );
  const [remote, setRemote] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(CLOUD_ENABLED);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (!CLOUD_ENABLED || inflight.current) return;

    inflight.current = true;
    setLoading(true);
    setError(null);

    const result = await apiUnknown("/api/lifestyle/saved", "GET");

    if (result.ok && isSavedList(result.data)) {
      setRemote(result.data);
    } else {
      setError(result.ok ? "Unerwartete Serverantwort." : result.error);
    }

    setLoading(false);
    inflight.current = false;
  }, []);

  useEffect(() => {
    if (CLOUD_ENABLED) {
      // Mount-gated initial fetch from the API route.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refresh();
    }
  }, [refresh]);

  const save = useCallback(
    async (placeId: string): Promise<RemoteResult<null>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) =>
          current.includes(placeId) ? current : [...current, placeId],
        );

        return { ok: true, data: null };
      }

      if (inflight.current) {
        return {
          ok: false,
          error: "Bitte warte, bis der vorige Vorgang fertig ist.",
        };
      }

      inflight.current = true;
      setError(null);

      const result = await apiUnknown("/api/lifestyle/saved", "POST", {
        placeId,
      });
      inflight.current = false;

      if (!result.ok) {
        setError(result.error);

        return result;
      }

      setRemote((current) =>
        (current ?? []).includes(placeId)
          ? (current ?? [])
          : [...(current ?? []), placeId],
      );

      return { ok: true, data: null };
    },
    [setLocal],
  );

  const unsave = useCallback(
    async (placeId: string): Promise<RemoteResult<null>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) => current.filter((id) => id !== placeId));

        return { ok: true, data: null };
      }

      if (inflight.current) {
        return {
          ok: false,
          error: "Bitte warte, bis der vorige Vorgang fertig ist.",
        };
      }

      inflight.current = true;
      setError(null);

      const result = await apiUnknown(
        `/api/lifestyle/saved?placeId=${encodeURIComponent(placeId)}`,
        "DELETE",
      );
      inflight.current = false;

      if (!result.ok) {
        setError(result.error);

        return result;
      }

      setRemote((current) =>
        (current ?? []).filter((id) => id !== placeId),
      );

      return { ok: true, data: null };
    },
    [setLocal],
  );

  const clearError = useCallback(() => setError(null), []);

  if (!CLOUD_ENABLED) {
    return {
      ids: local,
      loading: !localLoaded,
      error,
      mode: "local" as const,
      refresh,
      save,
      unsave,
      clearError,
    };
  }

  return {
    ids: remote ?? [],
    loading,
    error,
    mode: "cloud" as const,
    refresh,
    save,
    unsave,
    clearError,
  };
}

export type StudySection = "subjects" | "exams" | "topics" | "materials";

export type StudyResource = {
  data: StudyData;
  loading: boolean;
  error: string | null;
  mode: "local" | "cloud";
  refresh: () => Promise<void>;
  addEntry: (
    section: StudySection,
    entry: Entry,
  ) => Promise<RemoteResult<Entry>>;
  updateEntry: (
    id: string,
    patch: Partial<Entry>,
  ) => Promise<RemoteResult<Entry>>;
  deleteEntry: (
    section: StudySection,
    id: string,
  ) => Promise<RemoteResult<null>>;
  clearError: () => void;
};

export function useStudy(initial: StudyData): StudyResource {
  const [local, setLocal, localLoaded] = useLocalStorage<StudyData>(
    STUDY_STORAGE_KEY,
    initial,
    isStudyData,
  );
  const [remote, setRemote] = useState<StudyData | null>(null);
  const [loading, setLoading] = useState(CLOUD_ENABLED);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (!CLOUD_ENABLED || inflight.current) return;

    inflight.current = true;
    setLoading(true);
    setError(null);

    const result = await apiUnknown("/api/study", "GET");

    if (result.ok && isStudyData(result.data)) {
      setRemote(result.data);
    } else {
      setError(result.ok ? "Unerwartete Serverantwort." : result.error);
    }

    setLoading(false);
    inflight.current = false;
  }, []);

  useEffect(() => {
    if (CLOUD_ENABLED) {
      // Mount-gated initial fetch from the API route.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refresh();
    }
  }, [refresh]);

  const guard = useCallback(async (): Promise<boolean> => {
    if (inflight.current) return false;

    inflight.current = true;
    setError(null);

    return true;
  }, []);

  const addEntry = useCallback(
    async (
      section: StudySection,
      entry: Entry,
    ): Promise<RemoteResult<Entry>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) => ({
          ...current,
          [section]: [...current[section], entry],
        }));

        return { ok: true, data: entry };
      }

      if (!(await guard())) {
        return {
          ok: false,
          error: "Bitte warte, bis der vorige Vorgang fertig ist.",
        };
      }

      try {
        const result = await apiUnknown("/api/study", "POST", {
          ...entry,
          section,
        });

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: entry };
      } finally {
        inflight.current = false;
      }
    },
    [guard, refresh, setLocal],
  );

  const updateEntry = useCallback(
    async (
      id: string,
      patch: Partial<Entry>,
    ): Promise<RemoteResult<Entry>> => {
      const current = CLOUD_ENABLED ? remote : local;
      const existing =
        current === null
          ? undefined
          : (["subjects", "exams", "topics", "materials"] as const)
              .flatMap((section) => current[section])
              .find((entry) => entry.id === id);

      if (existing === undefined) {
        return { ok: false, error: "Eintrag nicht gefunden." };
      }

      const merged = { ...existing, ...patch, id };

      if (!CLOUD_ENABLED) {
        setLocal((data) => {
          const next = { ...data };

          for (const section of [
            "subjects",
            "exams",
            "topics",
            "materials",
          ] as const) {
            next[section] = next[section].map((entry) =>
              entry.id === id ? merged : entry,
            );
          }

          return next;
        });

        return { ok: true, data: merged };
      }

      if (!(await guard())) {
        return {
          ok: false,
          error: "Bitte warte, bis der vorige Vorgang fertig ist.",
        };
      }

      try {
        const result = await apiUnknown(
          `/api/study/${encodeURIComponent(id)}`,
          "PATCH",
          patch,
        );

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: merged };
      } finally {
        inflight.current = false;
      }
    },
    [guard, local, refresh, remote, setLocal],
  );

  const deleteEntry = useCallback(
    async (
      section: StudySection,
      id: string,
    ): Promise<RemoteResult<null>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) => ({
          ...current,
          [section]: current[section].filter((entry) => entry.id !== id),
        }));

        return { ok: true, data: null };
      }

      if (!(await guard())) {
        return {
          ok: false,
          error: "Bitte warte, bis der vorige Vorgang fertig ist.",
        };
      }

      try {
        const result = await apiUnknown(
          `/api/study/${encodeURIComponent(id)}`,
          "DELETE",
        );

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: null };
      } finally {
        inflight.current = false;
      }
    },
    [guard, refresh, setLocal],
  );

  const clearError = useCallback(() => setError(null), []);

  if (!CLOUD_ENABLED) {
    return {
      data: local,
      loading: !localLoaded,
      error,
      mode: "local" as const,
      refresh,
      addEntry,
      updateEntry,
      deleteEntry,
      clearError,
    };
  }

  return {
    data: remote ?? EMPTY_STUDY,
    loading,
    error,
    mode: "cloud" as const,
    refresh,
    addEntry,
    updateEntry,
    deleteEntry,
    clearError,
  };
}

export type ImportBatchInput = {
  id: string;
  fileName: string;
  fileSize: number;
  statementMonth: string;
};

export type FinanceResource = {
  data: FinanceData;
  batches: ImportBatchMeta[];
  loading: boolean;
  error: string | null;
  mode: "local" | "cloud";
  refresh: () => Promise<void>;
  saveTransaction: (tx: Transaction) => Promise<RemoteResult<Transaction>>;
  deleteTransaction: (id: string) => Promise<RemoteResult<null>>;
  saveSettings: (cents: number) => Promise<RemoteResult<null>>;
  saveCategoryBudget: (
    category: string,
    cents: number,
  ) => Promise<RemoteResult<null>>;
  deleteCategoryBudget: (category: string) => Promise<RemoteResult<null>>;
  addGoal: (goal: SavingsGoal) => Promise<RemoteResult<SavingsGoal>>;
  updateGoal: (goal: SavingsGoal) => Promise<RemoteResult<SavingsGoal>>;
  deleteGoal: (id: string) => Promise<RemoteResult<null>>;
  importBatch: (
    rows: Transaction[],
    meta: ImportBatchInput,
    file: File,
  ) => Promise<
    RemoteResult<{ batch: ImportBatchMeta; imported: number; pdfSaved: boolean }>
  >;
  deleteBatch: (id: string) => Promise<RemoteResult<number>>;
  downloadBatchFile: (id: string) => Promise<RemoteResult<Blob>>;
  deleteBatchFile: (id: string) => Promise<RemoteResult<null>>;
  clearError: () => void;
};

export function useFinance(): FinanceResource {
  const [local, setLocal, localLoaded] = useLocalStorage<FinanceData>(
    FINANCE_STORAGE_KEY,
    EMPTY_FINANCE,
    isFinanceData,
  );
  const [localBatches, setLocalBatches, localBatchesLoaded] =
    useLocalStorage<ImportBatchMeta[]>(
      IMPORT_BATCHES_KEY,
      [],
      isImportBatchMetaList,
    );
  const [remote, setRemote] = useState<FinanceData | null>(null);
  const [remoteBatches, setRemoteBatches] = useState<ImportBatchMeta[] | null>(
    null,
  );
  const [loading, setLoading] = useState(CLOUD_ENABLED);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (!CLOUD_ENABLED || inflight.current) return;

    inflight.current = true;
    setLoading(true);
    setError(null);

    const [financeResult, batchResult] = await Promise.all([
      apiUnknown("/api/finance", "GET"),
      apiUnknown("/api/finance/batches", "GET"),
    ]);

    if (
      financeResult.ok &&
      isFinanceData(financeResult.data) &&
      batchResult.ok &&
      isImportBatchMetaList(batchResult.data)
    ) {
      setRemote(financeResult.data);
      setRemoteBatches(batchResult.data);
    } else {
      setError(
        !financeResult.ok
          ? financeResult.error
          : !batchResult.ok
            ? batchResult.error
            : "Unerwartete Serverantwort.",
      );
    }

    setLoading(false);
    inflight.current = false;
  }, []);

  useEffect(() => {
    if (CLOUD_ENABLED) {
      // Mount-gated initial fetch from the API route.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refresh();
    }
  }, [refresh]);

  const guard = useCallback(async (): Promise<boolean> => {
    if (inflight.current) return false;

    inflight.current = true;
    setError(null);

    return true;
  }, []);

  const release = useCallback(() => {
    inflight.current = false;
  }, []);

  const busy = useCallback(
    (): RemoteResult<never> => ({
      ok: false,
      error: "Bitte warte, bis der vorige Vorgang fertig ist.",
    }),
    [],
  );

  const saveTransaction = useCallback(
    async (tx: Transaction): Promise<RemoteResult<Transaction>> => {
      if (!isTransaction(tx)) {
        return { ok: false, error: "Ungültige Buchung." };
      }

      if (!CLOUD_ENABLED) {
        setLocal((current) => ({
          ...current,
          transactions: current.transactions.some((item) => item.id === tx.id)
            ? current.transactions.map((item) =>
                item.id === tx.id ? tx : item,
              )
            : [...current.transactions, tx],
        }));

        return { ok: true, data: tx };
      }

      if (!(await guard())) return busy() as RemoteResult<Transaction>;

      try {
        const exists = (remote?.transactions ?? []).some(
          (item) => item.id === tx.id,
        );
        const result = exists
          ? await apiUnknown(
              `/api/finance/transactions/${encodeURIComponent(tx.id)}`,
              "PATCH",
              tx,
            )
          : await apiUnknown("/api/finance/transactions", "POST", tx);

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: tx };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release, remote, setLocal],
  );

  const deleteTransaction = useCallback(
    async (id: string): Promise<RemoteResult<null>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) => ({
          ...current,
          transactions: current.transactions.filter(
            (item) => item.id !== id,
          ),
        }));

        return { ok: true, data: null };
      }

      if (!(await guard())) return busy();

      try {
        const result = await apiUnknown(
          `/api/finance/transactions/${encodeURIComponent(id)}`,
          "DELETE",
        );

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: null };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release, setLocal],
  );

  const saveSettings = useCallback(
    async (cents: number): Promise<RemoteResult<null>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) => ({ ...current, monthlyBudgetCents: cents }));

        return { ok: true, data: null };
      }

      if (!(await guard())) return busy();

      try {
        const result = await apiUnknown("/api/finance/settings", "PUT", {
          monthlyBudgetCents: cents,
        });

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: null };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release, setLocal],
  );

  const saveCategoryBudget = useCallback(
    async (category: string, cents: number): Promise<RemoteResult<null>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) => ({
          ...current,
          categoryBudgets: { ...current.categoryBudgets, [category]: cents },
        }));

        return { ok: true, data: null };
      }

      if (!(await guard())) return busy();

      try {
        const result = await apiUnknown(
          "/api/finance/category-budgets",
          "PUT",
          { category, cents },
        );

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: null };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release, setLocal],
  );

  const deleteCategoryBudget = useCallback(
    async (category: string): Promise<RemoteResult<null>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) => {
          const categoryBudgets = { ...current.categoryBudgets };
          delete categoryBudgets[category];

          return { ...current, categoryBudgets };
        });

        return { ok: true, data: null };
      }

      if (!(await guard())) return busy();

      try {
        const result = await apiUnknown(
          `/api/finance/category-budgets?category=${encodeURIComponent(category)}`,
          "DELETE",
        );

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: null };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release, setLocal],
  );

  const addGoal = useCallback(
    async (goal: SavingsGoal): Promise<RemoteResult<SavingsGoal>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) => ({
          ...current,
          goals: [...current.goals, goal],
        }));

        return { ok: true, data: goal };
      }

      if (!(await guard()))
        return busy() as RemoteResult<SavingsGoal>;

      try {
        const result = await apiUnknown("/api/finance/goals", "POST", goal);

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: goal };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release, setLocal],
  );

  const updateGoal = useCallback(
    async (goal: SavingsGoal): Promise<RemoteResult<SavingsGoal>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) => ({
          ...current,
          goals: current.goals.map((item) =>
            item.id === goal.id ? goal : item,
          ),
        }));

        return { ok: true, data: goal };
      }

      if (!(await guard()))
        return busy() as RemoteResult<SavingsGoal>;

      try {
        const result = await apiUnknown(
          `/api/finance/goals/${encodeURIComponent(goal.id)}`,
          "PATCH",
          goal,
        );

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: goal };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release, setLocal],
  );

  const deleteGoal = useCallback(
    async (id: string): Promise<RemoteResult<null>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) => ({
          ...current,
          goals: current.goals.filter((item) => item.id !== id),
        }));

        return { ok: true, data: null };
      }

      if (!(await guard())) return busy();

      try {
        const result = await apiUnknown(
          `/api/finance/goals/${encodeURIComponent(id)}`,
          "DELETE",
        );

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: null };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release, setLocal],
  );

  const importBatch = useCallback(
    async (
      rows: Transaction[],
      meta: ImportBatchInput,
      file: File,
    ): Promise<
      RemoteResult<{ batch: ImportBatchMeta; imported: number; pdfSaved: boolean }>
    > => {
      if (!CLOUD_ENABLED) {
        const batch: ImportBatchMeta = {
          ...meta,
          importedAt: new Date().toISOString(),
          count: rows.length,
        };
        setLocal((current) => ({
          ...current,
          transactions: [...current.transactions, ...rows],
        }));
        setLocalBatches((current) => [...current, batch]);

        try {
          await saveImportPdf(meta.id, file);

          return { ok: true, data: { batch, imported: rows.length, pdfSaved: true } };
        } catch {
          return { ok: true, data: { batch, imported: rows.length, pdfSaved: false } };
        }
      }

      if (!(await guard())) {
        return busy() as RemoteResult<{
          batch: ImportBatchMeta;
          imported: number;
          pdfSaved: boolean;
        }>;
      }

      try {
        const created = await apiUnknown(
          "/api/finance/statement-upload",
          "POST",
          { ...meta, count: rows.length },
        );

        if (!created.ok) {
          setError(created.error);

          return created;
        }

        const payload = created.data as {
          batch?: ImportBatchMeta;
          uploadUrl?: string;
        };

        if (
          payload.batch === undefined ||
          typeof payload.uploadUrl !== "string"
        ) {
          setError("Unerwartete Serverantwort.");

          return { ok: false, error: "Unerwartete Serverantwort." };
        }

        try {
          const upload = await fetch(payload.uploadUrl, {
            method: "PUT",
            headers: { "Content-Type": "application/pdf" },
            body: file,
          });

          if (!upload.ok) {
            throw new Error(`upload:${upload.status}`);
          }
        } catch {
          await apiUnknown(
            `/api/finance/batches/${encodeURIComponent(meta.id)}`,
            "DELETE",
          );
          setError("PDF-Upload fehlgeschlagen. Import abgebrochen.");

          return { ok: false, error: "PDF-Upload fehlgeschlagen." };
        }

        const bulk = await apiUnknown(
          "/api/finance/transactions/bulk",
          "POST",
          {
            items: rows.map((row) => ({
              ...row,
              sourceDocumentId: meta.id,
              importStatus: "imported",
            })),
          },
        );

        if (!bulk.ok) {
          setError(bulk.error);

          return bulk;
        }

        const imported =
          typeof (bulk.data as { imported?: unknown }).imported === "number"
            ? (bulk.data as { imported: number }).imported
            : rows.length;

        await refresh();

        return {
          ok: true,
          data: { batch: payload.batch, imported, pdfSaved: true },
        };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release, setLocal, setLocalBatches],
  );

  const deleteBatch = useCallback(
    async (id: string): Promise<RemoteResult<number>> => {
      if (!CLOUD_ENABLED) {
        let count = 0;
        setLocal((current) => {
          const linked = current.transactions.filter(
            (item) => item.sourceDocumentId === id,
          );
          count = linked.length;

          return {
            ...current,
            transactions: current.transactions.filter(
              (item) => item.sourceDocumentId !== id,
            ),
          };
        });
        setLocalBatches((current) =>
          current.filter((batch) => batch.id !== id),
        );

        try {
          await deleteImportPdf(id);
        } catch {
          // Batch metadata deletion wins.
        }

        return { ok: true, data: count };
      }

      if (!(await guard())) return busy() as RemoteResult<number>;

      try {
        const result = await apiUnknown(
          `/api/finance/batches/${encodeURIComponent(id)}`,
          "DELETE",
        );

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        const count =
          typeof (result.data as { deletedTransactions?: unknown })
            .deletedTransactions === "number"
            ? (result.data as { deletedTransactions: number })
                .deletedTransactions
            : 0;

        await refresh();

        return { ok: true, data: count };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release, setLocal, setLocalBatches],
  );

  const downloadBatchFile = useCallback(
    async (id: string): Promise<RemoteResult<Blob>> => {
      if (!CLOUD_ENABLED) {
        try {
          const stored = await getImportPdf(id);

          if (stored === null) {
            return { ok: false, error: "PDF ist nicht mehr gespeichert." };
          }

          return { ok: true, data: new Blob([stored.blob], { type: "application/pdf" }) };
        } catch {
          return { ok: false, error: "Das PDF konnte nicht geladen werden." };
        }
      }

      const result = await apiUnknown(
        `/api/finance/batches/${encodeURIComponent(id)}/download`,
        "GET",
      );

      if (!result.ok) {
        return result;
      }

      const url = (result.data as { url?: unknown }).url;

      if (typeof url !== "string") {
        return { ok: false, error: "Unerwartete Serverantwort." };
      }

      try {
        const res = await fetch(url);

        if (!res.ok) {
          return { ok: false, error: "Das PDF konnte nicht geladen werden." };
        }

        return { ok: true, data: await res.blob() };
      } catch {
        return { ok: false, error: "Das PDF konnte nicht geladen werden." };
      }
    },
    [],
  );

  const deleteBatchFile = useCallback(
    async (id: string): Promise<RemoteResult<null>> => {
      if (!CLOUD_ENABLED) {
        try {
          await deleteImportPdf(id);

          return { ok: true, data: null };
        } catch {
          return { ok: false, error: "Das PDF konnte nicht gelöscht werden." };
        }
      }

      if (!(await guard())) return busy();

      try {
        const result = await apiUnknown(
          `/api/finance/batches/${encodeURIComponent(id)}/file`,
          "DELETE",
        );

        if (!result.ok) {
          setError(result.error);

          return result;
        }

        await refresh();

        return { ok: true, data: null };
      } finally {
        release();
      }
    },
    [busy, guard, refresh, release],
  );

  const clearError = useCallback(() => setError(null), []);

  if (!CLOUD_ENABLED) {
    return {
      data: local,
      batches: localBatches,
      loading: !localLoaded || !localBatchesLoaded,
      error,
      mode: "local" as const,
      refresh,
      saveTransaction,
      deleteTransaction,
      saveSettings,
      saveCategoryBudget,
      deleteCategoryBudget,
      addGoal,
      updateGoal,
      deleteGoal,
      importBatch,
      deleteBatch,
      downloadBatchFile,
      deleteBatchFile,
      clearError,
    };
  }

  return {
    data: remote ?? EMPTY_FINANCE,
    batches: remoteBatches ?? [],
    loading,
    error,
    mode: "cloud" as const,
    refresh,
    saveTransaction,
    deleteTransaction,
    saveSettings,
    saveCategoryBudget,
    deleteCategoryBudget,
    addGoal,
    updateGoal,
    deleteGoal,
    importBatch,
    deleteBatch,
    downloadBatchFile,
    deleteBatchFile,
    clearError,
  };
}
