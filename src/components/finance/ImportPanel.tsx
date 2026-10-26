"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  FileText,
  Info,
  Loader2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { createId } from "@/src/lib/ids";
import { CLOUD_ENABLED } from "@/src/lib/db/mode";
import {
  useCorrections,
  type ImportBatchInput,
} from "@/src/lib/db/useModules";
import type { RemoteResult } from "@/src/lib/db/useRemoteResource";
import {
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  centsToEuroInput,
  parseEuroToCents,
  type Transaction,
  type TransactionType,
} from "@/src/lib/finance";
import {
  MAX_PDF_SIZE_BYTES,
  PdfExtractError,
  extractPdfText,
  validatePdfFile,
} from "@/src/lib/finance/pdf";
import { parseStatement } from "@/src/lib/finance/statement";
import {
  correctionPatternFor,
  suggestCategory,
  type CategoryCorrection,
} from "@/src/lib/finance/categories";
import {
  alreadyImported,
  batchTransactions,
  detectDuplicates,
  listImportPdfs,
  reviewRowsToTransactions,
  type ImportBatchMeta,
  type ReviewRow,
} from "@/src/lib/finance/importStore";

export type ImportResultPayload = {
  batch: ImportBatchMeta;
  imported: number;
  pdfSaved: boolean;
};

type ImportPanelProps = {
  transactions: Transaction[];
  displayMonthKey: string;
  batches: ImportBatchMeta[];
  onImport: (
    rows: Transaction[],
    meta: ImportBatchInput,
    file: File,
  ) => Promise<RemoteResult<ImportResultPayload>>;
  onDeleteBatch: (batchId: string) => unknown;
  onDownloadPdf: (batchId: string) => Promise<RemoteResult<Blob>>;
  onDeletePdf: (batchId: string) => Promise<RemoteResult<null>>;
};

const CURRENCIES = ["EUR", "USD", "GBP", "CHF"] as const;

const DATE_FORMAT = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

function statementLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);

  if (!Number.isInteger(year) || !Number.isInteger(month)) return monthKey;

  return new Intl.DateTimeFormat("de-DE", {
    month: "long",
    year: "numeric",
  }).format(new Date(year, month - 1, 1));
}

function categoriesFor(type: TransactionType): readonly string[] {
  return type === "income" ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;
}

