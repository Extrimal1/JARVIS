import { CLOUD_ENABLED } from "./mode";
import { apiBytes, apiUnknown } from "./useRemoteResource";
import {
  deleteDocument as localDeleteDocument,
  getDocumentBlob as localGetBlob,
  getDocumentText as localGetText,
  isDocumentMeta,
  listDocuments as localListDocuments,
  saveDocument as localSaveDocument,
  saveDocumentText as localSaveText,
  updateDocumentMeta as localUpdateMeta,
  type DocumentMeta,
} from "@/src/lib/documents";

/**
 * Document storage with identical signatures in both modes. Local mode
 * uses IndexedDB (existing implementation); cloud mode stores metadata
 * in Postgres and bytes in private Storage via signed URLs.
 */

type MetaPatch = Partial<
  Pick<DocumentMeta, "subject" | "description" | "extractionStatus">
>;

export async function listDocuments(): Promise<DocumentMeta[]> {
  if (!CLOUD_ENABLED) {
    return localListDocuments();
  }

  const result = await apiUnknown("/api/documents", "GET");

  if (!result.ok) {
    throw new Error(result.error);
  }

  if (!Array.isArray(result.data) || !result.data.every(isDocumentMeta)) {
    throw new Error("Unerwartete Serverantwort.");
  }

  return [...result.data].sort((a, b) =>
    b.uploadedAt.localeCompare(a.uploadedAt),
  );
}

export async function saveDocument(
  meta: DocumentMeta,
  blob: Blob,
): Promise<void> {
  if (!CLOUD_ENABLED) {
    return localSaveDocument(meta, blob);
  }

  const created = await apiUnknown("/api/documents", "POST", {
    id: meta.id,
    name: meta.name,
    mime: meta.mimeType,
    size: meta.size,
    subject: meta.subject,
    description: meta.description,
  });

  if (!created.ok) {
    throw new Error(created.error);
  }

  const { uploadUrl } = created.data as { uploadUrl?: unknown };

  if (typeof uploadUrl !== "string") {
    throw new Error("Unerwartete Serverantwort.");
  }

  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": meta.mimeType },
    body: blob,
  });

  if (!res.ok) {
    await apiUnknown(
      `/api/documents/${encodeURIComponent(meta.id)}`,
      "DELETE",
    );
    throw new Error("Upload fehlgeschlagen.");
  }
}

export async function updateDocumentMeta(
  id: string,
  patch: MetaPatch,
): Promise<DocumentMeta | null> {
  if (!CLOUD_ENABLED) {
    return localUpdateMeta(id, patch);
  }

  const result = await apiUnknown(
    `/api/documents/${encodeURIComponent(id)}`,
    "PATCH",
    patch,
  );

  if (!result.ok) {
    throw new Error(result.error);
  }

  return isDocumentMeta(result.data) ? result.data : null;
}

export async function deleteDocument(id: string): Promise<void> {
  if (!CLOUD_ENABLED) {
    return localDeleteDocument(id);
  }

  const result = await apiUnknown(
    `/api/documents/${encodeURIComponent(id)}`,
    "DELETE",
  );

  if (!result.ok) {
    throw new Error(result.error);
  }
}

export async function saveDocumentText(
  id: string,
  text: string,
): Promise<void> {
  if (!CLOUD_ENABLED) {
    return localSaveText(id, text);
  }

  const completed = await apiUnknown(
    `/api/documents/${encodeURIComponent(id)}/complete`,
    "POST",
    { hasText: true },
  );

  if (!completed.ok) {
    throw new Error(completed.error);
  }

  const { textUploadUrl } = completed.data as { textUploadUrl?: unknown };

  if (typeof textUploadUrl !== "string") {
    throw new Error("Unerwartete Serverantwort.");
  }

  const res = await fetch(textUploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: text,
  });

  if (!res.ok) {
    throw new Error("Text-Upload fehlgeschlagen.");
  }

  await updateDocumentMeta(id, { extractionStatus: "completed" });
}

export async function getDocumentBlob(id: string): Promise<Blob | null> {
  if (!CLOUD_ENABLED) {
    return localGetBlob(id);
  }

  const result = await apiBytes(
    `/api/documents/${encodeURIComponent(id)}/download`,
  );

  if (!result.ok) {
    // 404 means genuinely missing (never uploaded / deleted); every
    // other failure carries the server's message and must surface.
    if (result.status === 404) return null;

    throw new Error(result.error);
  }

  if (result.blob.size === 0) return null;

  // Re-wrap with the server's Content-Type so a mislabeled upload
  // can never change how the bytes are interpreted downstream.
  const type = result.contentType.split(";")[0]?.trim() ?? "";

  return type === ""
    ? result.blob
    : new Blob([result.blob], { type });
}

export async function getDocumentText(id: string): Promise<string | null> {
  if (!CLOUD_ENABLED) {
    return localGetText(id);
  }

  const result = await apiBytes(
    `/api/documents/${encodeURIComponent(id)}/download?variant=text`,
  );

  if (!result.ok) {
    // 404 means "no extracted text yet" (or doc gone): callers fall
    // back to the file blob instead of failing the preview.
    if (result.status === 404) return null;

    throw new Error(result.error);
  }

  return result.blob.text();
}

export {
  EXTRACTION_STATUS_LABELS,
  KIND_LABELS,
  MAX_FILE_SIZE,
  createDocumentId,
  extractText,
  formatBytes,
  formatUploadDate,
  initialExtractionStatus,
  isDocumentMeta,
  isIndexedDBAvailable,
  validateFile,
  type DocumentKind,
  type DocumentMeta,
  type ExtractionStatus,
} from "@/src/lib/documents";
