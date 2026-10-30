/**
 * Local-mode chunk persistence: one record per document in the
 * IndexedDB `chunks` store (see `src/lib/documents.ts`). Same shape
 * as the cloud `retrieval_chunks` rows so both modes retrieve and
 * cite identically.
 */

import {
  CHUNKS_STORE,
  isIndexedDBAvailable,
  openDatabase,
  requestToPromise,
  transactionToPromise,
} from "@/src/lib/documents";
import { isSourceRef, type SourceRef } from "./extract";

export type StoredChunk = {
  index: number;
  text: string;
  refs: SourceRef[];
  tokenCount: number;
};

export function isStoredChunk(value: unknown): value is StoredChunk {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.index === "number" &&
    Number.isInteger(record.index) &&
    record.index >= 0 &&
    typeof record.text === "string" &&
    Array.isArray(record.refs) &&
    record.refs.every(isSourceRef) &&
    typeof record.tokenCount === "number" &&
    Number.isInteger(record.tokenCount) &&
    record.tokenCount >= 0
  );
}

function isChunkRecord(value: unknown): value is {
  id: string;
  chunks: StoredChunk[];
} {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    Array.isArray(record.chunks) &&
    record.chunks.every(isStoredChunk)
  );
}

export function requireIndexedDB(): void {
  if (!isIndexedDBAvailable()) {
    throw new Error("IndexedDB ist in diesem Browser nicht verfügbar.");
  }
}

/** Replaces the chunk list of one document (re-process safe). */
export async function saveDocumentChunks(
  id: string,
  chunks: StoredChunk[],
): Promise<void> {
  requireIndexedDB();

  const db = await openDatabase();

  try {
    const transaction = db.transaction(CHUNKS_STORE, "readwrite");
    transaction.objectStore(CHUNKS_STORE).put({ id, chunks });
    await transactionToPromise(
      transaction,
      "Textabschnitte konnten nicht gespeichert werden.",
    );
  } finally {
    db.close();
  }
}

/** Chunks of one document; null when never processed. */
export async function getDocumentChunks(
  id: string,
): Promise<StoredChunk[] | null> {
  requireIndexedDB();

  const db = await openDatabase();

  try {
    const transaction = db.transaction(CHUNKS_STORE, "readonly");
    const record = await requestToPromise<unknown>(
      transaction.objectStore(CHUNKS_STORE).get(id),
      "Textabschnitte konnten nicht geladen werden.",
    );

    if (record === undefined || record === null) return null;

    if (!isChunkRecord(record)) {
      console.warn("Ungültiger Textabschnitt-Eintrag übersprungen.");

      return null;
    }

    return record.chunks;
  } finally {
    db.close();
  }
}

/** Every stored chunk list (retrieval scans these, then ranks). */
export async function listAllChunks(): Promise<
  { documentId: string; chunks: StoredChunk[] }[]
> {
  requireIndexedDB();

  const db = await openDatabase();

  try {
    const transaction = db.transaction(CHUNKS_STORE, "readonly");
    const records = await requestToPromise<unknown[]>(
      transaction.objectStore(CHUNKS_STORE).getAll(),
      "Textabschnitte konnten nicht geladen werden.",
    );
    const valid: { documentId: string; chunks: StoredChunk[] }[] = [];

    for (const record of records) {
      if (isChunkRecord(record)) {
        valid.push({ documentId: record.id, chunks: record.chunks });
      } else {
        console.warn("Ungültiger Textabschnitt-Eintrag übersprungen.");
      }
    }

    return valid;
  } finally {
    db.close();
  }
}
