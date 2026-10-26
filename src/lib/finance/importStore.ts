import { createId } from "@/src/lib/ids";
import {
  parseEuroToCents,
  type Transaction,
} from "@/src/lib/finance";
import type { CategoryCorrection } from "./categories";

/**
 * Import batches, duplicate detection, category-correction persistence,
 * and the IndexedDB blob store for imported PDFs.
 *
 * Deleting a PDF never touches confirmed transactions; deleting a batch
 * removes exactly the transactions that carry its id (the UI confirms).
 */

export type ImportBatchMeta = {
  id: string;
  fileName: string;
  fileSize: number;
  importedAt: string;
  statementMonth: string;
  count: number;
};

export const IMPORT_BATCHES_KEY = "jarvis-finance-import-batches";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isImportBatchMeta(value: unknown): value is ImportBatchMeta {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.fileName === "string" &&
    typeof value.fileSize === "number" &&
    typeof value.importedAt === "string" &&
    typeof value.statementMonth === "string" &&
    typeof value.count === "number"
  );
}

export function isImportBatchMetaList(
  value: unknown,
): value is ImportBatchMeta[] {
  return Array.isArray(value) && value.every(isImportBatchMeta);
}

export const CATEGORY_CORRECTIONS_KEY = "jarvis-finance-category-corrections";

export function isCategoryCorrectionList(
  value: unknown,
): value is CategoryCorrection[] {
  if (!Array.isArray(value)) return false;

  return value.every(
    (item) =>
      isRecord(item) &&
      typeof item.pattern === "string" &&
      typeof item.category === "string" &&
      (item.type === "income" || item.type === "expense"),
  );
}

/** True when an identical file (name + byte size) was already imported. */
export function alreadyImported(
  batches: ImportBatchMeta[],
  fileName: string,
  fileSize: number,
): ImportBatchMeta | null {
  return (
    batches.find(
      (batch) => batch.fileName === fileName && batch.fileSize === fileSize,
    ) ?? null
  );
}

export type CandidateRow = {
  date: string;
  amountCents: number;
  type: Transaction["type"];
  description: string;
};

export type DedupDecision = "new" | "duplicate" | "review";

export function normalizeKey(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]/g, "")
    .slice(0, 80);
}

/**
 * Compares candidates against existing transactions: exact matches
 * (date + amount + type + normalized description) are duplicates;
 * same date + amount + type with a different description needs a
 * human decision; everything else is new.
 */
export function detectDuplicates(
  rows: CandidateRow[],
  existing: Transaction[],
): DedupDecision[] {
  const exact = new Set<string>();
  const fuzzy = new Set<string>();

  for (const transaction of existing) {
    exact.add(
      `${transaction.date}|${transaction.amount}|${transaction.type}|${normalizeKey(transaction.title)}`,
    );
    fuzzy.add(`${transaction.date}|${transaction.amount}|${transaction.type}`);

    if (transaction.originalDescription !== undefined) {
      exact.add(
        `${transaction.date}|${transaction.amount}|${transaction.type}|${normalizeKey(transaction.originalDescription)}`,
      );
    }
  }

  return rows.map((row) => {
    const key = `${row.date}|${row.amountCents}|${row.type}|${normalizeKey(row.description)}`;

    if (exact.has(key)) return "duplicate";
    if (fuzzy.has(`${row.date}|${row.amountCents}|${row.type}`)) {
      return "review";
    }

    return "new";
  });
}

export type ReviewRow = CandidateRow & {
  tempId: string;
  include: boolean;
  amountInput: string;
  currency: string;
  category: string;
  needsReview: boolean;
  reviewReasons: string[];
  duplicate: DedupDecision;
};

/**
 * Converts confirmed review rows into stored transactions. Rows with
 * invalid edits are skipped (never imported with guessed values) and
 * reported through the returned `skipped` count.
 */
export function reviewRowsToTransactions(
  rows: ReviewRow[],
  batchId: string,
): { transactions: Transaction[]; skipped: number } {
  const transactions: Transaction[] = [];
  let skipped = 0;

  for (const row of rows) {
    if (!row.include) continue;

    const cents = parseEuroToCents(row.amountInput);
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(row.date);
    const description = row.description.trim();

    if (cents === null || !dateOk || description === "") {
      skipped += 1;
      continue;
    }

    transactions.push({
      id: createId(),
      title: description,
      amount: cents,
      type: row.type,
      category: row.category === "" ? "Sonstiges" : row.category,
      date: row.date,
      currency: row.currency === "" ? "EUR" : row.currency,
      sourceDocumentId: batchId,
      importStatus: "imported",
    });
  }

  return { transactions, skipped };
}

/** All transactions that belong to one import batch. */
export function batchTransactions(
  transactions: Transaction[],
  batchId: string,
): Transaction[] {
  return transactions.filter(
    (transaction) => transaction.sourceDocumentId === batchId,
  );
}

type PdfRecord = {
  id: string;
  name: string;
  size: number;
  savedAt: string;
  blob: Blob;
};

const PDF_DB_NAME = "jarvis-finance-pdfs";
const PDF_STORE = "pdfs";

function openPdfDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PDF_DB_NAME, 1);

    request.onupgradeneeded = () => {
      request.result.createObjectStore(PDF_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IDB open"));
  });
}

function runPdfRequest<T>(make: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openPdfDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(PDF_STORE, "readwrite");
        const store = tx.objectStore(PDF_STORE);
        let result: T | undefined;

        try {
          const request = make(store);
          request.onsuccess = () => {
            result = request.result;
          };
          request.onerror = () => reject(request.error ?? new Error("IDB"));
        } catch (error) {
          db.close();
          reject(error);
          return;
        }

        tx.oncomplete = () => {
          db.close();
          resolve(result as T);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("IDB tx"));
        };
      }),
  );
}

export async function saveImportPdf(batchId: string, file: File): Promise<void> {
  const record: PdfRecord = {
    id: batchId,
    name: file.name,
    size: file.size,
    savedAt: new Date().toISOString(),
    blob: file.slice(0, file.size, "application/pdf"),
  };

  await runPdfRequest((store) => store.put(record));
}

export async function deleteImportPdf(batchId: string): Promise<void> {
  await runPdfRequest((store) => store.delete(batchId));
}

export async function getImportPdf(
  batchId: string,
): Promise<{ name: string; blob: Blob } | null> {
  const record = await runPdfRequest<PdfRecord | undefined>((store) =>
    store.get(batchId),
  );

  if (record === undefined) return null;

  return { name: record.name, blob: record.blob };
}

export async function listImportPdfs(): Promise<
  { id: string; name: string; size: number }[]
> {
  const records = await runPdfRequest<PdfRecord[]>((store) =>
    store.getAll(),
  );

  return records.map((record) => ({
    id: record.id,
    name: record.name,
    size: record.size,
  }));
}
