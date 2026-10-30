import {
  initialExtractionStatus,
  isDocumentMeta,
  MAX_FILE_SIZE,
  type DocumentKind,
  type DocumentMeta,
} from "@/src/lib/documents";
import {
  dbDeleteWhere,
  dbGetOne,
  dbInsert,
  dbList,
  dbUpdate,
  type DbClient,
} from "@/src/lib/supabase/db";
import { SupabaseHttpError } from "@/src/lib/supabase/supabase";
import {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  deleteObject,
  ownerPath,
} from "@/src/lib/supabase/storage";

/**
 * Study-document metadata (Postgres) + blobs (private Storage).
 * Large bytes always travel browser↔Storage via signed URLs; the API
 * only mints URLs after verifying ownership.
 */

export const STUDY_BUCKET = "study-documents";

const KIND_MIMES: Record<DocumentKind, string[]> = {
  pdf: ["application/pdf"],
  docx: [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  pptx: [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  txt: ["text/plain"],
  md: ["text/markdown", "text/plain"],
};

const KIND_EXTENSIONS: Record<DocumentKind, string[]> = {
  pdf: ["pdf"],
  docx: ["docx"],
  pptx: ["pptx"],
  txt: ["txt"],
  md: ["md", "markdown", "txt"],
};

export function sanitizeFileName(name: string): string {
  const base = name.split("/").pop() ?? "datei";

  return (
    base.replace(/[^a-zA-Z0-9äöüÄÖÜß._-]+/g, "_").slice(0, 180) || "datei"
  );
}

function detectKind(name: string, mime: string): DocumentKind | null {
  const ext = (name.split(".").pop() ?? "").toLowerCase();

  for (const kind of ["pdf", "docx", "pptx", "txt", "md"] as const) {
    if (
      KIND_EXTENSIONS[kind].includes(ext) &&
      (KIND_MIMES[kind].includes(mime) || mime === "application/octet-stream")
    ) {
      return kind;
    }
  }

  return null;
}

function rowToMeta(row: Record<string, unknown>): unknown {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime ?? "",
    size: row.size ?? 0,
    kind: row.kind,
    subject:
      typeof row.subject === "string" && row.subject !== ""
        ? row.subject
        : null,
    description: row.description ?? "",
    uploadedAt: row.uploaded_at,
    extractionStatus: row.extraction_status ?? "not_processed",
  };
}

export async function listStudyDocs(
  db: DbClient,
): Promise<DocumentMeta[]> {
  const rows = await dbList<Record<string, unknown>>(db, "study_documents", {
    order: "uploaded_at.desc",
    limit: 1000,
  });

  return rows.map(rowToMeta).filter(isDocumentMeta);
}

export type CreateDocInput = {
  id: string;
  name: string;
  mime: string;
  size: number;
  subject: string | null;
  description: string;
};

export function validCreateDoc(body: unknown): CreateDocInput | null {
  if (typeof body !== "object" || body === null) return null;

  const record = body as Record<string, unknown>;

  if (
    typeof record.id !== "string" ||
    record.id.trim() === "" ||
    typeof record.name !== "string" ||
    record.name.trim() === "" ||
    record.name.length > 255 ||
    typeof record.mime !== "string" ||
    typeof record.size !== "number" ||
    !Number.isInteger(record.size) ||
    record.size <= 0 ||
    record.size > MAX_FILE_SIZE ||
    (record.subject !== null &&
      record.subject !== undefined &&
      typeof record.subject !== "string") ||
    (record.description !== undefined &&
      typeof record.description !== "string")
  ) {
    return null;
  }

  if (detectKind(record.name, record.mime) === null) {
    return null;
  }

  return {
    id: record.id,
    name: record.name,
    mime: record.mime,
    size: record.size,
    subject:
      typeof record.subject === "string" && record.subject !== ""
        ? record.subject
        : null,
    description:
      typeof record.description === "string" ? record.description : "",
  };
}

export async function createStudyDoc(
  db: DbClient,
  userId: string,
  input: CreateDocInput,
): Promise<{ doc: DocumentMeta; uploadUrl: string }> {
  const kind = detectKind(input.name, input.mime);

  if (kind === null) {
    throw new Error("UNSUPPORTED_KIND");
  }

  const safeName = sanitizeFileName(input.name);
  const storagePath = ownerPath(userId, `${input.id}/${safeName}`);

  // Mint first: URL issuance is stateless, so a mint failure leaves no
  // orphan row behind (the client cannot clean up after a failed POST).
  const { signedUrl } = await createSignedUploadUrl(
    db,
    STUDY_BUCKET,
    storagePath,
  );

  const rows = await dbInsert<Record<string, unknown>>(
    db,
    "study_documents",
    [
      {
        id: input.id,
        name: input.name,
        mime: input.mime,
        size: input.size,
        kind,
        subject: input.subject,
        description: input.description,
        extraction_status: initialExtractionStatus(),
        storage_path: storagePath,
        text_path: "",
      },
    ],
  );
  const first = rows[0];

  if (first === undefined || !isDocumentMeta(rowToMeta(first))) {
    throw new Error("INSERT_EMPTY:study_documents");
  }

  return { doc: rowToMeta(first) as DocumentMeta, uploadUrl: signedUrl };
}

/** Confirm a TXT/MD text object; returns its signed upload URL. */
export async function completeStudyDocText(
  db: DbClient,
  userId: string,
  id: string,
): Promise<{ textUploadUrl: string } | null> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "study_documents",
    id,
  );

  if (row === null) return null;

  const textPath = ownerPath(userId, `${id}.txt`);

  // Mint before writing, so a mint failure leaves the row untouched.
  const { signedUrl } = await createSignedUploadUrl(
    db,
    STUDY_BUCKET,
    textPath,
  );

  await dbUpdate(db, "study_documents", id, { text_path: textPath });

  return { textUploadUrl: signedUrl };
}

