"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { Entry } from "@/src/lib/study";
import {
  EXTRACTION_STATUS_LABELS,
  KIND_LABELS,
  MAX_FILE_SIZE,
  createDocumentId,
  deleteDocument,
  extractText,
  formatBytes,
  formatUploadDate,
  getDocumentBlob,
  initialExtractionStatus,
  isIndexedDBAvailable,
  listDocuments,
  saveDocument,
  saveDocumentText,
  updateDocumentMeta,
  validateFile,
  type DocumentKind,
  type DocumentMeta,
  type ExtractionStatus,
} from "@/src/lib/db/documents";
import { DocumentPreview } from "@/src/components/study/DocumentPreview";
import { CLOUD_ENABLED } from "@/src/lib/db/mode";

const STATUS_STYLES: Record<ExtractionStatus, string> = {
  not_processed: "bg-slate-400/10 text-slate-400",
  processing: "bg-cyan-300/10 text-cyan-200",
  completed: "bg-emerald-400/10 text-emerald-300",
  failed: "bg-rose-400/10 text-rose-300",
  unsupported: "bg-slate-400/10 text-slate-400",
};

const KIND_FILTERS: { key: "all" | DocumentKind; label: string }[] = [
  { key: "all", label: "Alle Typen" },
  { key: "pdf", label: "PDF" },
  { key: "docx", label: "DOCX" },
  { key: "txt", label: "TXT" },
  { key: "md", label: "MD" },
];

type LibraryStatus = "loading" | "ready" | "unavailable" | "error";

