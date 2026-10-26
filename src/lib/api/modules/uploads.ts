import { MAX_PDF_SIZE_BYTES } from "@/src/lib/finance/pdf";
import type { ImportBatchMeta } from "@/src/lib/finance/importStore";
import {
  dbGetOne,
  dbInsert,
  dbUpdate,
  type DbClient,
} from "@/src/lib/supabase/db";
import {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  deleteObject,
  ownerPath,
} from "@/src/lib/supabase/storage";
import { sanitizeFileName } from "./documents";

/**
 * Bank-statement uploads (private Storage) + bulk transaction import.
 * Parsing still happens client-side (existing pdf.ts); the server only
 * validates, stores bytes privately, and persists confirmed rows.
 */

export const FINANCE_BUCKET = "finance-statements";
export const MAX_BULK_ITEMS = 2000;

export type StatementUploadInput = {
  id: string;
  fileName: string;
  fileSize: number;
  statementMonth: string;
  count: number;
};

export function validStatementUpload(body: unknown): StatementUploadInput | null {
  if (typeof body !== "object" || body === null) return null;

  const record = body as Record<string, unknown>;

  if (
    typeof record.id !== "string" ||
    record.id.trim() === "" ||
    typeof record.fileName !== "string" ||
    !record.fileName.toLowerCase().endsWith(".pdf") ||
    typeof record.fileSize !== "number" ||
    !Number.isInteger(record.fileSize) ||
    record.fileSize <= 0 ||
    record.fileSize > MAX_PDF_SIZE_BYTES ||
    typeof record.statementMonth !== "string" ||
    !/^\d{4}-\d{2}$/.test(record.statementMonth) ||
    typeof record.count !== "number" ||
    !Number.isInteger(record.count) ||
    record.count < 0
  ) {
    return null;
  }

  return {
    id: record.id,
    fileName: record.fileName,
    fileSize: record.fileSize,
    statementMonth: record.statementMonth,
    count: record.count,
  };
}

export async function createStatementUpload(
  db: DbClient,
  userId: string,
  input: StatementUploadInput,
): Promise<{ batch: ImportBatchMeta; uploadUrl: string }> {
  const storagePath = ownerPath(
    userId,
    `${input.id}/${sanitizeFileName(input.fileName)}`,
  );

  const rows = await dbInsert<Record<string, unknown>>(
    db,
    "finance_import_batches",
    [
      {
        id: input.id,
        file_name: input.fileName,
        file_size: input.fileSize,
        statement_month: input.statementMonth,
        count: input.count,
        storage_path: storagePath,
      },
    ],
  );
  const first = rows[0];

  if (first === undefined) {
    throw new Error("INSERT_EMPTY:finance_import_batches");
  }

  const { signedUrl } = await createSignedUploadUrl(
    db,
    FINANCE_BUCKET,
    storagePath,
  );

  return {
    batch: {
      id: input.id,
      fileName: input.fileName,
      fileSize: input.fileSize,
      importedAt:
        typeof first.imported_at === "string"
          ? first.imported_at
          : new Date().toISOString(),
      statementMonth: input.statementMonth,
      count: input.count,
    },
    uploadUrl: signedUrl,
  };
}

export async function downloadBatchFile(
  db: DbClient,
  batchId: string,
): Promise<string | null> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "finance_import_batches",
    batchId,
  );

  if (
    row === null ||
    typeof row.storage_path !== "string" ||
    row.storage_path === ""
  ) {
    return null;
  }

  return createSignedDownloadUrl(db, FINANCE_BUCKET, row.storage_path, 600);
}

export async function deleteBatchFile(
  db: DbClient,
  batchId: string,
): Promise<boolean> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "finance_import_batches",
    batchId,
  );

  if (row === null) return false;

  if (typeof row.storage_path === "string" && row.storage_path !== "") {
    try {
      await deleteObject(db, FINANCE_BUCKET, row.storage_path);
    } catch {
      // Keep going: the metadata link is removed regardless.
    }
  }

  await dbUpdate(db, "finance_import_batches", batchId, { storage_path: "" });

  return true;
}