export async function updateStudyDocMeta(
  db: DbClient,
  id: string,
  patch: unknown,
): Promise<DocumentMeta | null | { message: string }> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return { message: "Ungültige Änderung." };
  }

  const record = patch as Record<string, unknown>;
  const row: Record<string, unknown> = {};

  if (record.subject !== undefined) {
    if (record.subject !== null && typeof record.subject !== "string") {
      return { message: "Ungültige Änderung." };
    }

    row.subject = record.subject;
  }

  if (record.description !== undefined) {
    if (typeof record.description !== "string") {
      return { message: "Ungültige Änderung." };
    }

    row.description = record.description;
  }

  if (record.extractionStatus !== undefined) {
    if (
      typeof record.extractionStatus !== "string" ||
      ![
        "not_processed",
        "processing",
        "completed",
        "failed",
        "unsupported",
      ].includes(record.extractionStatus)
    ) {
      return { message: "Ungültige Änderung." };
    }

    row.extraction_status = record.extractionStatus;
  }

  const rows = await dbUpdate<Record<string, unknown>>(
    db,
    "study_documents",
    id,
    row,
  );
  const first = rows[0];

  if (first === undefined) return null;

  const doc = rowToMeta(first);

  if (!isDocumentMeta(doc)) {
    throw new Error("MAPPING_MISMATCH:study_documents");
  }

  return doc;
}

export async function downloadStudyDoc(
  db: DbClient,
  id: string,
): Promise<{ url: string; textUrl: string | null } | null> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "study_documents",
    id,
  );

  if (
    row === null ||
    typeof row.storage_path !== "string" ||
    row.storage_path === ""
  ) {
    return null;
  }

  try {
    const url = await createSignedDownloadUrl(db, STUDY_BUCKET, row.storage_path, 600);
    const textPath =
      typeof row.text_path === "string" && row.text_path !== ""
        ? row.text_path
        : null;
    const textUrl =
      textPath === null
        ? null
        : await createSignedDownloadUrl(db, STUDY_BUCKET, textPath, 600);

    return { url, textUrl };
  } catch (error) {
    // Record exists but bytes were never uploaded (e.g. interrupted
    // upload): surface 404, not a generic 400, so the UI can say so.
    if (
      error instanceof SupabaseHttpError &&
      error.message === "Object not found"
    ) {
      throw new Error("OBJECT_NOT_FOUND");
    }

    throw error;
  }
}

export async function deleteStudyDoc(
  db: DbClient,
  id: string,
): Promise<boolean> {
  const row = await dbGetOne<Record<string, unknown>>(
    db,
    "study_documents",
    id,
  );

  if (row === null) return false;

  for (const key of ["storage_path", "text_path"] as const) {
    const path = row[key];

    if (typeof path === "string" && path !== "") {
      try {
        await deleteObject(db, STUDY_BUCKET, path);
      } catch {
        // Metadata deletion wins; orphaned objects are listed for cleanup.
      }
    }
  }

  await dbDeleteWhere(db, "study_documents", [
    `id=eq.${encodeURIComponent(id)}`,
  ]);

  return true;
}
