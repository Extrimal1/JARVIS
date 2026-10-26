/**
 * IndexedDB persistence for lecture audio (local-first).
 * - `sessions`: lecture session metadata (keyPath id).
 * - `recordings`: recording metadata (keyPath id).
 * - `chunks`: incremental MediaRecorder chunks, key `${recordingId}:${index}`.
 * - `audio`: finalized audio blobs (keyPath id).
 *
 * Chunks are written every few seconds while recording so an interrupted
 * recording (crash, closed tab) can be recovered from its chunks.
 */

import {
  isLectureSessionList,
  isLocalRecordingList,
  type LectureSession,
  type LocalRecording,
} from "./types";

const DB_NAME = "jarvis-lecture";
const DB_VERSION = 1;

function unavailable(): Error {
  return new Error("IndexedDB ist in diesem Browser nicht verfügbar.");
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(unavailable());
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("recordings")) {
        db.createObjectStore("recordings", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("chunks")) {
        db.createObjectStore("chunks", { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains("audio")) {
        db.createObjectStore("audio", { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB konnte nicht geöffnet werden."));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB-Zugriff fehlgeschlagen."));
  });
}

async function writeStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();

  try {
    const tx = db.transaction(store, mode);

    return await requestToPromise(run(tx.objectStore(store)));
  } finally {
    db.close();
  }
}

async function readAll(store: string): Promise<unknown[]> {
  const db = await openDb();

  try {
    const tx = db.transaction(store, "readonly");
    const result = await requestToPromise<unknown[]>(
      tx.objectStore(store).getAll() as IDBRequest<unknown[]>,
    );

    return result;
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ sessions

export async function listSessions(): Promise<LectureSession[]> {
  const rows = await readAll("sessions");

  if (!isLectureSessionList(rows)) return [];

  return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveSession(session: LectureSession): Promise<void> {
  await writeStore("sessions", "readwrite", (objectStore) =>
    objectStore.put(session),
  );
}

export async function deleteSession(id: string): Promise<void> {
  await writeStore("sessions", "readwrite", (objectStore) =>
    objectStore.delete(id),
  );
}

// ---------------------------------------------------------------- recordings

export async function listRecordings(): Promise<LocalRecording[]> {
  const rows = await readAll("recordings");

  if (!isLocalRecordingList(rows)) return [];

  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function saveRecordingMeta(meta: LocalRecording): Promise<void> {
  await writeStore("recordings", "readwrite", (objectStore) =>
    objectStore.put(meta),
  );
}

export async function deleteRecordingMeta(id: string): Promise<void> {
  await writeStore("recordings", "readwrite", (objectStore) =>
    objectStore.delete(id),
  );
}

// -------------------------------------------------------------------- chunks

type ChunkRow = { key: string; recordingId: string; index: number; blob: Blob };

function chunkKey(recordingId: string, index: number): string {
  return `${recordingId}:${String(index).padStart(6, "0")}`;
}

export async function appendChunk(
  recordingId: string,
  index: number,
  blob: Blob,
): Promise<void> {
  const row: ChunkRow = {
    key: chunkKey(recordingId, index),
    recordingId,
    index,
    blob,
  };

  await writeStore("chunks", "readwrite", (objectStore) =>
    objectStore.put(row),
  );
}

export async function listChunks(recordingId: string): Promise<Blob[]> {
  const rows = (await readAll("chunks")) as ChunkRow[];

  return rows
    .filter(
      (row): row is ChunkRow =>
        typeof row === "object" &&
        row !== null &&
        row.recordingId === recordingId &&
        row.blob instanceof Blob,
    )
    .sort((a, b) => a.index - b.index)
    .map((row) => row.blob);
}

export async function clearChunks(recordingId: string): Promise<void> {
  const db = await openDb();

  try {
    const tx = db.transaction("chunks", "readwrite");
    const store = tx.objectStore("chunks");
    const rows = await requestToPromise<ChunkRow[]>(
      store.getAll() as IDBRequest<ChunkRow[]>,
    );

    for (const row of rows) {
      if (row.recordingId === recordingId) {
        store.delete(row.key);
      }
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? unavailable());
    });
  } finally {
    db.close();
  }
}

// --------------------------------------------------------------------- audio

export async function saveAudio(id: string, blob: Blob): Promise<void> {
  await writeStore("audio", "readwrite", (objectStore) =>
    objectStore.put({ id, blob }),
  );
}

export async function getAudio(id: string): Promise<Blob | null> {
  const db = await openDb();

  try {
    const tx = db.transaction("audio", "readonly");
    const row = await requestToPromise<{ id: string; blob: Blob } | undefined>(
      tx.objectStore("audio").get(id) as IDBRequest<
        { id: string; blob: Blob } | undefined
      >,
    );

    if (row === undefined || !(row.blob instanceof Blob)) return null;

    return row.blob;
  } finally {
    db.close();
  }
}

export async function deleteAudio(id: string): Promise<void> {
  await writeStore("audio", "readwrite", (objectStore) =>
    objectStore.delete(id),
  );
}

/** Remove metadata, chunks, and audio for one recording. */
export async function deleteRecordingAll(id: string): Promise<void> {
  await deleteRecordingMeta(id);
  await clearChunks(id).catch(() => undefined);
  await deleteAudio(id).catch(() => undefined);
}
