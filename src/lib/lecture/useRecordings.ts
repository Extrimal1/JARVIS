"use client";

import { useCallback, useEffect, useState } from "react";
import { createId } from "@/src/lib/ids";
import {
  deleteRecordingAll,
  deleteSession,
  listRecordings,
  listSessions,
  saveRecordingMeta,
  saveSession,
} from "./audioStore";
import type {
  LectureLanguage,
  LectureSession,
  LocalRecording,
} from "./types";

export type RecordingsStore = {
  sessions: LectureSession[];
  recordings: LocalRecording[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createSession: (
    input: { courseId: string | null; title: string },
  ) => Promise<LectureSession | null>;
  removeSession: (id: string) => Promise<void>;
  saveRecording: (meta: LocalRecording) => Promise<boolean>;
  removeRecording: (id: string) => Promise<void>;
};

/**
 * Local-first lecture library over IndexedDB. All operations are offline;
 * cloud upload/sync arrives in Phase H (statuses already model it).
 */
export function useRecordings(): RecordingsStore {
  const [sessions, setSessions] = useState<LectureSession[]>([]);
  const [recordings, setRecordings] = useState<LocalRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [loadedSessions, loadedRecordings] = await Promise.all([
        listSessions(),
        listRecordings(),
      ]);
      setSessions(loadedSessions);
      setRecordings(loadedRecordings);
    } catch (unknown) {
      setError(
        unknown instanceof Error
          ? unknown.message
          : "Aufnahmen konnten nicht geladen werden.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Mount-gated initial load from IndexedDB.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const createSession = useCallback(
    async (input: {
      courseId: string | null;
      title: string;
    }): Promise<LectureSession | null> => {
      const now = new Date().toISOString();
      const session: LectureSession = {
        id: createId(),
        courseId: input.courseId,
        title: input.title.trim() === "" ? "Ohne Titel" : input.title.trim(),
        createdAt: now,
        updatedAt: now,
      };

      try {
        await saveSession(session);
        setSessions((current) => [session, ...current]);

        return session;
      } catch (unknown) {
        setError(
          unknown instanceof Error
            ? unknown.message
            : "Sitzung konnte nicht gespeichert werden.",
        );

        return null;
      }
    },
    [],
  );

  const removeSession = useCallback(async (id: string) => {
    try {
      await deleteSession(id);
      setSessions((current) => current.filter((item) => item.id !== id));
    } catch (unknown) {
      setError(
        unknown instanceof Error
          ? unknown.message
          : "Sitzung konnte nicht gelöscht werden.",
      );
    }
  }, []);

  const saveRecording = useCallback(
    async (meta: LocalRecording): Promise<boolean> => {
      try {
        await saveRecordingMeta(meta);
        setRecordings((current) => {
          const next = current.filter((item) => item.id !== meta.id);

          return [meta, ...next].sort((a, b) =>
            b.createdAt.localeCompare(a.createdAt),
          );
        });

        return true;
      } catch (unknown) {
        setError(
          unknown instanceof Error
            ? unknown.message
            : "Aufnahme konnte nicht gespeichert werden.",
        );

        return false;
      }
    },
    [],
  );

  const removeRecording = useCallback(async (id: string) => {
    try {
      await deleteRecordingAll(id);
      setRecordings((current) => current.filter((item) => item.id !== id));
    } catch (unknown) {
      setError(
        unknown instanceof Error
          ? unknown.message
          : "Aufnahme konnte nicht gelöscht werden.",
      );
    }
  }, []);

  return {
    sessions,
    recordings,
    loading,
    error,
    refresh,
    createSession,
    removeSession,
    saveRecording,
    removeRecording,
  };
}

export type { LectureLanguage };
