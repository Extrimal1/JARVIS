"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Maximize2,
  RotateCcw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Modal } from "@/src/components/study/Modal";
import {
  formatBytes,
  getDocumentBlob,
  getDocumentText,
  type DocumentMeta,
} from "@/src/lib/db/documents";
import { ExtractError } from "@/src/lib/study/extract";
import {
  PREVIEW_TEXT_LIMIT,
  extractDocxPreview,
  extractPptxPreview,
  parseMarkdown,
  type DocxPreview,
  type MdBlock,
  type MdInlineSegment,
  type MdPreview,
  type PptxPreview,
} from "@/src/lib/study/preview";

type Content =
  | { view: "pdf"; url: string }
  | { view: "docx"; preview: DocxPreview }
  | { view: "pptx"; preview: PptxPreview }
  | { view: "text"; text: string; truncated: boolean; note: string | null }
  | { view: "markdown"; preview: MdPreview }
  | { view: "unsupported"; reason: string };

function splitLines(text: string): (string | "\n")[] {
  const parts: (string | "\n")[] = [];

  for (const [index, line] of text.split("\n").entries()) {
    if (index > 0) parts.push("\n");
    parts.push(line);
  }

  return parts;
}

function Inline({ segments }: { segments: MdInlineSegment[] }) {
  const out: ReactNode[] = [];
  let key = 0;

  for (const segment of segments) {
    for (const part of splitLines(segment.text)) {
      if (part === "\n") {
        out.push(<br key={key++} />);

        continue;
      }

      let node: ReactNode = part;

      if (segment.code) {
        node = (
          <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[0.85em] text-cyan-100">
            {part}
          </code>
        );
      } else if (segment.bold) {
        node = <strong className="font-semibold text-slate-100">{part}</strong>;
      } else if (segment.italic) {
        node = <em className="text-slate-200">{part}</em>;
      }

      if (segment.href !== null) {
        node = (
          <a
            href={segment.href}
            target="_blank"
            rel="noreferrer"
            className="text-cyan-300 underline decoration-cyan-300/40 underline-offset-2 hover:text-cyan-200"
          >
            {node}
          </a>
        );
      }

      out.push(<span key={key++}>{node}</span>);
    }
  }

  return <>{out}</>;
}

function MarkdownBlock({ block }: { block: MdBlock }) {
  switch (block.type) {
    case "heading": {
      const sizes: Record<number, string> = {
        1: "text-xl font-bold text-slate-100",
        2: "text-lg font-semibold text-slate-100",
        3: "text-base font-semibold text-slate-100",
        4: "text-sm font-semibold text-slate-200",
        5: "text-sm font-semibold text-slate-200",
        6: "text-sm font-semibold text-slate-200",
      };

      return (
        <div className={`mt-4 first:mt-0 ${sizes[block.level] ?? sizes[6]}`}>
          <Inline segments={block.inline} />
        </div>
      );
    }
    case "paragraph":
      return (
        <p className="mt-3 first:mt-0 text-sm leading-6 text-slate-200">
          <Inline segments={block.inline} />
        </p>
      );
    case "quote":
      return (
        <blockquote className="mt-3 border-l-2 border-cyan-300/40 pl-3 text-sm leading-6 text-slate-300 italic">
          <Inline segments={block.inline} />
        </blockquote>
      );
    case "code":
      return (
        <pre className="mt-3 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-xs leading-5 text-slate-200">
          {block.code}
        </pre>
      );
    case "rule":
      return <hr className="my-4 border-white/10" />;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";

      return (
        <Tag
          className={`mt-3 space-y-1.5 text-sm leading-6 text-slate-200 ${
            block.ordered ? "list-decimal pl-5" : "list-disc pl-5"
          }`}
        >
          {block.items.map((item, index) => (
            <li key={index} style={{ marginLeft: `${item.level * 1.25}rem` }}>
              <Inline segments={item.inline} />
            </li>
          ))}
        </Tag>
      );
    }
  }
}

