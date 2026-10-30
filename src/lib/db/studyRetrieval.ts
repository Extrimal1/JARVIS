/**
 * Dual-mode study retrieval for the agent's async reads. Cloud mode
 * queries /api/study/retrieve (owner-scoped Supabase); local mode
 * ranks the IndexedDB chunks with the same scorer — identical
 * ranking, identical result shapes.
 */

import { CLOUD_ENABLED } from "./mode";
import { apiUnknown } from "./useRemoteResource";
import {
  isDocumentMeta,
  listDocuments as localListDocuments,
} from "@/src/lib/documents";
import { listAllChunks } from "@/src/lib/study/localChunks";
import { formatSourceRefs, type SourceRef } from "@/src/lib/study/extract";
import { rankByTerms, tokenizeQuery } from "@/src/lib/study/retrieve";
import {
  excerptOf,
  isRetrieveResponse,
} from "@/src/lib/study/protocol";
import {
  toolError,
  type StudyDocuments,
  type StudyRetrieval,
  type ToolResult,
} from "@/src/lib/assistant/tools";

function failure(message: string): ToolResult<never> {
  return { ok: false, error: toolError("unavailable", message) };
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== ""
    ? error.message
    : fallback;
}

export async function listStudyDocuments(): Promise<
  ToolResult<StudyDocuments>
> {
  try {
    if (!CLOUD_ENABLED) {
      const docs = await localListDocuments();

      return {
        ok: true,
        data: {
          documents: docs.map((doc) => ({
            id: doc.id,
            name: doc.name,
            kind: doc.kind,
            subject: doc.subject,
            extractionStatus: doc.extractionStatus,
          })),
        },
      };
    }

    const result = await apiUnknown("/api/documents", "GET");

    if (!result.ok) return failure(result.error);

    if (!Array.isArray(result.data) || !result.data.every(isDocumentMeta)) {
      return failure("Unerwartete Serverantwort.");
    }

    return {
      ok: true,
      data: {
        documents: result.data.map((doc) => ({
          id: doc.id,
          name: doc.name,
          kind: doc.kind,
          subject: doc.subject,
          extractionStatus: doc.extractionStatus,
        })),
      },
    };
  } catch (error: unknown) {
    return failure(messageOf(error, "Dokumente konnten nicht geladen werden."));
  }
}

export type RetrieveStudyInput = {
  query: string;
  documentId?: string;
  limit?: number;
};

export async function retrieveStudy(
  input: RetrieveStudyInput,
): Promise<ToolResult<StudyRetrieval>> {
  const query = input.query.trim();

  if (query === "" || query.length > 500) {
    return {
      ok: false,
      error: toolError("invalid-input", "Suchanfrage fehlt oder ist zu lang."),
    };
  }

  const limit =
    typeof input.limit === "number" &&
    Number.isInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= 10
      ? input.limit
      : 5;

  try {
    if (!CLOUD_ENABLED) {
      const [stored, docs] = await Promise.all([
        listAllChunks(),
        localListDocuments(),
      ]);
      const names = new Map(docs.map((doc) => [doc.id, doc.name]));
      const candidates: {
        documentId: string;
        index: number;
        text: string;
        refs: SourceRef[];
      }[] = [];

      for (const entry of stored) {
        if (
          input.documentId !== undefined &&
          entry.documentId !== input.documentId
        ) {
          continue;
        }

        for (const chunk of entry.chunks) {
          candidates.push({
            documentId: entry.documentId,
            index: chunk.index,
            text: chunk.text,
            refs: chunk.refs,
          });
        }
      }

      const ranked = rankByTerms(
        candidates,
        (candidate) => candidate.text,
        query,
        limit,
      );

      return {
        ok: true,
        data: {
          sources: ranked.map((entry) => ({
            documentId: entry.item.documentId,
            documentName: names.get(entry.item.documentId) ?? "Dokument",
            refLabel: formatSourceRefs(entry.item.refs),
            text: excerptOf(entry.item.text, 600),
            score: Math.round(entry.score * 100) / 100,
            matchedTerms: entry.matchedTerms,
          })),
          totalCandidates: candidates.length,
          terms: tokenizeQuery(query),
        },
      };
    }

    const result = await apiUnknown("/api/study/retrieve", "POST", {
      query,
      documentId: input.documentId,
      limit,
    });

    if (!result.ok) return failure(result.error);

    if (!isRetrieveResponse(result.data)) {
      return failure("Unerwartete Serverantwort.");
    }

    return {
      ok: true,
      data: {
        sources: result.data.chunks.map((chunk) => ({
          documentId: chunk.documentId,
          documentName: chunk.documentName,
          refLabel: chunk.refLabel,
          text: chunk.text,
          score: chunk.score,
          matchedTerms: chunk.matchedTerms,
        })),
        totalCandidates: result.data.totalCandidates,
        terms: result.data.terms,
      },
    };
  } catch (error: unknown) {
    return failure(messageOf(error, "Suche fehlgeschlagen."));
  }
}
