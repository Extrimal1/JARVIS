import {
  isSavingsGoal,
  isTransaction,
  type FinanceData,
  type SavingsGoal,
  type Transaction,
} from "@/src/lib/finance";
import {
  isImportBatchMeta,
  type ImportBatchMeta,
} from "@/src/lib/finance/importStore";
import {
  dbDeleteWhere,
  dbGetOne,
  dbList,
  dbUpsert,
  type DbClient,
} from "@/src/lib/supabase/db";
import { deleteObject } from "@/src/lib/supabase/storage";
import { isUuid } from "@/src/lib/ids";
import {
  pickPatch,
  requireUuidId,
  type CheckResult,
  type CrudConfig,
} from "../crud";

// ---------------------------------------------------------------- transactions

function txToDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    title: row.title,
    amount: row.amount_cents,
    type: row.type,
    category: row.category,
    date: row.date,
    note: row.note ?? "",
    currency: row.currency ?? "EUR",
    ...(typeof row.source_batch_id === "string"
      ? { sourceDocumentId: row.source_batch_id }
      : {}),
    importStatus: row.import_status ?? "manual",
    originalDescription: row.original_description ?? "",
  };
}

function txToRow(item: Transaction): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    amount_cents: item.amount,
    type: item.type,
    category: item.category,
    date: item.date,
    note: item.note ?? "",
    currency: item.currency ?? "EUR",
    source_batch_id: item.sourceDocumentId ?? null,
    import_status: item.importStatus ?? "manual",
    original_description: item.originalDescription ?? "",
  };
}

function validCurrency(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{3}$/.test(value);
}

async function batchOwned(
  db: DbClient,
  batchId: string | undefined,
): Promise<boolean> {
  if (batchId === undefined) return true;

  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "finance_import_batches",
    batchId,
  );

  return row !== null;
}

export const transactionsConfig: CrudConfig = {
  table: "finance_transactions",
  order: "date.desc,created_at.desc",
  toDomain: txToDomain,
  isList: (value: unknown): value is unknown[] =>
    Array.isArray(value) && value.every(isTransaction),
  checkCreate: async (db, body) => {
    if (!isTransaction(body)) {
      return { message: "Ungültige Buchung." };
    }

    if (requireUuidId(body) === null) {
      return {
        message:
          "Ungültige Buchungs-ID. Bitte lade die Seite neu und versuche es erneut.",
      };
    }

    if (body.currency !== undefined && !validCurrency(body.currency)) {
      return { message: "Ungültige Währung." };
    }

    // A malformed batch id would fail the uuid lookup below with a
    // Postgres syntax error instead of the intended ownership message.
    if (
      body.sourceDocumentId !== undefined &&
      !isUuid(body.sourceDocumentId)
    ) {
      return { message: "Unbekannter Importstapel." };
    }

    if (!(await batchOwned(db, body.sourceDocumentId))) {
      return { message: "Unbekannter Importstapel." };
    }

    return { row: txToRow(body) };
  },
  checkUpdate: async (db, patch, existing): Promise<CheckResult> => {
    const picked = pickPatch(patch, [
      "title",
      "amount",
      "type",
      "category",
      "date",
      "note",
      "currency",
      "sourceDocumentId",
      "importStatus",
      "originalDescription",
    ]);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isTransaction(merged)) {
      return { message: "Ungültige Änderung." };
    }

    if (
      merged.currency !== undefined &&
      !validCurrency(merged.currency)
    ) {
      return { message: "Ungültige Währung." };
    }

    const item = merged as unknown as Transaction;

    if (!(await batchOwned(db, item.sourceDocumentId))) {
      return { message: "Unbekannter Importstapel." };
    }

    const row = txToRow(item);
    delete row.id;

    return { row };
  },
};

// ------------------------------------------------------------------ doc assembly