function DocxView({ preview }: { preview: DocxPreview }) {
  const nodes: ReactNode[] = [];
  let listRun: { ordered: boolean; items: ReactNode[] } | null = null;

  const flushList = () => {
    if (listRun === null) return;

    const Tag = listRun.ordered ? "ol" : "ul";
    nodes.push(
      <Tag
        key={`list-${nodes.length}`}
        className={`mt-3 space-y-1.5 text-sm leading-6 text-slate-200 ${
          listRun.ordered ? "list-decimal pl-5" : "list-disc pl-5"
        }`}
      >
        {listRun.items}
      </Tag>,
    );
    listRun = null;
  };

  preview.blocks.forEach((block, index) => {
    if (block.list !== null) {
      if (listRun === null || listRun.ordered !== block.list.ordered) {
        flushList();
        listRun = { ordered: block.list.ordered, items: [] };
      }

      listRun.items.push(
        <li key={index} style={{ marginLeft: `${block.list.level * 1.25}rem` }}>
          {block.text}
        </li>,
      );

      return;
    }

    flushList();

    if (block.heading === 1) {
      nodes.push(
        <h3 key={index} className="mt-5 first:mt-0 text-lg font-bold text-slate-100">
          {block.text}
        </h3>,
      );
    } else if (block.heading === 2) {
      nodes.push(
        <h4 key={index} className="mt-4 first:mt-0 text-base font-semibold text-slate-100">
          {block.text}
        </h4>,
      );
    } else if (block.heading === 3) {
      nodes.push(
        <h5 key={index} className="mt-3 first:mt-0 text-sm font-semibold text-slate-100">
          {block.text}
        </h5>,
      );
    } else {
      nodes.push(
        <p key={index} className="mt-3 first:mt-0 text-sm leading-6 text-slate-200">
          {block.text}
        </p>,
      );
    }
  });

  flushList();

  return (
    <div>
      {preview.warnings.map((warning) => (
        <p key={warning} className="mb-3 rounded-xl border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs leading-5 text-amber-200">
          {warning}
        </p>
      ))}
      {nodes}
      {preview.truncated && (
        <p className="mt-3 text-xs text-slate-500">
          Vorschau gekürzt – lade die Datei herunter, um den vollständigen
          Text zu lesen.
        </p>
      )}
    </div>
  );
}

