/**
 * Study document storage for the frontend-only prototype.
 *
 * Binary blobs, extracted text, and metadata live in three separate
 * IndexedDB object stores so the library can list metadata without
 * loading file contents into memory.
 *
 * Persistence honesty: IndexedDB stores files in the current browser
 * profile only. There is no server, no cloud sync, and no cross-device
 * availability in this phase.
 */

export type DocumentKind = "pdf" | "docx" | "txt" | "md";

export type ExtractionStatus =
  | "not_processed"
  | "processing"
  | "completed"
  | "failed"
  | "unsupported";

export type DocumentMeta = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: DocumentKind;
  /**
   * Subject title (not id), consistent with `Entry.subject` used by the
   * existing study materials. Null means "no subject assigned".
   */
  subject: string | null;
  description: string;
  /** Upload timestamp as ISO string. */
  uploadedAt: string;
  extractionStatus: ExtractionStatus;
};

/** Maximum upload size: 10 MB per file. */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

export const KIND_LABELS: Record<DocumentKind, string> = {
  pdf: "PDF",
  docx: "DOCX",
  txt: "TXT",
  md: "MD",
};

export const EXTRACTION_STATUS_LABELS: Record<ExtractionStatus, string> = {
  not_processed: "Nicht verarbeitet",
  processing: "Wird verarbeitet",
  completed: "Text verfügbar",
  failed: "Fehlgeschlagen",
  unsupported: "Keine Texterkennung",
};

type AllowedEntry = {
  extensions: string[];
  mimeTypes: string[];
  primaryMime: string;
};

