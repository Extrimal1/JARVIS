/**
 * Local-mode summary persistence: one draft/active record per
 * document in the IndexedDB `summaries` store. Same domain shape
 * as the cloud `study_summaries` rows so both modes resume and
 * promote identically.
 */

import {
  SUMMARIES_STORE,
  openDatabase,
  requestToPromise,
  transactionToPromise,
} from "@/src/lib/documents";
import { requireIndexedDB } from "./localChunks";
import {
  isDocumentSummary,
  type DocumentSummary,
} from "@/src/lib/study/protocol";

function isSummaryRecord(value: unknown): value is {
  id: string;
  summary: DocumentSummary;
} {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    isDocumentSummary(record.summary)
  );
}

/** Replaces the summary record of one document. */
export async function saveDocumentSummary(
  id: string,
  summary: DocumentSummary,
): Promise<void> {
  requireIndexedDB();

  const db = await openDatabase();

  try {
    const transaction = db.transaction(SUMMARIES_STORE, "readwrite");
    transaction.objectStore(SUMMARIES_STORE).put({ id, summary });
    await transactionToPromise(
      transaction,
      "Zusammenfassung konnte nicht gespeichert werden.",
    );
  } finally {
    db.close();
  }
}

/** Summary record of one document; null when never summarized. */
export async function getDocumentSummary(
  id: string,
): Promise<DocumentSummary | null> {
  requireIndexedDB();

  const db = await openDatabase();

  try {
    const transaction = db.transaction(SUMMARIES_STORE, "readonly");
    const record = await requestToPromise<unknown>(
      transaction.objectStore(SUMMARIES_STORE).get(id),
      "Zusammenfassung konnte nicht geladen werden.",
    );

    if (record === undefined || record === null) return null;

    if (!isSummaryRecord(record)) {
      console.warn("Ungültiger Zusammenfassungs-Eintrag übersprungen.");

      return null;
    }

    return record.summary;
  } finally {
    db.close();
  }
}