function PptxView({ preview }: { preview: PptxPreview }) {
  const [slideIdx, setSlideIdx] = useState(0);
  const slide = preview.slides[Math.min(slideIdx, preview.slides.length - 1)];

  if (slide === undefined) return null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSlideIdx((current) => Math.max(0, current - 1))}
            disabled={slideIdx === 0}
            aria-label="Vorherige Folie"
            className="rounded-lg border border-white/10 p-2 text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/10 disabled:hover:text-slate-300"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() =>
              setSlideIdx((current) =>
                Math.min(preview.slides.length - 1, current + 1),
              )
            }
            disabled={slideIdx >= preview.slides.length - 1}
            aria-label="Nächste Folie"
            className="rounded-lg border border-white/10 p-2 text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/10 disabled:hover:text-slate-300"
          >
            <ChevronRight size={16} />
          </button>
          <span className="ml-2 text-xs text-slate-400" role="status">
            Folie {slideIdx + 1} von {preview.slides.length}
          </span>
        </div>

        <div className="flex max-w-full gap-1 overflow-x-auto pb-1" role="tablist" aria-label="Folien">
          {preview.slides.map((entry, index) => (
            <button
              key={entry.slide}
              role="tab"
              aria-selected={index === slideIdx}
              aria-label={`Folie ${entry.slide}${entry.title !== "" ? `: ${entry.title}` : ""}`}
              title={entry.title !== "" ? entry.title : `Folie ${entry.slide}`}
              onClick={() => setSlideIdx(index)}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-xs transition ${
                index === slideIdx
                  ? "border-cyan-300/50 bg-cyan-300/10 text-cyan-200"
                  : "border-white/10 text-slate-400 hover:text-slate-200"
              }`}
            >
              {entry.slide}
            </button>
          ))}
        </div>
      </div>

      {preview.warnings.map((warning) => (
        <p key={warning} className="mt-3 rounded-xl border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs leading-5 text-amber-200">
          {warning}
        </p>
      ))}

      <div className="mt-3 rounded-xl bg-black/30 p-5">
        {slide.empty ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Folie {slide.slide} enthält keinen lesbaren Text (z.&nbsp;B. nur
            Bilder).
          </p>
        ) : (
          <div>
            <h3 className="text-base font-semibold text-slate-100">
              {slide.title}
            </h3>
            {slide.lines.length > 0 && (
              <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm leading-6 text-slate-200">
                {slide.lines.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfView({ url, name }: { url: string; name: string }) {
  const [zoom, setZoom] = useState(1);
  const percent = Math.round(zoom * 100);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1" role="group" aria-label="Zoom">
          <button
            onClick={() => setZoom((current) => Math.max(0.5, current - 0.25))}
            disabled={zoom <= 0.5}
            aria-label="Verkleinern"
            className="rounded-lg border border-white/10 p-2 text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/10 disabled:hover:text-slate-300"
          >
            <ZoomOut size={16} />
          </button>
          <span className="min-w-12 text-center text-xs text-slate-400" role="status">
            {percent}&nbsp;%
          </span>
          <button
            onClick={() => setZoom((current) => Math.min(2, current + 0.25))}
            disabled={zoom >= 2}
            aria-label="Vergrößern"
            className="rounded-lg border border-white/10 p-2 text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/10 disabled:hover:text-slate-300"
          >
            <ZoomIn size={16} />
          </button>
          <button
            onClick={() => setZoom(1)}
            disabled={zoom === 1}
            aria-label="Zoom zurücksetzen"
            className="rounded-lg border border-white/10 p-2 text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-white/10 disabled:hover:text-slate-300"
          >
            <Maximize2 size={16} />
          </button>
        </div>

        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200"
        >
          <ExternalLink size={14} />
          In neuem Tab öffnen
        </a>
      </div>

      <div className="mt-3 overflow-auto rounded-xl bg-white">
        <div style={{ width: `${percent}%`, minWidth: "100%" }}>
          <iframe
            src={url}
            title={`Vorschau: ${name}`}
            className="h-[60vh] w-full bg-white"
          />
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Blättern und Zoomen sind auch direkt im Dokument möglich.
      </p>
    </div>
  );
}

export function DocumentPreview({
  doc,
  onClose,
  onDownload,
}: {
  doc: DocumentMeta;
  onClose: () => void;
  onDownload: () => void;
}) {
  const [content, setContent] = useState<Content | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    async function blobBytes(): Promise<Uint8Array | null> {
      const blob = await getDocumentBlob(doc.id);

      if (blob === null) return null;

      return new Uint8Array(await blob.arrayBuffer());
    }

    async function storedText(): Promise<string | null> {
      const stored = await getDocumentText(doc.id);

      if (stored !== null) return stored;

      // Fallback when extraction never ran: read the stored file.
      const blob = await getDocumentBlob(doc.id);

      if (blob === null) return null;

      return blob.text();
    }

    function finish(next: Content) {
      if (!cancelled) {
        setContent(next);
        setLoading(false);
      }
    }

    function fail(message: string) {
      if (!cancelled) {
        setError(message);
        setLoading(false);
      }
    }

    async function load() {
      try {
        if (doc.kind === "pdf") {
          const blob = await getDocumentBlob(doc.id);
          if (cancelled) return;

          if (blob === null) {
            fail("Die Datei fehlt im Speicher.");
          } else {
            // Re-wrap with an explicit PDF type so a renamed file can
            // never be executed as HTML inside the preview frame.
            objectUrl = URL.createObjectURL(
              new Blob([blob], { type: "application/pdf" }),
            );
            finish({ view: "pdf", url: objectUrl });
          }
        } else if (doc.kind === "txt") {
          const full = await storedText();
          if (cancelled) return;

          if (full === null) {
            fail("Die Datei fehlt im Speicher.");
          } else if (full.trim() === "") {
            finish({
              view: "unsupported",
              reason: "Die Datei enthält keinen lesbaren Text.",
            });
          } else {
            finish({
              view: "text",
              text: full.slice(0, PREVIEW_TEXT_LIMIT),
              truncated: full.length > PREVIEW_TEXT_LIMIT,
              note: null,
            });
          }
        } else if (doc.kind === "md") {
          const full = await storedText();
          if (cancelled) return;

          if (full === null) {
            fail("Die Datei fehlt im Speicher.");
          } else if (full.trim() === "") {
            finish({
              view: "unsupported",
              reason: "Die Datei enthält keinen lesbaren Text.",
            });
          } else {
            finish({ view: "markdown", preview: parseMarkdown(full) });
          }
        } else if (doc.kind === "docx") {
          const bytes = await blobBytes();
          if (cancelled) return;

          if (bytes === null) {
            fail("Die Datei fehlt im Speicher.");

            return;
          }

          try {
            finish({
              view: "docx",
              preview: await extractDocxPreview(bytes),
            });
          } catch (previewError) {
            if (!(previewError instanceof ExtractError)) throw previewError;

            // Direct rendering failed (e.g. protected file): fall back
            // to the server-extracted text when processing succeeded.
            const fallback = await getDocumentText(doc.id);
            if (cancelled) return;

            if (fallback === null || fallback.trim() === "") {
              finish({
                view: "unsupported",
                reason: previewError.message,
              });
            } else {
              finish({
                view: "text",
                text: fallback.slice(0, PREVIEW_TEXT_LIMIT),
                truncated: fallback.length > PREVIEW_TEXT_LIMIT,
                note: `Direkte Darstellung nicht möglich (${previewError.message}) – Text aus der Dokumentenverarbeitung:`,
              });
            }
          }
        } else if (doc.kind === "pptx") {
          const bytes = await blobBytes();
          if (cancelled) return;

          if (bytes === null) {
            fail("Die Datei fehlt im Speicher.");

            return;
          }

          try {
            finish({
              view: "pptx",
              preview: await extractPptxPreview(bytes),
            });
          } catch (previewError) {
            if (!(previewError instanceof ExtractError)) throw previewError;

            const fallback = await getDocumentText(doc.id);
            if (cancelled) return;

            if (fallback === null || fallback.trim() === "") {
              finish({
                view: "unsupported",
                reason: previewError.message,
              });
            } else {
              finish({
                view: "text",
                text: fallback.slice(0, PREVIEW_TEXT_LIMIT),
                truncated: fallback.length > PREVIEW_TEXT_LIMIT,
                note: `Folien-Darstellung nicht möglich (${previewError.message}) – Text aus der Dokumentenverarbeitung:`,
              });
            }
          }
        } else {
          finish({
            view: "unsupported",
            reason: "Für dieses Dateiformat gibt es keine Vorschau.",
          });
        }
      } catch (loadError) {
        fail(
          loadError instanceof Error
            ? loadError.message
            : "Vorschau konnte nicht geladen werden.",
        );
      }
    }

    load();

    return () => {
      cancelled = true;

      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [doc.id, doc.kind, attempt]);

  return (
    <Modal
      titleId="document-preview-title"
      onClose={onClose}
      maxWidth="max-w-3xl"
    >
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
            {typeof doc.pageCount === "number" && doc.pageCount > 0
              ? ` · ${doc.pageCount} ${doc.kind === "pptx" ? (doc.pageCount === 1 ? "Folie" : "Folien") : "Seiten"}`
              : ""}
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
          <p role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Loader2 size={17} className="motion-safe:animate-spin" />
            Vorschau wird geladen …
          </p>
        ) : error !== null ? (
          <div className="py-10 text-center">
            <p role="alert" className="text-sm text-rose-300">
              {error}
            </p>
            <button
              onClick={() => {
                setLoading(true);
                setError(null);
                setContent(null);
                setAttempt((current) => current + 1);
              }}
              className="mt-4 inline-flex items-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-200"
            >
              <RotateCcw size={16} />
              Erneut versuchen
            </button>
          </div>
        ) : content?.view === "pdf" ? (
          <PdfView url={content.url} name={doc.name} />
        ) : content?.view === "docx" ? (
          <DocxView preview={content.preview} />
        ) : content?.view === "pptx" ? (
          <PptxView preview={content.preview} />
        ) : content?.view === "markdown" ? (
          <div>
            {content.preview.blocks.map((block, index) => (
              <MarkdownBlock key={index} block={block} />
            ))}
            {content.preview.truncated && (
              <p className="mt-3 text-xs text-slate-500">
                Vorschau gekürzt – lade die Datei herunter, um den
                vollständigen Text zu lesen.
              </p>
            )}
          </div>
        ) : content?.view === "text" ? (
          <div>
            {content.note !== null && (
              <p className="mb-3 rounded-xl border border-amber-300/25 bg-amber-300/5 px-3 py-2 text-xs leading-5 text-amber-200">
                {content.note}
              </p>
            )}
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/30 p-4 text-left text-sm leading-6 text-slate-200">
              {content.text}
            </pre>
            {content.truncated && (
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
              {content?.view === "unsupported"
                ? content.reason
                : "Für dieses Dateiformat gibt es keine Vorschau."}{" "}
              Lade das Dokument herunter, um es zu öffnen.
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
    </Modal>
  );
}
