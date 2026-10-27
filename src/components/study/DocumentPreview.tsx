"use client";

import { useEffect, useState } from "react";
import { Download, FileText, Loader2, X } from "lucide-react";
import { useLockBodyScroll } from "@/src/hooks/useLockBodyScroll";
import {
  formatBytes,
  getDocumentBlob,
  getDocumentText,
  type DocumentMeta,
} from "@/src/lib/db/documents";

const TEXT_PREVIEW_LIMIT = 50_000;

export function DocumentPreview({
  doc,
  onClose,
  onDownload,
}: {
  doc: DocumentMeta;
  onClose: () => void;
  onDownload: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useLockBodyScroll(true);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    async function load() {
      try {
        if (doc.kind === "txt" || doc.kind === "md") {
          const stored = await getDocumentText(doc.id);
          if (cancelled) return;

          if (stored !== null) {
            setText(stored.slice(0, TEXT_PREVIEW_LIMIT));
            setTruncated(stored.length > TEXT_PREVIEW_LIMIT);
          } else {
            // Fallback when extraction never ran: read the stored file.
            const blob = await getDocumentBlob(doc.id);
            if (cancelled) return;

            if (blob === null) {
              setError("Die Datei fehlt im Speicher.");
            } else {
              const full = await blob.text();
              if (!cancelled) {
                setText(full.slice(0, TEXT_PREVIEW_LIMIT));
                setTruncated(full.length > TEXT_PREVIEW_LIMIT);
              }
            }
          }
        } else if (doc.kind === "pdf") {
          const blob = await getDocumentBlob(doc.id);
          if (cancelled) return;

          if (blob === null) {
            setError("Die Datei fehlt im Speicher.");
          } else {
            // Re-wrap with an explicit PDF type so a renamed file can
            // never be executed as HTML inside the preview frame.
            objectUrl = URL.createObjectURL(
              new Blob([blob], { type: "application/pdf" }),
            );
            setUrl(objectUrl);
          }
        }
        // DOCX has no browser preview by design (see body below).
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Vorschau konnte nicht geladen werden.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;

      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [doc.id, doc.kind]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="document-preview-title"
      className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
    >
      <button
        aria-label="Schließen"
        onClick={onClose}
        className="jarvis-fade absolute inset-0 h-full w-full cursor-default bg-black/70"
      />

      <div className="jarvis-pop relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#0d111b] p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2
              id="document-preview-title"
              className="truncate text-lg font-semibold"
            >
              {doc.name}
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              {formatBytes(doc.size)}
              {doc.subject ? ` · ${doc.subject}` : ""}
            </p>
          </div>

          <button
            onClick={onClose}
            aria-label="Schließen"
            className="shrink-0 rounded-xl border border-white/10 p-2 text-slate-400 transition hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
              <Loader2 size={17} className="motion-safe:animate-spin" />
              Vorschau wird geladen …
            </p>
          ) : error !== null ? (
            <p role="alert" className="py-10 text-center text-sm text-rose-300">
              {error}
            </p>
          ) : doc.kind === "pdf" && url !== null ? (
            <iframe
              src={url}
              title={`Vorschau: ${doc.name}`}
              className="h-[65vh] w-full rounded-xl bg-white"
            />
          ) : (doc.kind === "txt" || doc.kind === "md") &&
            text !== null ? (
            <div>
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/30 p-4 text-left text-sm leading-6 text-slate-200">
                {text}
              </pre>
              {truncated && (
                <p className="mt-2 text-xs text-slate-500">
                  Vorschau gekürzt – lade die Datei herunter, um den
                  vollständigen Text zu lesen.
                </p>
              )}
            </div>
          ) : (
            <div className="py-10 text-center">
              <FileText size={28} className="mx-auto text-slate-600" />
              <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-slate-400">
                Für DOCX-Dateien gibt es in dieser Version keine
                Browser-Vorschau. Lade das Dokument herunter, um es zu
                öffnen. Der Text steht für textbasierte Übungen noch
                nicht zur Verfügung.
              </p>
              <button
                onClick={onDownload}
                className="mt-5 inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-4 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
              >
                <Download size={16} />
                Herunterladen
              </button>
            </div>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onDownload}
            className="flex items-center gap-1.5 rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200"
          >
            <Download size={16} />
            Herunterladen
          </button>
          <button
            onClick={onClose}
            className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5"
          >
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}