export function DocumentLibrary({ subjects }: { subjects: Entry[] }) {
  const [status, setStatus] = useState<LibraryStatus>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [docs, setDocs] = useState<DocumentMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [subjectFilter, setSubjectFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState<"all" | DocumentKind>("all");
  const [query, setQuery] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [uploadSubject, setUploadSubject] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!CLOUD_ENABLED && !isIndexedDBAvailable()) {
        if (!cancelled) {
          setStatus("unavailable");
        }

        return;
      }

      try {
        const items = await listDocuments();

        if (!cancelled) {
          setDocs(items);
          setStatus("ready");
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Dokumente konnten nicht geladen werden.",
          );
          setStatus("error");
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (subjectFilter !== "all" || typeof window === "undefined") return;

    const prefix = "#dokumente-";
    const { hash } = window.location;

    if (!hash.startsWith(prefix)) return;

    let linked = "";

    try {
      linked = decodeURIComponent(hash.slice(prefix.length));
    } catch {
      return;
    }

    if (
      linked === "" ||
      (linked !== "none" &&
        !subjects.some((subject) => subject.title === linked))
    ) {
      return;
    }

    // One-time deep link from subject/topic rows (see StudySection).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSubjectFilter(linked);
  }, [subjects, subjectFilter]);

  async function refresh() {
    try {
      setDocs(await listDocuments());
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Aktualisieren fehlgeschlagen.",
      );
    }
  }

  const visibleDocs = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return docs.filter((doc) => {
      if (subjectFilter === "none" && doc.subject !== null) return false;
      if (
        subjectFilter !== "all" &&
        subjectFilter !== "none" &&
        doc.subject !== subjectFilter
      ) {
        return false;
      }
      if (kindFilter !== "all" && doc.kind !== kindFilter) return false;
      if (needle !== "" && !doc.name.toLowerCase().includes(needle)) {
        return false;
      }

      return true;
    });
  }, [docs, subjectFilter, kindFilter, query]);

  const previewDoc = docs.find((doc) => doc.id === previewId) ?? null;

  function openUpload() {
    setPendingFile(null);
    setPendingError(null);
    setUploadSubject("");
    setUploadDescription("");
    setInputKey((current) => current + 1);
    setUploadOpen(true);
  }

  function cancelUpload() {
    setPendingFile(null);
    setPendingError(null);
    setUploadSubject("");
    setUploadDescription("");
    setInputKey((current) => current + 1);
    setUploadOpen(false);
  }

  function selectFile(file: File | undefined) {
    setNotice(null);
    if (!file) return;

    const result = validateFile(file);

    if (!result.ok) {
      setPendingFile(null);
      setPendingError(result.error);
      return;
    }

    setPendingError(null);
    setPendingFile(file);
  }

  async function saveUpload() {
    if (pendingFile === null || saving) return;

    const validation = validateFile(pendingFile);

    if (!validation.ok) {
      setPendingError(validation.error);
      return;
    }

    setSaving(true);
    setPendingError(null);

    try {
      const meta: DocumentMeta = {
        id: createDocumentId(),
        name: pendingFile.name,
        mimeType: validation.value.mimeType,
        size: pendingFile.size,
        kind: validation.value.kind,
        subject: uploadSubject === "" ? null : uploadSubject,
        description: uploadDescription.trim(),
        uploadedAt: new Date().toISOString(),
        extractionStatus: initialExtractionStatus(validation.value.kind),
      };

      await saveDocument(meta, pendingFile);
      const savedFile = pendingFile;
      cancelUpload();
      setNotice(`„${meta.name}“ wurde hochgeladen.`);
      await refresh();

      if (meta.kind === "txt" || meta.kind === "md") {
        try {
          await updateDocumentMeta(meta.id, { extractionStatus: "processing" });
          await refresh();
          const text = await extractText(meta.kind, savedFile);
          await saveDocumentText(meta.id, text);
        } catch {
          await updateDocumentMeta(meta.id, { extractionStatus: "failed" });
        } finally {
          await refresh();
        }
      }
    } catch (saveError) {
      setPendingError(
        saveError instanceof Error ? saveError.message : "Upload fehlgeschlagen.",
      );
    } finally {
      setSaving(false);
    }
  }

  function openEdit(doc: DocumentMeta) {
    setEditingId(doc.id);
    setEditSubject(doc.subject ?? "");
    setEditDescription(doc.description);
    setConfirmDeleteId(null);
  }

  async function saveEdit(id: string) {
    try {
      const updated = await updateDocumentMeta(id, {
        subject: editSubject === "" ? null : editSubject,
        description: editDescription.trim(),
      });

      if (updated === null) {
        setError(
          "Dokument wurde nicht gefunden. Es wurde möglicherweise bereits gelöscht.",
        );
      } else {
        setDocs((current) =>
          current.map((item) => (item.id === id ? updated : item)),
        );
      }

      setEditingId(null);
    } catch (editError) {
      setError(
        editError instanceof Error
          ? editError.message
          : "Speichern fehlgeschlagen.",
      );
    }
  }

  async function confirmDelete(id: string) {
    try {
      await deleteDocument(id);
      setDocs((current) => current.filter((item) => item.id !== id));
      setConfirmDeleteId(null);
      setNotice("Dokument wurde gelöscht.");
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Löschen fehlgeschlagen.",
      );
    }
  }

  async function downloadDoc(doc: DocumentMeta) {
    try {
      const blob = await getDocumentBlob(doc.id);

      if (blob === null) {
        setError(`Die Datei zu „${doc.name}“ fehlt im Speicher.`);
        return;
      }

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = doc.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Download fehlgeschlagen.",
      );
    }
  }

  return (
    <div id="dokumente" className="scroll-mt-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Dokumente</h3>
          <p className="mt-1 text-xs text-slate-500">
            {docs.length} {docs.length === 1 ? "Dokument" : "Dokumente"} ·
            lokal im Browser gespeichert
          </p>
        </div>

        {status === "ready" && !uploadOpen && (
          <button
            onClick={openUpload}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
          >
            <Plus size={16} />
            Dokument hochladen
          </button>
        )}
      </div>

      {error !== null && (
        <p
          role="alert"
          className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-rose-400/25 bg-rose-400/5 p-3 text-sm text-rose-200"
        >
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            aria-label="Fehlermeldung schließen"
            className="shrink-0 rounded-lg p-1 text-rose-300/70 transition hover:text-rose-200"
          >
            <X size={15} />
          </button>
        </p>
      )}

      {notice !== null && (
        <p
          role="status"
          className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-emerald-400/25 bg-emerald-400/5 p-3 text-sm text-emerald-200"
        >
          <span>{notice}</span>
          <button
            onClick={() => setNotice(null)}
            aria-label="Hinweis schließen"
            className="shrink-0 rounded-lg p-1 text-emerald-300/70 transition hover:text-emerald-200"
          >
            <X size={15} />
          </button>
        </p>
      )}

      {status === "loading" && (
        <p className="flex items-center gap-2 py-6 text-sm text-slate-500">
          <Loader2 size={16} className="motion-safe:animate-spin" />
          Dokumente werden geladen …
        </p>
      )}

      {status === "unavailable" && (
        <div className="mt-4 rounded-2xl border border-amber-300/25 bg-amber-300/5 p-5 text-sm leading-6 text-amber-200">
          Der Dokumentenspeicher (IndexedDB) ist in diesem Browser nicht
          verfügbar – zum Beispiel im privaten Modus mit blockiertem
          Speicher. Dokumente können hier derzeit nicht gespeichert
          werden. Deine Fächer, Prüfungen und Lernthemen sind davon nicht
          betroffen.
        </div>
      )}

      {status === "error" && (
        <div className="mt-4 rounded-2xl border border-white/10 p-5 text-center">
          <p className="text-sm text-slate-400">
            Dokumente konnten nicht geladen werden.
          </p>
          <button
            onClick={() => {
              setError(null);
              setStatus("loading");
              setReloadKey((current) => current + 1);
            }}
            className="mt-3 rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition hover:border-cyan-300/30"
          >
            Erneut versuchen
          </button>
        </div>
      )}

      {status === "ready" && (
        <>
          {uploadOpen && (
            <div className="mt-4 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4">
              <div
                onDragOver={(drag) => {
                  drag.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(drop) => {
                  drop.preventDefault();
                  setDragActive(false);
                  selectFile(drop.dataTransfer.files?.[0]);
                }}
                className={`rounded-2xl border border-dashed p-6 text-center transition ${
                  dragActive
                    ? "border-cyan-300/60 bg-cyan-300/10"
                    : "border-white/15"
                }`}
              >
                <Upload size={24} className="mx-auto text-cyan-300" />
                <p className="mt-3 text-sm text-slate-300">
                  Datei hierher ziehen oder
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-describedby="doc-upload-formats"
                  className="mt-3 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                >
                  Datei auswählen
                </button>
                <input
                  ref={fileInputRef}
                  key={inputKey}
                  type="file"
                  accept=".pdf,.docx,.txt,.md,.markdown"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(change) => selectFile(change.target.files?.[0])}
                  className="sr-only"
                />
                <p
                  id="doc-upload-formats"
                  className="mt-3 text-xs text-slate-500"
                >
                  PDF, DOCX, TXT, MD · max. {formatBytes(MAX_FILE_SIZE)} pro
                  Datei
                </p>
              </div>

              {pendingError !== null && (
                <p role="alert" className="mt-3 text-sm text-rose-300">
                  {pendingError}
                </p>
              )}

              {pendingFile !== null && (
                <div className="mt-3 space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                  <p className="truncate text-sm font-medium text-slate-200">
                    {pendingFile.name}{" "}
                    <span className="ml-1 text-xs font-normal tabular-nums text-slate-500">
                      {formatBytes(pendingFile.size)}
                    </span>
                  </p>

                  <label className="block text-xs text-slate-400">
                    Fach (optional)
                    <select
                      value={uploadSubject}
                      onChange={(change) =>
                        setUploadSubject(change.target.value)
                      }
                      disabled={saving}
                      className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50 disabled:opacity-50"
                    >
                      <option value="">Kein Fach zugeordnet</option>
                      {subjects.map((subject) => (
                        <option key={subject.id} value={subject.title}>
                          {subject.title}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block text-xs text-slate-400">
                    Beschreibung (optional)
                    <input
                      value={uploadDescription}
                      onChange={(change) =>
                        setUploadDescription(change.target.value)
                      }
                      disabled={saving}
                      placeholder="z. B. Zusammenfassung zur Klausur"
                      maxLength={200}
                      className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50 disabled:opacity-50"
                    />
                  </label>

                  <div className="flex gap-2">
                    <button
                      onClick={saveUpload}
                      disabled={saving}
                      className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {saving && (
                        <Loader2
                          size={16}
                          className="motion-safe:animate-spin"
                        />
                      )}
                      {saving ? "Wird gespeichert …" : "Hochladen"}
                    </button>
                    <button
                      onClick={cancelUpload}
                      disabled={saving}
                      className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5 disabled:opacity-50"
                    >
                      Abbrechen
                    </button>
                  </div>
                </div>
              )}

              {pendingFile === null && (
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={cancelUpload}
                    className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 hover:bg-white/5"
                  >
                    Schließen
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1">
              <Search
                size={15}
                aria-hidden="true"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <input
                value={query}
                onChange={(change) => setQuery(change.target.value)}
                placeholder="Dokumente suchen …"
                aria-label="Dokumente suchen"
                className="w-full rounded-xl border border-white/10 bg-black/20 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-300/50"
              />
            </div>

            <select
              value={subjectFilter}
              onChange={(change) => setSubjectFilter(change.target.value)}
              aria-label="Nach Fach filtern"
              className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-xs text-white outline-none focus:border-cyan-300/50"
            >
              <option value="all">Alle Fächer</option>
              <option value="none">Ohne Fach</option>
              {subjects.map((subject) => (
                <option key={subject.id} value={subject.title}>
                  {subject.title}
                </option>
              ))}
            </select>

            <select
              value={kindFilter}
              onChange={(change) =>
                setKindFilter(
                  change.target.value as "all" | DocumentKind,
                )
              }
              aria-label="Nach Dateityp filtern"
              className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-xs text-white outline-none focus:border-cyan-300/50"
            >
              {KIND_FILTERS.map((filter) => (
                <option key={filter.key} value={filter.key}>
                  {filter.label}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-4">
            {docs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center">
                <FileText size={24} className="mx-auto text-slate-600" />
                <p className="mt-3 text-sm text-slate-400">
                  Noch keine Dokumente hochgeladen.
                </p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-slate-500">
                  Lade Skripte und Notizen als PDF, DOCX, TXT oder MD hoch –
                  sie bleiben lokal in deinem Browser gespeichert.
                </p>
                {!uploadOpen && (
                  <button
                    onClick={openUpload}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                  >
                    <Plus size={16} />
                    Dokument hochladen
                  </button>
                )}
              </div>
            ) : visibleDocs.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-6 text-center">
                <p className="text-sm text-slate-400">
                  Keine Dokumente für diese Suche gefunden.
                </p>
                <button
                  onClick={() => {
                    setQuery("");
                    setSubjectFilter("all");
                    setKindFilter("all");
                  }}
                  className="mt-3 rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:border-cyan-300/30"
                >
                  Filter zurücksetzen
                </button>
              </div>
            ) : (
              <ul className="space-y-2">
                {visibleDocs.map((doc) => (
                  <li
                    key={doc.id}
                    className="rounded-2xl border border-white/[0.05] bg-white/[0.02] p-4"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-300/[0.08] text-cyan-300">
                        <FileText size={18} />
                      </div>

                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-200">
                          {doc.name}
                        </p>
                        <p className="mt-1 text-xs tabular-nums text-slate-500">
                          {KIND_LABELS[doc.kind]} · {formatBytes(doc.size)} ·{" "}
                          {formatUploadDate(doc.uploadedAt)}
                        </p>

                        <div className="mt-2 flex flex-wrap gap-2">
                          {doc.subject !== null && (
                            <span className="rounded-full bg-cyan-300/[0.08] px-2 py-1 text-[10px] text-cyan-200">
                              {doc.subject}
                            </span>
                          )}
                          <span
                            className={`rounded-full px-2 py-1 text-[10px] ${STATUS_STYLES[doc.extractionStatus]}`}
                          >
                            {EXTRACTION_STATUS_LABELS[doc.extractionStatus]}
                          </span>
                        </div>

                        {doc.description !== "" && (
                          <p className="mt-2 break-words text-xs leading-5 text-slate-500">
                            {doc.description}
                          </p>
                        )}
                      </div>

                      <div className="flex shrink-0 gap-1">
                        <button
                          onClick={() => setPreviewId(doc.id)}
                          aria-label={`Vorschau öffnen: ${doc.name}`}
                          title="Vorschau"
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                        >
                          <Eye size={15} />
                        </button>
                        <button
                          onClick={() => downloadDoc(doc)}
                          aria-label={`Herunterladen: ${doc.name}`}
                          title="Herunterladen"
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                        >
                          <Download size={15} />
                        </button>
                        <button
                          onClick={() => openEdit(doc)}
                          aria-label={`Bearbeiten: ${doc.name}`}
                          title="Bearbeiten"
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-white/5 hover:text-slate-200"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          onClick={() => setConfirmDeleteId(doc.id)}
                          aria-label={`Löschen: ${doc.name}`}
                          title="Löschen"
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-rose-400/10 hover:text-rose-300"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </div>

                    {editingId === doc.id && (
                      <div className="mt-3 space-y-3 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.03] p-4">
                        <label className="block text-xs text-slate-400">
                          Fach
                          <select
                            value={editSubject}
                            onChange={(change) =>
                              setEditSubject(change.target.value)
                            }
                            className="mt-2 w-full rounded-xl border border-white/10 bg-[#111827] px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                          >
                            <option value="">Kein Fach zugeordnet</option>
                            {subjects.map((subject) => (
                              <option key={subject.id} value={subject.title}>
                                {subject.title}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="block text-xs text-slate-400">
                          Beschreibung
                          <input
                            value={editDescription}
                            onChange={(change) =>
                              setEditDescription(change.target.value)
                            }
                            placeholder="Optionale Beschreibung"
                            maxLength={200}
                            className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-300/50"
                          />
                        </label>

                        <div className="flex gap-2">
                          <button
                            onClick={() => saveEdit(doc.id)}
                            className="flex-1 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
                          >
                            Speichern
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                          >
                            Abbrechen
                          </button>
                        </div>
                      </div>
                    )}

                    {confirmDeleteId === doc.id && (
                      <div className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/5 p-4">
                        <p className="text-sm text-rose-200">
                          „{doc.name}“ wirklich endgültig löschen? Die Datei
                          wird unwiderruflich entfernt.
                        </p>

                        <div className="mt-3 flex gap-2">
                          <button
                            onClick={() => confirmDelete(doc.id)}
                            className="flex-1 rounded-xl bg-rose-400 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-rose-300"
                          >
                            Endgültig löschen
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
                          >
                            Abbrechen
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {previewDoc !== null && (
        <DocumentPreview
          doc={previewDoc}
          onClose={() => setPreviewId(null)}
          onDownload={() => downloadDoc(previewDoc)}
        />
      )}
    </div>
  );
}
