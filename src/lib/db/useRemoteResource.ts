"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocalStorage } from "@/src/hooks/useLocalStorage";
import { CLOUD_ENABLED } from "./mode";

/**
 * Shared remote-resource abstraction. One hook per collection with an
 * identical shape in both modes:
 * - local mode: browser storage (existing keys/validators, unchanged).
 * - cloud mode: typed API routes (server-validated, per-user).
 *
 * Success is only reported after the server confirms the write;
 * in-flight mutations are serialized to prevent double submits.
 */

export type RemoteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function apiUnknown(
  path: string,
  method: string,
  body?: unknown,
): Promise<RemoteResult<unknown>> {
  let res: Response;

  try {
    res = await fetch(path, {
      method,
      headers:
        body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return {
        ok: false,
        error: "Du bist offline. Verbinde dich und versuche es erneut.",
      };
    }

    return {
      ok: false,
      error: "Keine Verbindung zum Server. Bitte versuche es erneut.",
    };
  }

  let parsed: unknown = null;

  try {
    parsed = (await res.json()) as unknown;
  } catch {
    return { ok: false, error: `Serverfehler (${res.status}).` };
  }

  if (!res.ok || !isRecord(parsed) || parsed.ok !== true) {
    if (res.status === 401) {
      // Hard navigation clears all client state on session expiry.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;

      return { ok: false, error: "Sitzung abgelaufen." };
    }

    const message =
      isRecord(parsed) &&
      isRecord(parsed.error) &&
      typeof parsed.error.message === "string"
        ? parsed.error.message
        : `Serverfehler (${res.status}).`;

    return { ok: false, error: message };
  }

  return { ok: true, data: (parsed as { data: unknown }).data };
}

export type ListResource<T extends { id: string }> = {
  items: T[];
  loading: boolean;
  error: string | null;
  mode: "local" | "cloud";
  refresh: () => Promise<void>;
  create: (item: T) => Promise<RemoteResult<T>>;
  update: (id: string, patch: Partial<T>) => Promise<RemoteResult<T>>;
  remove: (id: string) => Promise<RemoteResult<null>>;
  clearError: () => void;
};

/**
 * List collection with local/cloud adapters. All config arguments must
 * be module-level stable references (keys, initial values, validators).
 */
export function useListResource<T extends { id: string }>(
  storageKey: string,
  initial: T[],
  isList: (value: unknown) => value is T[],
  isItem: (value: unknown) => value is T,
  apiPath: string,
): ListResource<T> {
  const [local, setLocal, localLoaded] = useLocalStorage<T[]>(
    storageKey,
    initial,
    isList,
  );
  const [remote, setRemote] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(CLOUD_ENABLED);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (!CLOUD_ENABLED || inflight.current) return;

    inflight.current = true;
    setLoading(true);
    setError(null);

    const result = await apiUnknown(apiPath, "GET");

    if (result.ok && isList(result.data)) {
      setRemote(result.data);
    } else {
      setError(
        result.ok ? "Unerwartete Serverantwort." : result.error,
      );
    }

    setLoading(false);
    inflight.current = false;
  }, [apiPath, isList]);

  useEffect(() => {
    if (CLOUD_ENABLED) {
      // Mount-gated initial fetch from the API route.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refresh();
    }
  }, [refresh]);

  const create = useCallback(
    async (item: T): Promise<RemoteResult<T>> => {
      if (!isItem(item)) {
        return { ok: false, error: "Ungültiger Eintrag." };
      }

      if (!CLOUD_ENABLED) {
        setLocal((current) =>
          current.some((entry) => entry.id === item.id)
            ? current.map((entry) => (entry.id === item.id ? item : entry))
            : [...current, item],
        );

        return { ok: true, data: item };
      }

      if (inflight.current) {
        return {
          ok: false,
          error: "Bitte warte, bis der vorige Vorgang fertig ist.",
        };
      }

      inflight.current = true;
      setError(null);

      const result = await apiUnknown(apiPath, "POST", item);
      inflight.current = false;

      if (!result.ok) {
        setError(result.error);

        return result;
      }

      if (!isItem(result.data)) {
        setError("Unerwartete Serverantwort.");

        return { ok: false, error: "Unerwartete Serverantwort." };
      }

      const created = result.data;
      setRemote((current) => [...(current ?? []), created]);

      return { ok: true, data: created };
    },
    [apiPath, isItem, setLocal],
  );

  const update = useCallback(
    async (id: string, patch: Partial<T>): Promise<RemoteResult<T>> => {
      if (!CLOUD_ENABLED) {
        let updated: T | null = null;

        setLocal((current) =>
          current.map((entry) => {
            if (entry.id !== id) return entry;

            const merged = { ...entry, ...patch, id };

            if (!isItem(merged)) return entry;

            updated = merged;

            return merged;
          }),
        );

        if (updated === null) {
          return { ok: false, error: "Eintrag nicht gefunden." };
        }

        return { ok: true, data: updated };
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
        `${apiPath}/${encodeURIComponent(id)}`,
        "PATCH",
        patch,
      );
      inflight.current = false;

      if (!result.ok) {
        setError(result.error);

        return result;
      }

      if (!isItem(result.data)) {
        setError("Unerwartete Serverantwort.");

        return { ok: false, error: "Unerwartete Serverantwort." };
      }

      setRemote((current) =>
        (current ?? []).map((entry) =>
          entry.id === id ? result.data as T : entry,
        ),
      );

      return { ok: true, data: result.data };
    },
    [apiPath, isItem, setLocal],
  );

  const remove = useCallback(
    async (id: string): Promise<RemoteResult<null>> => {
      if (!CLOUD_ENABLED) {
        setLocal((current) =>
          current.filter((entry) => entry.id !== id),
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

      const result = await apiUnknown(
        `${apiPath}/${encodeURIComponent(id)}`,
        "DELETE",
      );
      inflight.current = false;

      if (!result.ok) {
        setError(result.error);

        return result;
      }

      setRemote((current) =>
        (current ?? []).filter((entry) => entry.id !== id),
      );

      return { ok: true, data: null };
    },
    [apiPath, setLocal],
  );

  const clearError = useCallback(() => setError(null), []);

  if (!CLOUD_ENABLED) {
    return {
      items: local,
      loading: !localLoaded,
      error,
      mode: "local" as const,
      refresh,
      create,
      update,
      remove,
      clearError,
    };
  }

  return {
    items: remote ?? [],
    loading,
    error,
    mode: "cloud" as const,
    refresh,
    create,
    update,
    remove,
    clearError,
  };
}

export type SingletonResource<T> = {
  data: T;
  loading: boolean;
  error: string | null;
  mode: "local" | "cloud";
  refresh: () => Promise<void>;
  save: (next: T) => Promise<RemoteResult<T>>;
  clearError: () => void;
};

/** Single-object resource (settings, preferences). */
export function useSingletonResource<T>(
  storageKey: string,
  initial: T,
  isValid: (value: unknown) => value is T,
  apiPath: string,
): SingletonResource<T> {
  const [local, setLocal, localLoaded] = useLocalStorage<T>(
    storageKey,
    initial,
    isValid,
  );
  const [remote, setRemote] = useState<T | null>(null);
  const [loading, setLoading] = useState(CLOUD_ENABLED);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (!CLOUD_ENABLED || inflight.current) return;

    inflight.current = true;
    setLoading(true);
    setError(null);

    const result = await apiUnknown(apiPath, "GET");

    if (result.ok && isValid(result.data)) {
      setRemote(result.data);
    } else {
      setError(result.ok ? "Unerwartete Serverantwort." : result.error);
    }

    setLoading(false);
    inflight.current = false;
  }, [apiPath, isValid]);

  useEffect(() => {
    if (CLOUD_ENABLED) {
      // Mount-gated initial fetch from the API route.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refresh();
    }
  }, [refresh]);

  const save = useCallback(
    async (next: T): Promise<RemoteResult<T>> => {
      if (!isValid(next)) {
        return { ok: false, error: "Ungültige Daten." };
      }

      if (!CLOUD_ENABLED) {
        setLocal(next);

        return { ok: true, data: next };
      }

      if (inflight.current) {
        return {
          ok: false,
          error: "Bitte warte, bis der vorige Vorgang fertig ist.",
        };
      }

      inflight.current = true;
      setError(null);

      const result = await apiUnknown(apiPath, "PUT", next);
      inflight.current = false;

      if (!result.ok) {
        setError(result.error);

        return result;
      }

      if (!isValid(result.data)) {
        setError("Unerwartete Serverantwort.");

        return { ok: false, error: "Unerwartete Serverantwort." };
      }

      setRemote(result.data);

      return { ok: true, data: result.data };
    },
    [apiPath, isValid, setLocal],
  );

  const clearError = useCallback(() => setError(null), []);

  if (!CLOUD_ENABLED) {
    return {
      data: local,
      loading: !localLoaded,
      error,
      mode: "local" as const,
      refresh,
      save,
      clearError,
    };
  }

  return {
    data: remote ?? initial,
    loading,
    error,
    mode: "cloud" as const,
    refresh,
    save,
    clearError,
  };
}