const ALLOWED_FILES: Record<DocumentKind, AllowedEntry> = {
  pdf: {
    extensions: ["pdf"],
    mimeTypes: ["application/pdf"],
    primaryMime: "application/pdf",
  },
  docx: {
    extensions: ["docx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    primaryMime:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  txt: {
    extensions: ["txt"],
    mimeTypes: ["text/plain"],
    primaryMime: "text/plain",
  },
  md: {
    extensions: ["md", "markdown", "mdown"],
    mimeTypes: ["text/markdown", "text/x-markdown", "text/plain"],
    primaryMime: "text/markdown",
  },
};

/**
 * Generic fallback MIME some systems report when they cannot determine
 * the type. Accepted only together with a valid extension; remaining
 * risk is contained because previews never execute content (PDFs are
 * re-wrapped with an explicit non-HTML type, text is read via `.text()`).
 */
const FALLBACK_MIME_TYPES = ["application/octet-stream", ""];

export type ValidatedFile = {
  kind: DocumentKind;
  mimeType: string;
};

export function validateFile(
  file: File,
): { ok: true; value: ValidatedFile } | { ok: false; error: string } {
  const dot = file.name.lastIndexOf(".");
  const extension =
    dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  const kinds = Object.keys(ALLOWED_FILES) as DocumentKind[];
  const kind = kinds.find((candidate) =>
    ALLOWED_FILES[candidate].extensions.includes(extension),
  );

  if (!kind) {
    return {
      ok: false,
      error: `„${file.name}“ wird nicht unterstützt. Erlaubt sind PDF, DOCX, TXT und MD.`,
    };
  }

  if (file.size <= 0) {
    return { ok: false, error: `„${file.name}“ ist leer.` };
  }

  if (file.size > MAX_FILE_SIZE) {
    return {
      ok: false,
      error: `„${file.name}“ ist zu groß. Maximal 10 MB pro Datei.`,
    };
  }

  const allowed = ALLOWED_FILES[kind];

  if (
    !FALLBACK_MIME_TYPES.includes(file.type) &&
    !allowed.mimeTypes.includes(file.type)
  ) {
    return {
      ok: false,
      error: `„${file.name}“: Der erkannte Dateityp passt nicht zur Endung .${extension}.`,
    };
  }

  return {
    ok: true,
    value: {
      kind,
      mimeType: file.type === "" ? allowed.primaryMime : file.type,
    },
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "–";
  if (bytes < 1024) return `${bytes} B`;

  const kilobytes = bytes / 1024;

  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(1).replace(".", ",")} KB`;
  }

  return `${(kilobytes / 1024).toFixed(1).replace(".", ",")} MB`;
}

const UPLOAD_DATE_FORMAT = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatUploadDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;

  return UPLOAD_DATE_FORMAT.format(new Date(time));
}

export function createDocumentId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const DOCUMENT_KINDS: DocumentKind[] = ["pdf", "docx", "txt", "md"];

const EXTRACTION_STATUSES: ExtractionStatus[] = [
  "not_processed",
  "processing",
  "completed",
  "failed",
  "unsupported",
];

export function isDocumentMeta(value: unknown): value is DocumentMeta {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.id === "string" &&
    item.id !== "" &&
    typeof item.name === "string" &&
    typeof item.mimeType === "string" &&
    typeof item.size === "number" &&
    Number.isFinite(item.size) &&
    item.size >= 0 &&
    typeof item.kind === "string" &&
    (DOCUMENT_KINDS as string[]).includes(item.kind) &&
    (item.subject === null || typeof item.subject === "string") &&
    typeof item.description === "string" &&
    typeof item.uploadedAt === "string" &&
    typeof item.extractionStatus === "string" &&
    (EXTRACTION_STATUSES as string[]).includes(item.extractionStatus)
  );
}

export function initialExtractionStatus(kind: DocumentKind): ExtractionStatus {
  return kind === "txt" || kind === "md" ? "not_processed" : "unsupported";
}

/**
 * Extracts readable text locally. Only TXT and MD are supported in this
 * phase; PDF and DOCX need a dedicated library (deliberately not added).
 */
export async function extractText(
  kind: DocumentKind,
  blob: Blob,
): Promise<string> {
  if (kind !== "txt" && kind !== "md") {
    throw new Error(
      `Texterkennung für ${KIND_LABELS[kind]} wird noch nicht unterstützt.`,
    );
  }

  return await blob.text();
}

const DB_NAME = "jarvis-documents";
const DB_VERSION = 1;
const META_STORE = "meta";
const BLOB_STORE = "blobs";
const TEXT_STORE = "texts";

export function isIndexedDBAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function toStorageError(cause: unknown, fallback: string): Error {
  if (cause instanceof DOMException && cause.name === "QuotaExceededError") {
    return new Error(
      "Der Browser-Speicher ist voll. Bitte lösche alte Dokumente oder gib Speicherplatz frei.",
    );
  }

  return new Error(fallback);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDBAvailable()) {
      reject(new Error("IndexedDB ist in diesem Browser nicht verfügbar."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(TEXT_STORE)) {
        db.createObjectStore(TEXT_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        toStorageError(
          request.error,
          "Dokumentenspeicher konnte nicht geöffnet werden.",
        ),
      );
  });
}

function requestToPromise<T>(
  request: IDBRequest<T>,
  fallback: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toStorageError(request.error, fallback));
  });
}

function transactionToPromise(
  transaction: IDBTransaction,
  fallback: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(toStorageError(transaction.error, fallback));
    transaction.onabort = () =>
      reject(toStorageError(transaction.error, fallback));
  });
}

/** Saves metadata and binary together in one atomic transaction. */
export async function saveDocument(
  meta: DocumentMeta,
  blob: Blob,
): Promise<void> {
  const db = await openDatabase();

  try {
    const transaction = db.transaction([META_STORE, BLOB_STORE], "readwrite");
    transaction.objectStore(META_STORE).put(meta);
    transaction.objectStore(BLOB_STORE).put({ id: meta.id, blob });
    await transactionToPromise(
      transaction,
      "Dokument konnte nicht gespeichert werden.",
    );
  } finally {
    db.close();
  }
}

/**
 * Lists metadata only (newest first); file contents are never loaded
 * for the library view. Invalid records are skipped, never fatal.
 */
export async function listDocuments(): Promise<DocumentMeta[]> {
  const db = await openDatabase();

  try {
    const transaction = db.transaction(META_STORE, "readonly");
    const records = await requestToPromise<unknown[]>(
      transaction.objectStore(META_STORE).getAll(),
      "Dokumente konnten nicht geladen werden.",
    );
    const valid: DocumentMeta[] = [];

    for (const record of records) {
      if (isDocumentMeta(record)) {
        valid.push(record);
      } else {
        console.warn("Ungültiger Dokumenteneintrag übersprungen.");
      }
    }

    valid.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

    return valid;
  } finally {
    db.close();
  }
}

export async function getDocumentBlob(id: string): Promise<Blob | null> {
  const db = await openDatabase();

  try {
    const transaction = db.transaction(BLOB_STORE, "readonly");
    const record = await requestToPromise<{ id: string; blob: Blob } | undefined>(
      transaction.objectStore(BLOB_STORE).get(id),
      "Datei konnte nicht geladen werden.",
    );

    if (!record || !(record.blob instanceof Blob)) return null;

    return record.blob;
  } finally {
    db.close();
  }
}

type MetaPatch = Partial<
  Pick<DocumentMeta, "subject" | "description" | "extractionStatus">
>;

/** Updates safe metadata fields. Returns null when the document is gone. */
export async function updateDocumentMeta(
  id: string,
  patch: MetaPatch,
): Promise<DocumentMeta | null> {
  const db = await openDatabase();

  try {
    const transaction = db.transaction(META_STORE, "readwrite");
    const store = transaction.objectStore(META_STORE);
    const current = await requestToPromise<unknown>(
      store.get(id),
      "Dokument konnte nicht gespeichert werden.",
    );

    if (!isDocumentMeta(current)) return null;

    const updated: DocumentMeta = { ...current, ...patch };
    store.put(updated);
    await transactionToPromise(
      transaction,
      "Dokument konnte nicht gespeichert werden.",
    );

    return updated;
  } finally {
    db.close();
  }
}

/** Removes metadata, binary, and extracted text in one transaction. */
export async function deleteDocument(id: string): Promise<void> {
  const db = await openDatabase();

  try {
    const transaction = db.transaction(
      [META_STORE, BLOB_STORE, TEXT_STORE],
      "readwrite",
    );
    transaction.objectStore(META_STORE).delete(id);
    transaction.objectStore(BLOB_STORE).delete(id);
    transaction.objectStore(TEXT_STORE).delete(id);
    await transactionToPromise(
      transaction,
      "Dokument konnte nicht gelöscht werden.",
    );
  } finally {
    db.close();
  }
}

/** Stores extracted text and marks the document as completed, atomically. */
export async function saveDocumentText(
  id: string,
  text: string,
): Promise<void> {
  const db = await openDatabase();

  try {
    const transaction = db.transaction([TEXT_STORE, META_STORE], "readwrite");
    transaction.objectStore(TEXT_STORE).put({ id, text });
    const current = await requestToPromise<unknown>(
      transaction.objectStore(META_STORE).get(id),
      "Text konnte nicht gespeichert werden.",
    );

    if (isDocumentMeta(current)) {
      transaction
        .objectStore(META_STORE)
        .put({ ...current, extractionStatus: "completed" });
    }

    await transactionToPromise(
      transaction,
      "Text konnte nicht gespeichert werden.",
    );
  } finally {
    db.close();
  }
}

/**
 * Typed accessor for extracted document text.
 *
 * This is the boundary for the future AI Study Assistant: AI modules
 * must retrieve text through this function (optionally combined with
 * `listDocuments` for discovery) instead of accessing IndexedDB
 * directly. Returns null when no text was extracted.
 */
export async function getDocumentText(id: string): Promise<string | null> {
  const db = await openDatabase();

  try {
    const transaction = db.transaction(TEXT_STORE, "readonly");
    const record = await requestToPromise<{ id: string; text: string } | undefined>(
      transaction.objectStore(TEXT_STORE).get(id),
      "Text konnte nicht geladen werden.",
    );

    return typeof record?.text === "string" ? record.text : null;
  } finally {
    db.close();
  }
}