export async function getFinanceDoc(db: DbClient): Promise<FinanceData> {
  const [txRows, settingsRows, budgetRows, goalRows] = await Promise.all([
    dbList<Record<string, unknown>>(db, "finance_transactions", {
      order: "date.desc,created_at.desc",
      limit: 5000,
    }),
    dbList<Record<string, unknown>>(db, "finance_settings", { limit: 1 }),
    dbList<Record<string, unknown>>(db, "category_budgets", { limit: 200 }),
    dbList<Record<string, unknown>>(db, "savings_goals", {
      order: "created_at.asc",
      limit: 200,
    }),
  ]);

  const transactions = txRows.map(txToDomain) as Transaction[];
  const categoryBudgets: Record<string, number> = {};

  for (const row of budgetRows) {
    if (typeof row.category === "string" && typeof row.cents === "number") {
      categoryBudgets[row.category] = row.cents;
    }
  }

  return {
    transactions: transactions.filter(isTransaction),
    monthlyBudgetCents:
      typeof settingsRows[0]?.monthly_budget_cents === "number"
        ? (settingsRows[0].monthly_budget_cents as number)
        : 0,
    categoryBudgets,
    goals: goalRows
      .map((row) => ({
        id: row.id,
        title: row.title,
        targetCents: row.target_cents,
        savedCents: row.saved_cents,
      }))
      .filter(
        (
          goal,
        ): goal is FinanceData["goals"][number] =>
          typeof goal.id === "string" &&
          typeof goal.title === "string" &&
          typeof goal.targetCents === "number" &&
          typeof goal.savedCents === "number",
      ),
  };
}

// ------------------------------------------------------------------ settings

export async function saveSettings(
  db: DbClient,
  body: unknown,
): Promise<{ monthlyBudgetCents: number } | { message: string }> {
  if (typeof body !== "object" || body === null) {
    return { message: "Ungültige Anfrage." };
  }

  const cents = (body as Record<string, unknown>).monthlyBudgetCents;

  if (typeof cents !== "number" || !Number.isInteger(cents) || cents < 0) {
    return { message: "Ungültiges Budget." };
  }

  await dbUpsert(db, "finance_settings", [{ monthly_budget_cents: cents }]);

  return { monthlyBudgetCents: cents };
}

// ------------------------------------------------------------------ budgets

export async function saveCategoryBudget(
  db: DbClient,
  body: unknown,
): Promise<{ category: string; cents: number } | { message: string }> {
  if (typeof body !== "object" || body === null) {
    return { message: "Ungültige Anfrage." };
  }

  const record = body as Record<string, unknown>;

  if (
    typeof record.category !== "string" ||
    record.category.trim() === "" ||
    typeof record.cents !== "number" ||
    !Number.isInteger(record.cents) ||
    record.cents < 0
  ) {
    return { message: "Ungültiges Kategoriebudget." };
  }

  await dbUpsert(db, "category_budgets", [
    { category: record.category.trim(), cents: record.cents },
  ]);

  return { category: record.category.trim(), cents: record.cents };
}

export async function deleteCategoryBudget(
  db: DbClient,
  category: string,
): Promise<void> {
  await dbDeleteWhere(db, "category_budgets", [
    `category=eq.${encodeURIComponent(category)}`,
  ]);
}

// ------------------------------------------------------------------ batches

export async function deleteBatchCascade(
  db: DbClient,
  batchId: string,
): Promise<{ deletedTransactions: number }> {
  const batch = await dbGetOne<Record<string, unknown>>(
    db,
    "finance_import_batches",
    batchId,
  );

  if (batch === null) {
    return { deletedTransactions: 0 };
  }

  const linked = await dbList<{ id: string }>(db, "finance_transactions", {
    select: "id",
    filters: [`source_batch_id=eq.${encodeURIComponent(batchId)}`],
    limit: 5000,
  });

  await dbDeleteWhere(db, "finance_transactions", [
    `source_batch_id=eq.${encodeURIComponent(batchId)}`,
  ]);

  if (typeof batch.storage_path === "string" && batch.storage_path !== "") {
    try {
      await deleteObject(db, "finance-statements", batch.storage_path);
    } catch {
      // Metadata deletion wins; orphaned objects are listed for cleanup.
    }
  }

  await dbDeleteWhere(db, "finance_import_batches", [
    `id=eq.${encodeURIComponent(batchId)}`,
  ]);

  return { deletedTransactions: linked.length };
}

// ------------------------------------------------------------------ corrections

export type CorrectionInput = {
  pattern: string;
  category: string;
  type: "income" | "expense";
};

export function validCorrections(
  body: unknown,
): CorrectionInput[] | null {
  const items = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).items
      : null;

  if (!Array.isArray(items) || items.length > 200) return null;

  const out: CorrectionInput[] = [];

  for (const item of items) {
    if (typeof item !== "object" || item === null) return null;

    const record = item as Record<string, unknown>;

    if (
      typeof record.pattern !== "string" ||
      record.pattern.trim() === "" ||
      typeof record.category !== "string" ||
      record.category.trim() === "" ||
      (record.type !== "income" && record.type !== "expense")
    ) {
      return null;
    }

    out.push({
      pattern: record.pattern.trim(),
      category: record.category.trim(),
      type: record.type,
    });
  }

  return out;
}

