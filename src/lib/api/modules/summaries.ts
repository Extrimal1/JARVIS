/**
 * Document summaries: row mapping + CRUD config over
 * `study_summaries` (see migration 0009). One row per document:
 * the active summary plus at most one draft generation. All
 * generation writes go through the batch/synthesize services
 * (server-validated resume); these routes serve reads and shape
 * validation. Draft/active promotion stays atomic single-row.
 */

import type { CrudConfig } from "@/src/lib/api/crud";
import { pickPatch, requireUuidId } from "@/src/lib/api/crud";
import { dbGetOne, type DbClient } from "@/src/lib/supabase/db";
import {
  isDocumentSummary,
  isSummaryRecord,
  isSummaryRecordList,
  type SummaryRecord,
  type SummarySpanPlan,
  type SummarySpanResult,
} from "@/src/lib/study/protocol";

function isSpanPlanList(value: unknown): value is SummarySpanPlan[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).key === "string" &&
        typeof (entry as Record<string, unknown>).label === "string" &&
        typeof (entry as Record<string, unknown>).order === "number",
    )
  );
}

function isSpanResultList(value: unknown): value is SummarySpanResult[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).key === "string" &&
        typeof (entry as Record<string, unknown>).label === "string" &&
        typeof (entry as Record<string, unknown>).text === "string" &&
        Array.isArray((entry as Record<string, unknown>).refs) &&
        typeof (entry as Record<string, unknown>).completedAt === "string",
    )
  );
}

function isLabelList(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isSplitMap(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((depth) => typeof depth === "number");
}

export function summaryRowToDomain(row: Record<string, unknown>): unknown {
  const hasActive =
    typeof row.active_final_md === "string" && row.active_final_md !== "";
  const hasDraft = typeof row.draft_generation_id === "string";

  return {
    id: row.id,
    documentId: row.document_id,
    status: hasActive ? "complete" : "partial",
    active: !hasActive
      ? null
      : {
          text: row.active_final_md,
          refs: isLabelList(row.active_final_refs)
            ? row.active_final_refs
            : [],
          completedAt:
            typeof row.active_completed_at === "string"
              ? row.active_completed_at
              : "",
        },
    draft: !hasDraft
      ? null
      : {
          generationId: row.draft_generation_id,
          plannedSpans: isSpanPlanList(row.draft_planned)
            ? row.draft_planned
            : [],
          spans: isSpanResultList(row.draft_spans) ? row.draft_spans : [],
          splits: isSplitMap(row.draft_splits) ? row.draft_splits : {},
          preview:
            typeof row.draft_preview_md === "string" &&
            row.draft_preview_md !== ""
              ? {
                  text: row.draft_preview_md,
                  refs: isLabelList(row.draft_preview_refs)
                    ? row.draft_preview_refs
                    : [],
                }
              : null,
          startedAt:
            typeof row.draft_started_at === "string"
              ? row.draft_started_at
              : "",
        },
  };
}

export function summaryToDbRow(item: SummaryRecord): Record<string, unknown> {
  return {
    id: item.id,
    document_id: item.documentId,
    status: item.status === "complete" ? "complete" : "partial",
    active_final_md: item.active?.text ?? "",
    active_final_refs: item.active?.refs ?? [],
    active_completed_at: item.active?.completedAt ?? null,
    draft_generation_id: item.draft?.generationId ?? null,
    draft_planned: item.draft?.plannedSpans ?? [],
    draft_spans: item.draft?.spans ?? [],
    draft_splits: item.draft?.splits ?? {},
    draft_preview_md: item.draft?.preview?.text ?? "",
    draft_preview_refs: item.draft?.preview?.refs ?? [],
    draft_started_at: item.draft?.startedAt ?? null,
  };
}

async function ownsDocument(
  db: DbClient,
  documentId: string,
): Promise<boolean> {
  const doc = await dbGetOne<Record<string, unknown>>(
    db,
    "study_documents",
    documentId,
  );

  return doc !== null;
}

export const summariesConfig: CrudConfig = {
  table: "study_summaries",
  order: "updated_at.desc",
  toDomain: summaryRowToDomain,
  isList: isSummaryRecordList,
  checkCreate: async (db, body) => {
    if (!isDocumentSummary(body) || requireUuidId(body) === null) {
      return { message: "Ungültige Zusammenfassung." };
    }

    const item = body as SummaryRecord;

    if (item.draft === null && item.active === null) {
      return { message: "Ungültige Zusammenfassung." };
    }

    if (!(await ownsDocument(db, item.documentId))) {
      return { message: "Dokument nicht gefunden." };
    }

    return { row: summaryToDbRow(item) };
  },
  checkUpdate: async (db, patch, existing) => {
    const picked = pickPatch(patch, [
      "status",
      "active",
      "draft",
    ]);

    if (picked === null || !isSummaryRecord(existing)) {
      return { message: "Ungültige Zusammenfassung." };
    }

    const merged: SummaryRecord = {
      ...(existing as SummaryRecord),
      ...picked,
    } as SummaryRecord;

    if (!isSummaryRecord(merged)) {
      return { message: "Ungültige Zusammenfassung." };
    }

    if (
      merged.documentId !== (existing as SummaryRecord).documentId ||
      !(await ownsDocument(db, merged.documentId))
    ) {
      return { message: "Dokument nicht gefunden." };
    }

    const row = summaryToDbRow(merged);
    delete row.id;
    delete row.document_id;

    return { row };
  },
};