function isValidDateInput(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function ImportPanel({
  transactions,
  displayMonthKey,
  batches,
  onImport,
  onDeleteBatch,
  onDownloadPdf,
  onDeletePdf,
}: ImportPanelProps) {
  const [stage, setStage] = useState<"idle" | "reading" | "ready">("idle");
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [fileName, setFileName] = useState("");
  const [fileSize, setFileSize] = useState(0);
  const [statementMonth, setStatementMonth] = useState(displayMonthKey);
  const [pendingFile, setPendingFile] = useState<{
    name: string;
    size: number;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState<string | null>(null);
  const [deletingPdf, setDeletingPdf] = useState<string | null>(null);
  const [pdfIds, setPdfIds] = useState<Set<string>>(new Set());
  const [pdfMissing, setPdfMissing] = useState<Set<string>>(new Set());
  const correctionsStore = useCorrections();
  const corrections = correctionsStore.data;
  const fileRef = useRef<File | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function reloadPdfIds() {
    if (CLOUD_ENABLED) return;

    try {
      const list = await listImportPdfs();
      setPdfIds(new Set(list.map((item) => item.id)));
    } catch {
      setPdfIds(new Set());
    }
  }

  useEffect(() => {
    // Mount-gated: one read-only IndexedDB check for previously stored PDFs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reloadPdfIds();
  }, []);

  function reset() {
    fileRef.current = null;
    setStage("idle");
    setRows([]);
    setFileName("");
    setFileSize(0);
    setPendingFile(null);
    setError(null);
    setNotes([]);

    if (inputRef.current !== null) {
      inputRef.current.value = "";
    }
  }

  async function readAndParse(file: File) {
    setStage("reading");
    setPendingFile(null);
    setError(null);

    try {
      const buffer = await file.arrayBuffer();
      const extracted = await extractPdfText(buffer);
      const parsed = parseStatement(
        extracted.lines.map((line) => line.text),
      );

      if (parsed.transactions.length === 0) {
        setStage("idle");
        setNotes(parsed.warnings);
        setError(
          "In diesem PDF wurden keine Buchungen gefunden. Vermutlich enthält es kein lesbares Umsatzformat oder ist eingescannt (dafür wäre OCR nötig).",
        );
        return;
      }

      const decisions = detectDuplicates(parsed.transactions, transactions);
      const built: ReviewRow[] = parsed.transactions.map((item, index) => {
        const suggested = suggestCategory(
          item.description,
          item.type,
          corrections,
        );
        const duplicate = decisions[index] ?? "new";
        const reasons = [...item.reviewReasons];

        if (duplicate === "duplicate") {
          reasons.push("Exaktes Duplikat einer vorhandenen Buchung");
        }

        if (duplicate === "review") {
          reasons.push("Mögliches Duplikat – bitte prüfen");
        }

        return {
          date: item.date,
          amountCents: item.amountCents,
          type: item.type,
          description: item.description,
          tempId: item.tempId,
          include: duplicate !== "duplicate",
          amountInput: centsToEuroInput(item.amountCents),
          currency: item.currency,
          category: suggested.category,
          needsReview: reasons.length > 0,
          reviewReasons: reasons,
          duplicate,
        };
      });

      fileRef.current = file;
      setFileName(file.name);
      setFileSize(file.size);
      setRows(built);
      setNotes([
        ...extracted.warnings,
        ...parsed.warnings,
        ...(parsed.skippedLines.length > 0
          ? [
              `${parsed.skippedLines.length} ${parsed.skippedLines.length === 1 ? "Zeile" : "Zeilen"} ohne erkennbare Buchung übersprungen (Kopfzeilen, Salden, Hinweise).`,
            ]
          : []),
      ]);
      setStage("ready");
    } catch (unknown) {
      setStage("idle");

      if (unknown instanceof PdfExtractError) {
        setError(unknown.message);
      } else {
        setError(
          "Das PDF konnte nicht gelesen werden. Die Datei ist möglicherweise beschädigt.",
        );
      }
    }
  }

  async function processFile(file: File) {
    setError(null);
    setNotes([]);

    const validation = validatePdfFile(file);

    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    const same = alreadyImported(batches, file.name, file.size);

    if (same !== null) {
      fileRef.current = file;
      setPendingFile({ name: file.name, size: file.size });
      setNotes([
        `„${file.name}“ wurde bereits am ${DATE_FORMAT.format(new Date(same.importedAt))} importiert. Trotzdem fortfahren?`,
      ]);
      return;
    }

    await readAndParse(file);
  }

  function updateRow(
    tempId: string,
    patch: Partial<
      Pick<
        ReviewRow,
        | "include"
        | "date"
        | "description"
        | "amountInput"
        | "currency"
        | "type"
        | "category"
      >
    >,
  ) {
    setRows((current) =>
      current.map((row) =>
        row.tempId === tempId ? { ...row, ...patch } : row,
      ),
    );
  }

  function removeRow(tempId: string) {
    setRows((current) => current.filter((row) => row.tempId !== tempId));
  }

  const summary = useMemo(() => {
    let income = 0;
    let expense = 0;
    let included = 0;
    let invalid = 0;
    let duplicates = 0;
    let review = 0;
    let outsideMonth = 0;

    for (const row of rows) {
      if (row.duplicate === "duplicate") duplicates += 1;
      if (row.needsReview || row.duplicate !== "new") review += 1;
      if (!row.include) continue;

      included += 1;

      const cents = parseEuroToCents(row.amountInput);

      if (
        cents === null ||
        !isValidDateInput(row.date) ||
        row.description.trim() === ""
      ) {
        invalid += 1;
        continue;
      }

      if (row.date.slice(0, 7) !== statementMonth) {
        outsideMonth += 1;
      }

      if (row.type === "income") {
        income += cents;
      } else {
        expense += cents;
      }
    }

    return {
      income,
      expense,
      included,
      invalid,
      duplicates,
      review,
      outsideMonth,
      total: rows.length,
    };
  }, [rows, statementMonth]);

  async function confirmImport() {
    const file = fileRef.current;

    if (file === null || confirming) return;

    setConfirming(true);
    setError(null);

    try {
      const batchId = createId();
      const { transactions: fresh, skipped } = reviewRowsToTransactions(
        rows.filter((row) => row.include),
        batchId,
      );

      if (fresh.length === 0) {
        setError(
          "Keine gültige Buchung zum Importieren. Bitte prüfe die markierten Zeilen.",
        );
        return;
      }

      const next = [...corrections];
      let changed = false;

      for (const row of rows) {
        if (!row.include) continue;

        const suggested = suggestCategory(row.description, row.type, corrections);

        if (row.category === suggested.category) continue;

        const pattern = correctionPatternFor(row.description);

        if (pattern === "") continue;

        const existingIndex = next.findIndex(
          (item) => item.pattern === pattern && item.type === row.type,
        );
        const entry: CategoryCorrection = {
          pattern,
          category: row.category,
          type: row.type,
        };

        if (existingIndex >= 0) {
          next[existingIndex] = entry;
        } else {
          next.push(entry);
        }

        changed = true;
      }

      if (changed) {
        await correctionsStore.save(next.slice(-200));
      }

      const result = await onImport(
        fresh,
        {
          id: batchId,
          fileName: file.name,
          fileSize: file.size,
          statementMonth,
        },
        file,
      );

      if (!result.ok) {
        setError(result.error);
        return;
      }

      if (!result.data.pdfSaved) {
        setNotes((current) => [
          ...current,
          "Das PDF konnte nicht gespeichert werden (Speicher voll?) – die Buchungen wurden trotzdem importiert.",
        ]);
      }

      void reloadPdfIds();
      const skippedNote =
        skipped > 0
          ? [
              `${skipped} ${skipped === 1 ? "Zeile" : "Zeilen"} mit ungültigen Eingaben ${skipped === 1 ? "wurde" : "wurden"} übersprungen.`,
            ]
          : [];
      reset();
      setNotes(skippedNote);
    } finally {
      setConfirming(false);
    }
  }

  async function downloadPdf(batchId: string) {
    setError(null);

    const batch = batches.find((item) => item.id === batchId);
    const outcome = await onDownloadPdf(batchId);

    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }

    const url = URL.createObjectURL(outcome.data);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = batch?.fileName ?? "kontoauszug.pdf";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function removePdf(batchId: string) {
    const outcome = await onDeletePdf(batchId);

    if (!outcome.ok) {
      setError(outcome.error);
      return;
    }

    if (CLOUD_ENABLED) {
      setPdfMissing((current) => new Set([...current, batchId]));
    }

    setDeletingPdf(null);
    void reloadPdfIds();
  }

  const sortedBatches = useMemo(
    () =>
      [...batches].sort((a, b) => b.importedAt.localeCompare(a.importedAt)),
    [batches],
  );

  return (
    <div>
      <h2 className="font-semibold">Kontoauszug importieren</h2>
      <p className="mt-1 text-xs text-slate-500">
        PDF-Kontoauszug einlesen, prüfen und übernehmen. Das PDF selbst bleibt
        lokal in deinem Browser – nur übernommene Buchungen werden gespeichert.
        Max.{" "}
        {formatBytes(MAX_PDF_SIZE_BYTES)} pro Datei.
      </p>

      {error !== null && (
        <div
          role="alert"
          className="mt-4 flex gap-3 rounded-2xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-200"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {notes.length > 0 && (
        <ul className="mt-4 space-y-2">
          {notes.map((note, index) => (
            <li
              key={`${index}-${note.slice(0, 24)}`}
              className="flex gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-3 text-xs text-slate-300"
            >
              <Info size={16} className="mt-0.5 shrink-0 text-cyan-300" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      )}

      {stage === "idle" && pendingFile === null && (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            const file = event.dataTransfer.files?.[0];

            if (file !== undefined) {
              void processFile(file);
            }
          }}
          className={`mt-4 rounded-2xl border border-dashed p-6 text-center transition ${
            dragActive
              ? "border-cyan-300/60 bg-cyan-300/5"
              : "border-white/15"
          }`}
        >
          <Upload size={22} className="mx-auto text-cyan-300" />
          <p className="mt-3 text-sm text-slate-200">PDF hierher ziehen oder</p>
          <button
            onClick={() => inputRef.current?.click()}
            className="mt-3 rounded-xl bg-cyan-300 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-200"
          >
            PDF auswählen
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            aria-label="PDF-Kontoauszug auswählen"
            onChange={(event) => {
              const file = event.target.files?.[0];

              if (file !== undefined) {
                void processFile(file);
              }
            }}
          />
          <p className="mt-3 text-xs text-slate-500">
            Nur PDFs mit Textebene · eingescannte PDFs brauchen OCR (noch
            nicht verfügbar)
          </p>
        </div>
      )}

      {stage === "reading" && (
        <div
          aria-live="polite"
          className="mt-4 flex items-center gap-3 rounded-2xl border border-white/10 p-5 text-sm text-slate-300"
        >
          <Loader2 size={18} className="animate-spin text-cyan-300" />
          PDF wird gelesen und ausgewertet …
        </div>
      )}

      {pendingFile !== null && (
        <div className="mt-4 rounded-2xl border border-amber-300/30 bg-amber-300/5 p-4">
          <p className="text-sm text-amber-100">
            „{pendingFile.name}“ ({formatBytes(pendingFile.size)}) erneut
            einlesen?
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => {
                fileRef.current = null;
                setPendingFile(null);
                setNotes([]);
              }}
              className="rounded-xl border border-white/10 px-3 py-2 text-xs text-slate-300 transition hover:border-white/25 hover:text-white"
            >
              Abbrechen
            </button>
            <button
              onClick={() => {
                const file = fileRef.current;

                if (file !== null) {
                  void readAndParse(file);
                }
              }}
              className="rounded-xl bg-amber-200 px-3 py-2 text-xs font-medium text-slate-950 transition hover:bg-amber-100"
            >
              Trotzdem einlesen
            </button>
          </div>
        </div>
      )}

      {stage === "ready" && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 p-3 text-xs">
            <FileText size={16} className="shrink-0 text-cyan-300" />
            <span className="font-medium text-slate-200">{fileName}</span>
            <span className="text-slate-500">· {formatBytes(fileSize)}</span>
            <button
              onClick={reset}
              className="ml-auto rounded-xl border border-white/10 px-3 py-1.5 text-slate-300 transition hover:border-white/25 hover:text-white"
            >
              Abbrechen
            </button>
          </div>

          <label className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            Abrechnungsmonat
            <input
              type="month"
              value={statementMonth}
              onChange={(event) => setStatementMonth(event.target.value)}
              className="rounded-xl border border-white/10 bg-[#111827] px-3 py-2 text-xs text-white outline-none focus:border-cyan-300/50"
            />
          </label>

          <div aria-live="polite" className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-slate-300">
              {summary.total} erkannt
            </span>
            <span className="rounded-full border border-cyan-300/30 bg-cyan-300/5 px-2.5 py-1 text-cyan-100">
              {summary.included} ausgewählt
            </span>
            {summary.duplicates > 0 && (
              <span className="rounded-full border border-rose-400/30 bg-rose-400/5 px-2.5 py-1 text-rose-200">
                {summary.duplicates} Duplikate
              </span>
            )}
            {summary.review > 0 && (
              <span className="rounded-full border border-amber-300/30 bg-amber-300/5 px-2.5 py-1 text-amber-100">
                {summary.review} zu prüfen
              </span>
            )}
            {summary.outsideMonth > 0 && (
              <span className="rounded-full border border-white/10 px-2.5 py-1 text-slate-300">
                {summary.outsideMonth} außerhalb des Abrechnungsmonats
              </span>
            )}
          </div>

          <div className="overflow-x-auto rounded-2xl border border-white/10">
            <table className="w-full min-w-[920px] text-left text-xs">
              <thead>
                <tr className="border-b border-white/10 text-slate-400">
                  <th scope="col" className="p-3">
                    <input
                      type="checkbox"
                      checked={
                        rows.length > 0 && rows.every((row) => row.include)
                      }
                      onChange={(event) => {
                        const include = event.target.checked;
                        setRows((current) =>
                          current.map((row) => ({ ...row, include })),
                        );
                      }}
                      aria-label="Alle Zeilen umschalten"
                      className="h-4 w-4 accent-cyan-300"
                    />
                  </th>
                  <th scope="col" className="p-3 font-medium">
                    Datum
                  </th>
                  <th scope="col" className="p-3 font-medium">
                    Beschreibung
                  </th>
                  <th scope="col" className="p-3 font-medium">
                    Betrag
                  </th>
                  <th scope="col" className="p-3 font-medium">
                    Währung
                  </th>
                  <th scope="col" className="p-3 font-medium">
                    Typ
                  </th>
                  <th scope="col" className="p-3 font-medium">
                    Kategorie
                  </th>
                  <th scope="col" className="p-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="p-3">
                    <span className="sr-only">Zeile entfernen</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const amountOk =
                    parseEuroToCents(row.amountInput) !== null;
                  const dateOk = isValidDateInput(row.date);
                  const descOk = row.description.trim() !== "";
                  const valid = amountOk && dateOk && descOk;
                  const options = categoriesFor(row.type);
                  const statusTitle = row.reviewReasons.join(" · ");

                  return (
                    <tr
                      key={row.tempId}
                      className={`border-b border-white/5 last:border-0 ${
                        row.include ? "" : "opacity-50"
                      }`}
                    >
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={row.include}
                          onChange={(event) =>
                            updateRow(row.tempId, {
                              include: event.target.checked,
                            })
                          }
                          aria-label={`„${row.description}“ übernehmen`}
                          className="h-4 w-4 accent-cyan-300"
                        />
                      </td>
                      <td className="p-2">
                        <input
                          type="date"
                          value={row.date}
                          onChange={(event) =>
                            updateRow(row.tempId, { date: event.target.value })
                          }
                          aria-label="Buchungsdatum"
                          className={`rounded-lg border bg-[#111827] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50 ${
                            dateOk
                              ? "border-white/10"
                              : "border-rose-400/60"
                          }`}
                        />
                      </td>
                      <td className="p-2">
                        <input
                          type="text"
                          value={row.description}
                          onChange={(event) =>
                            updateRow(row.tempId, {
                              description: event.target.value,
                            })
                          }
                          aria-label="Beschreibung"
                          className={`w-44 rounded-lg border bg-[#111827] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50 ${
                            descOk
                              ? "border-white/10"
                              : "border-rose-400/60"
                          }`}
                        />
                      </td>
                      <td className="p-2">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={row.amountInput}
                          onChange={(event) =>
                            updateRow(row.tempId, {
                              amountInput: event.target.value,
                            })
                          }
                          aria-label="Betrag"
                          className={`w-24 rounded-lg border bg-[#111827] px-2 py-1.5 text-right text-xs tabular-nums text-white outline-none focus:border-cyan-300/50 ${
                            amountOk
                              ? "border-white/10"
                              : "border-rose-400/60"
                          }`}
                        />
                      </td>
                      <td className="p-2">
                        <select
                          value={row.currency}
                          onChange={(event) =>
                            updateRow(row.tempId, {
                              currency: event.target.value,
                            })
                          }
                          aria-label="Währung"
                          className="rounded-lg border border-white/10 bg-[#111827] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50"
                        >
                          {CURRENCIES.map((currency) => (
                            <option key={currency} value={currency}>
                              {currency}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-2">
                        <select
                          value={row.type}
                          onChange={(event) =>
                            updateRow(row.tempId, {
                              type:
                                event.target.value === "income"
                                  ? "income"
                                  : "expense",
                            })
                          }
                          aria-label="Ein- oder Ausgabe"
                          className="rounded-lg border border-white/10 bg-[#111827] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50"
                        >
                          <option value="expense">Ausgabe</option>
                          <option value="income">Einnahme</option>
                        </select>
                      </td>
                      <td className="p-2">
                        <select
                          value={row.category}
                          onChange={(event) =>
                            updateRow(row.tempId, {
                              category: event.target.value,
                            })
                          }
                          aria-label="Kategorie"
                          className="rounded-lg border border-white/10 bg-[#111827] px-2 py-1.5 text-xs text-white outline-none focus:border-cyan-300/50"
                        >
                          {!options.includes(row.category) && (
                            <option value={row.category}>
                              {row.category}
                            </option>
                          )}
                          {options.map((category) => (
                            <option key={category} value={category}>
                              {category}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="p-2">
                        {row.duplicate === "duplicate" ? (
                          <span
                            title={statusTitle}
                            className="inline-block rounded-full border border-rose-400/40 bg-rose-400/10 px-2 py-0.5 text-rose-200"
                          >
                            Duplikat
                          </span>
                        ) : row.include && !valid ? (
                          <span className="inline-block rounded-full border border-rose-400/40 bg-rose-400/10 px-2 py-0.5 text-rose-200">
                            Ungültig
                          </span>
                        ) : row.needsReview || row.duplicate !== "new" ? (
                          <span
                            title={statusTitle}
                            className="inline-block rounded-full border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 text-amber-100"
                          >
                            Prüfen
                          </span>
                        ) : (
                          <span className="inline-block rounded-full border border-emerald-300/30 bg-emerald-300/5 px-2 py-0.5 text-emerald-200">
                            OK
                          </span>
                        )}
                      </td>
                      <td className="p-2">
                        <button
                          onClick={() => removeRow(row.tempId)}
                          aria-label={`„${row.description}“ entfernen`}
                          className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white/5 hover:text-rose-200"
                        >
                          <X size={15} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {rows.length === 0 && (
            <p className="text-xs text-slate-500">
              Alle Zeilen entfernt – brich den Import ab oder wähle ein anderes
              PDF.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={reset}
              className="rounded-xl border border-white/10 px-4 py-2 text-sm text-slate-300 transition hover:border-white/25 hover:text-white"
            >
              Abbrechen
            </button>
            <button
              onClick={() => void confirmImport()}
              disabled={
                confirming ||
                summary.included === 0 ||
                summary.invalid >= summary.included
              }
              className="flex items-center gap-1.5 rounded-xl bg-cyan-300 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Check size={16} />
              {confirming
                ? "Wird importiert …"
                : `${summary.included - summary.invalid} ${
                    summary.included - summary.invalid === 1
                      ? "Buchung"
                      : "Buchungen"
                  } importieren`}
            </button>
            {summary.invalid > 0 && (
              <span className="text-xs text-rose-300">
                {summary.invalid} ungültige{" "}
                {summary.invalid === 1 ? "Zeile wird" : "Zeilen werden"}{" "}
                übersprungen.
              </span>
            )}
          </div>
        </div>
      )}

      <div className="mt-6 border-t border-white/[0.08] pt-5">
        <h3 className="text-sm font-semibold">Importierte Auszüge</h3>

        {sortedBatches.length === 0 ? (
          <p className="mt-2 text-xs leading-5 text-slate-500">
            Noch keine PDF-Importe. Eingelesene Auszüge erscheinen hier mit
            ihren Buchungen.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {sortedBatches.map((batch) => {
              const linked = batchTransactions(transactions, batch.id).length;
              const hasPdf = CLOUD_ENABLED
                ? !pdfMissing.has(batch.id)
                : pdfIds.has(batch.id);

              return (
                <li
                  key={batch.id}
                  className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <FileText size={15} className="shrink-0 text-cyan-300" />
                    <span className="font-medium text-slate-200">
                      {batch.fileName}
                    </span>
                    <span className="text-slate-500">
                      · {statementLabel(batch.statementMonth)} · {batch.count}{" "}
                      {batch.count === 1 ? "Buchung" : "Buchungen"} ·{" "}
                      {DATE_FORMAT.format(new Date(batch.importedAt))}
                    </span>
                  </div>
                  <p className="mt-1 text-slate-500">
                    {linked} von {batch.count}{" "}
                    {batch.count === 1 ? "Buchung ist" : "Buchungen sind"} noch
                    vorhanden
                    {hasPdf
                      ? " · PDF gespeichert."
                      : " · kein PDF gespeichert."}
                  </p>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {hasPdf && (
                      <button
                        onClick={() => void downloadPdf(batch.id)}
                        className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-1.5 text-slate-300 transition hover:border-white/25 hover:text-white"
                      >
                        <Download size={14} />
                        PDF laden
                      </button>
                    )}
                    {hasPdf && deletingPdf !== batch.id && (
                      <button
                        onClick={() => setDeletingPdf(batch.id)}
                        className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-1.5 text-slate-300 transition hover:border-white/25 hover:text-white"
                      >
                        <Trash2 size={14} />
                        PDF löschen
                      </button>
                    )}
                    {deletingBatch !== batch.id && (
                      <button
                        onClick={() => setDeletingBatch(batch.id)}
                        className="rounded-xl border border-rose-400/30 px-3 py-1.5 text-rose-200 transition hover:bg-rose-400/10"
                      >
                        Charge entfernen
                      </button>
                    )}
                  </div>

                  {deletingPdf === batch.id && (
                    <div className="mt-2 rounded-xl border border-white/10 p-3">
                      <p className="text-slate-300">
                        „{batch.fileName}“ wirklich löschen? Die {linked}{" "}
                        {linked === 1 ? "Buchung bleibt" : "Buchungen bleiben"}{" "}
                        erhalten.
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => setDeletingPdf(null)}
                          className="rounded-xl border border-white/10 px-3 py-1.5 text-slate-300 transition hover:border-white/25 hover:text-white"
                        >
                          Abbrechen
                        </button>
                        <button
                          onClick={() => void removePdf(batch.id)}
                          className="rounded-xl bg-rose-300 px-3 py-1.5 font-medium text-slate-950 transition hover:bg-rose-200"
                        >
                          PDF löschen
                        </button>
                      </div>
                    </div>
                  )}

                  {deletingBatch === batch.id && (
                    <div className="mt-2 rounded-xl border border-rose-400/30 bg-rose-400/5 p-3">
                      <p className="text-rose-100">
                        Charge entfernen? {linked} verknüpfte{" "}
                        {linked === 1 ? "Buchung wird" : "Buchungen werden"}{" "}
                        ebenfalls gelöscht. Manuell angelegte Buchungen bleiben
                        erhalten.
                      </p>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => setDeletingBatch(null)}
                          className="rounded-xl border border-white/10 px-3 py-1.5 text-slate-300 transition hover:border-white/25 hover:text-white"
                        >
                          Abbrechen
                        </button>
                        <button
                          onClick={() => {
                            void (async () => {
                              await onDeleteBatch(batch.id);
                              setDeletingBatch(null);
                            })();
                          }}
                          className="rounded-xl bg-rose-300 px-3 py-1.5 font-medium text-slate-950 transition hover:bg-rose-200"
                        >
                          Charge + Buchungen löschen
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