export async function saveCorrections(
  db: DbClient,
  items: CorrectionInput[],
): Promise<void> {
  if (items.length === 0) return;

  await dbUpsert(
    db,
    "finance_category_corrections",
    items.map((item) => ({ ...item })),
  );
}

export async function listCorrections(
  db: DbClient,
): Promise<CorrectionInput[]> {
  const rows = await dbList<Record<string, unknown>>(
    db,
    "finance_category_corrections",
    { limit: 500 },
  );

  return rows
    .filter(
      (row) =>
        typeof row.pattern === "string" &&
        typeof row.category === "string" &&
        (row.type === "income" || row.type === "expense"),
    )
    .map((row) => ({
      pattern: row.pattern as string,
      category: row.category as string,
      type: row.type as "income" | "expense",
    }));
}

// ------------------------------------------------------------------ goals

function goalToDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    title: row.title,
    targetCents: row.target_cents,
    savedCents: row.saved_cents,
  };
}

function goalToRow(item: SavingsGoal): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    target_cents: item.targetCents,
    saved_cents: item.savedCents,
  };
}

export const goalsConfig: CrudConfig = {
  table: "savings_goals",
  order: "created_at.asc",
  toDomain: goalToDomain,
  isList: (value: unknown): value is unknown[] =>
    Array.isArray(value) && value.every(isSavingsGoal),
  checkCreate: (_db, body) => {
    if (!isSavingsGoal(body)) {
      return { message: "Ungültiges Sparziel." };
    }

    if (requireUuidId(body) === null) {
      return {
        message:
          "Ungültige Sparziel-ID. Bitte lade die Seite neu und versuche es erneut.",
      };
    }

    return { row: goalToRow(body) };
  },
  checkUpdate: (_db, patch, existing): CheckResult => {
    const picked = pickPatch(patch, ["title", "targetCents", "savedCents"]);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    };

    if (!isSavingsGoal(merged)) {
      return { message: "Ungültige Änderung." };
    }

    const row = goalToRow(merged as unknown as SavingsGoal);
    delete row.id;

    return { row };
  },
};

// ------------------------------------------------------------------ batches

function batchToDomain(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    fileName: row.file_name,
    fileSize: typeof row.file_size === "number" ? row.file_size : 0,
    importedAt: row.imported_at,
    statementMonth: row.statement_month ?? "",
    count: typeof row.count === "number" ? row.count : 0,
  };
}

export const batchesConfig: CrudConfig = {
  table: "finance_import_batches",
  order: "imported_at.desc",
  toDomain: batchToDomain,
  isList: (value: unknown): value is unknown[] =>
    Array.isArray(value) && value.every(isImportBatchMeta),
  checkCreate: (_db, body) => {
    if (typeof body !== "object" || body === null) {
      return { message: "Ungültiger Importstapel." };
    }

    const record = body as Record<string, unknown>;

    if (
      requireUuidId(body) === null ||
      typeof record.fileName !== "string" ||
      record.fileName === "" ||
      typeof record.fileSize !== "number" ||
      typeof record.statementMonth !== "string" ||
      typeof record.count !== "number"
    ) {
      return { message: "Ungültiger Importstapel." };
    }

    return {
      row: {
        id: record.id,
        file_name: record.fileName,
        file_size: record.fileSize,
        statement_month: record.statementMonth,
        count: record.count,
        storage_path:
          typeof record.storagePath === "string" ? record.storagePath : "",
      },
    };
  },
  checkUpdate: (_db, patch, existing): CheckResult => {
    const picked = pickPatch(patch, ["count", "storagePath"]);

    if (picked === null) {
      return { message: "Ungültige Änderung." };
    }

    const merged = {
      ...(existing as Record<string, unknown>),
      ...picked,
    } as unknown as ImportBatchMeta;

    if (!isImportBatchMeta(merged)) {
      return { message: "Ungültige Änderung." };
    }

    const row: Record<string, unknown> = {};

    if (typeof picked.count === "number") row.count = picked.count;
    if (typeof picked.storagePath === "string") {
      row.storage_path = picked.storagePath;
    }

    return { row };
  },
};
