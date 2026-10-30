/**
 * Study document extraction: bytes in, text blocks with source refs out.
 *
 * No dependencies and runtime-agnostic: the same functions run in the
 * browser (local mode) and in API routes (cloud mode), so both modes
 * extract identical text and identical page/slide/paragraph refs.
 *
 * Supported: PDF (text layer via the finance extractor), DOCX
 * (paragraphs), PPTX (slides), TXT/MD (line groups). Anything else —
 * corrupted files, password-protected files, scanned pages without a
 * text layer — fails with a typed `ExtractError`, never with
 * invented or half-parsed content.
 */

import {
  extractPdfText,
  PdfExtractError,
} from "@/src/lib/finance/pdf";

export type ExtractErrorCode =
  | "unsupported-kind"
  | "unsupported-content"
  | "corrupt"
  | "encrypted"
  | "scanned"
  | "empty"
  | "too-large";

export class ExtractError extends Error {
  code: ExtractErrorCode;

  constructor(code: ExtractErrorCode, message: string) {
    super(message);
    this.name = "ExtractError";
    this.code = code;
  }
}

/** One verifiable source location inside a document. */
export type SourceRef =
  | { kind: "page"; page: number }
  | { kind: "slide"; slide: number }
  | { kind: "paragraph"; paragraph: number }
  | { kind: "lines"; start: number; end: number };

export type ExtractedBlock = {
  text: string;
  ref: SourceRef;
};

export type ExtractedDocument = {
  blocks: ExtractedBlock[];
  warnings: string[];
};

export const EXTRACTABLE_KINDS = ["pdf", "docx", "pptx", "txt", "md"] as const;

export type ExtractableKind = (typeof EXTRACTABLE_KINDS)[number];

/** Mirrors the 10 MB upload cap (defense in depth). */
export const MAX_EXTRACT_BYTES = 10 * 1024 * 1024;

export function isExtractableKind(value: string): value is ExtractableKind {
  return (EXTRACTABLE_KINDS as readonly string[]).includes(value);
}

export function formatSourceRef(ref: SourceRef): string {
  switch (ref.kind) {
    case "page":
      return `Seite ${ref.page}`;
    case "slide":
      return `Folie ${ref.slide}`;
    case "paragraph":
      return `Absatz ${ref.paragraph}`;
    case "lines":
      return ref.start === ref.end
        ? `Zeile ${ref.start}`
        : `Zeilen ${ref.start}–${ref.end}`;
  }
}

/**
 * Merges consecutive same-kind refs into ranges ("Seiten 3–4").
 * Refs that cannot merge (mixed kinds, gaps) stay separate.
 */
export function formatSourceRefs(refs: SourceRef[]): string {
  const parts: string[] = [];
  let index = 0;

  while (index < refs.length) {
    const first = refs[index];

    if (first === undefined) break;

    let last = first;
    let next = index + 1;

    while (next < refs.length) {
      const candidate = refs[next];

      if (candidate === undefined || !isSuccessor(last, candidate)) break;

      last = candidate;
      next += 1;
    }

    parts.push(formatRefRange(first, last));
    index = next;
  }

  return parts.join(", ");
}

function refNumber(ref: SourceRef): number {
  switch (ref.kind) {
    case "page":
      return ref.page;
    case "slide":
      return ref.slide;
    case "paragraph":
      return ref.paragraph;
    case "lines":
      return ref.start;
  }
}

function isSuccessor(previous: SourceRef, candidate: SourceRef): boolean {
  if (previous.kind !== candidate.kind) return false;

  if (previous.kind === "lines" && candidate.kind === "lines") {
    return candidate.start === previous.end + 1;
  }

  return refNumber(candidate) === refNumber(previous) + 1;
}

function formatRefRange(first: SourceRef, last: SourceRef): string {
  if (first.kind !== last.kind || refNumber(first) === refNumber(last)) {
    if (first.kind === "lines" && last.kind === "lines") {
      return first.start === last.end && first.end === last.end
        ? formatSourceRef(first)
        : `Zeilen ${first.start}–${last.end}`;
    }

    return formatSourceRef(first);
  }

  const from = refNumber(first);
  const to = refNumber(last);

  switch (first.kind) {
    case "page":
      return `Seiten ${from}–${to}`;
    case "slide":
      return `Folien ${from}–${to}`;
    case "paragraph":
      return `Absätze ${from}–${to}`;
    case "lines":
      return `Zeilen ${from}–${last.kind === "lines" ? last.end : to}`;
  }
}

export function isSourceRef(value: unknown): value is SourceRef {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  switch (record.kind) {
    case "page":
      return (
        typeof record.page === "number" &&
        Number.isInteger(record.page) &&
        record.page >= 1
      );
    case "slide":
      return (
        typeof record.slide === "number" &&
        Number.isInteger(record.slide) &&
        record.slide >= 1
      );
    case "paragraph":
      return (
        typeof record.paragraph === "number" &&
        Number.isInteger(record.paragraph) &&
        record.paragraph >= 1
      );
    case "lines":
      return (
        typeof record.start === "number" &&
        Number.isInteger(record.start) &&
        record.start >= 1 &&
        typeof record.end === "number" &&
        Number.isInteger(record.end) &&
        record.end >= record.start
      );
    default:
      return false;
  }
}

export function parseSourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isSourceRef);
}

// ------------------------------------------------------------------ zip
// Minimal central-directory zip reader: enough for DOCX/PPTX (stored +
// raw-deflate entries), with bomb guards and CRC checks. Local-header
// sizes are ignored in favor of the central directory so files with
// data descriptors still parse.

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;

/** A 10 MB archive never legitimately holds more entries than this. */
const MAX_ZIP_ENTRIES = 4000;
/** Per-entry and total uncompressed caps (zip-bomb guard). */
const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024;
/** EOCD comment is at most 64 KiB, so the record sits in the tail. */
const EOCD_TAIL_BYTES = 66 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let n = 0; n < 256; n += 1) {
    let crc = n;

    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }

    table[n] = crc >>> 0;
  }

  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;

  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index])! & 0xff]! ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

type CentralEntry = {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function findEocd(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - EOCD_TAIL_BYTES);

  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (readU32(bytes, offset) === ZIP_EOCD_SIG) return offset;
  }

  return -1;
}

function parseCentralDirectory(bytes: Uint8Array): CentralEntry[] {
  // OLE compound files (legacy .doc/.ppt, password-protected Office)
  // are not zips; report them honestly instead of "corrupt".
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    throw new ExtractError(
      "encrypted",
      "Diese Office-Datei ist passwortgeschützt oder ein altes .doc/.ppt-Format. Bitte speichere sie ungeschützt als DOCX bzw. PPTX.",
    );
  }

  const eocd = findEocd(bytes);

  if (eocd < 0) {
    throw new ExtractError(
      "corrupt",
      "Die Datei ist kein lesbares ZIP-Archiv (DOCX/PPTX beschädigt?).",
    );
  }

  const count = readU16(bytes, eocd + 10);
  const centralOffset = readU32(bytes, eocd + 16);

  if (count > MAX_ZIP_ENTRIES) {
    throw new ExtractError(
      "corrupt",
      "Das Archiv enthält zu viele Einträge und wird nicht geöffnet.",
    );
  }

  const entries: CentralEntry[] = [];
  let offset = centralOffset;

  for (let index = 0; index < count; index += 1) {
    if (readU32(bytes, offset) !== ZIP_CENTRAL_SIG) {
      throw new ExtractError(
        "corrupt",
        "Das ZIP-Verzeichnis ist beschädigt.",
      );
    }

    const method = readU16(bytes, offset + 10);
    const crc = readU32(bytes, offset + 16);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);

    entries.push({
      name: new TextDecoder("utf-8").decode(nameBytes),
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();

  await writer.write(new Uint8Array(data));
  await writer.close();

  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    total += value.length;

    if (total > MAX_ZIP_ENTRY_BYTES) {
      throw new ExtractError(
        "too-large",
        "Ein Archiveintrag ist zu groß (mögliche Zip-Bombe).",
      );
    }

    parts.push(value);
  }

  const out = new Uint8Array(total);
  let at = 0;

  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

async function readZipEntry(
  bytes: Uint8Array,
  entry: CentralEntry,
): Promise<Uint8Array> {
  if (
    entry.method !== ZIP_METHOD_STORED &&
    entry.method !== ZIP_METHOD_DEFLATE
  ) {
    throw new ExtractError(
      "unsupported-content",
      `Der Archiveintrag „${entry.name}“ nutzt ein nicht unterstütztes Kompressionsverfahren.`,
    );
  }

  if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
    throw new ExtractError(
      "too-large",
      `Der Archiveintrag „${entry.name}“ ist zu groß.`,
    );
  }

  if (readU32(bytes, entry.localOffset) !== ZIP_LOCAL_SIG) {
    throw new ExtractError(
      "corrupt",
      `Der Archiveintrag „${entry.name}“ ist beschädigt.`,
    );
  }

  const nameLength = readU16(bytes, entry.localOffset + 26);
  const extraLength = readU16(bytes, entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  const raw = bytes.slice(dataOffset, dataOffset + entry.compressedSize);

  if (raw.length !== entry.compressedSize) {
    throw new ExtractError(
      "corrupt",
      `Der Archiveintrag „${entry.name}“ ist abgeschnitten.`,
    );
  }

  const data =
    entry.method === ZIP_METHOD_STORED ? raw : await inflateRaw(raw);

  if (crc32(data) !== entry.crc) {
    throw new ExtractError(
      "corrupt",
      `Der Archiveintrag „${entry.name}“ ist beschädigt (Prüfsumme).`,
    );
  }

  return data;
}

/** Reads exactly the wanted files; anything else stays untouched. */
async function readWantedEntries(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
): Promise<Map<string, string>> {
  const entries = parseCentralDirectory(bytes);
  const out = new Map<string, string>();
  const decoder = new TextDecoder("utf-8");
  let total = 0;

  for (const entry of entries) {
    if (!wanted(entry.name)) continue;

    const data = await readZipEntry(bytes, entry);
    total += data.length;

    if (total > MAX_ZIP_TOTAL_BYTES) {
      throw new ExtractError(
        "too-large",
        "Der entpackte Dokumenteninhalt ist zu groß.",
      );
    }

    out.set(entry.name, decoder.decode(data));
  }

  return out;
}

// ------------------------------------------------------------------ xml

function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Pulls `<tag:text>` runs; callers decide the grouping. */
function textRuns(xml: string, tag: "w:t" | "a:t"): string[] {
  const runs: string[] = [];
  const pattern =
    tag === "w:t"
      ? /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
      : /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(xml)) !== null) {
    runs.push(unescapeXml(match[1] ?? ""));
  }

  return runs;
}

function docxParagraphs(documentXml: string): ExtractedBlock[] {
  const chunks = documentXml.split("</w:p>");
  const blocks: ExtractedBlock[] = [];

  // Numbering counts every paragraph (even empty ones) so "Absatz N"
  // stays stable; empty paragraphs carry no text and are skipped.
  for (let index = 0; index < chunks.length - 1; index += 1) {
    const text = textRuns(chunks[index] ?? "", "w:t")
      .join("")
      .replace(/\s+/g, " ")
      .trim();

    if (text !== "") {
      blocks.push({ text, ref: { kind: "paragraph", paragraph: index + 1 } });
    }
  }

  return blocks;
}

function pptxSlideText(slideXml: string): string {
  // <a:p> groups runs into visual lines; keep the line breaks.
  return slideXml
    .split("</a:p>")
    .map((line) =>
      textRuns(line, "a:t").join("").replace(/\s+/g, " ").trim(),
    )
    .filter((line) => line !== "")
    .join("\n");
}

function slideNumber(name: string): number | null {
  const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);

  if (match === null) return null;

  const number = Number.parseInt(match[1] ?? "", 10);

  return Number.isInteger(number) && number >= 1 ? number : null;
}

// ------------------------------------------------------------------ kinds

async function extractPdfBlocks(bytes: Uint8Array): Promise<{
  blocks: ExtractedBlock[];
  warnings: string[];
}> {
  let parsed;

  try {
    parsed = await extractPdfText(bytes);
  } catch (error: unknown) {
    if (error instanceof PdfExtractError) {
      const code: ExtractErrorCode =
        error.code === "corrupt" ||
        error.code === "encrypted" ||
        error.code === "scanned"
          ? error.code
          : "unsupported-content";

      throw new ExtractError(code, error.message);
    }

    throw error;
  }

  const byPage = new Map<number, string[]>();
  const warnings = [...parsed.warnings];

  for (const line of parsed.lines) {
    const text = line.text.trim();

    if (text === "") continue;

    const list = byPage.get(line.page) ?? [];
    list.push(text);
    byPage.set(line.page, list);
  }

  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const blocks = pages.map((page) => ({
    text: (byPage.get(page) ?? []).join("\n"),
    ref: { kind: "page", page } as SourceRef,
  }));

  if (parsed.pageCount > pages.length) {
    warnings.push(
      `${parsed.pageCount - pages.length} von ${parsed.pageCount} Seiten enthalten keinen lesbaren Text.`,
    );
  }

  return { blocks, warnings };
}

async function extractDocxBlocks(
  bytes: Uint8Array,
): Promise<ExtractedDocument> {
  const files = await readWantedEntries(
    bytes,
    (name) =>
      name === "word/document.xml" ||
      name === "word/footnotes.xml" ||
      name === "word/endnotes.xml",
  );
  const documentXml = files.get("word/document.xml");

  if (documentXml === undefined) {
    throw new ExtractError(
      "corrupt",
      "Das DOCX-Archiv enthält kein Dokument (word/document.xml fehlt).",
    );
  }

  const blocks = docxParagraphs(documentXml);
  const warnings: string[] = [];

  for (const [name, label] of [
    ["word/footnotes.xml", "Fußnoten"],
    ["word/endnotes.xml", "Endnoten"],
  ] as const) {
    const xml = files.get(name);

    if (xml === undefined) continue;

    const notes = textRuns(xml, "w:t")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (notes !== "") {
      blocks.push({
        text: `${label}: ${notes}`,
        ref: { kind: "paragraph", paragraph: blocks.length + 1 },
      });
      warnings.push(`${label} wurden an den Text angehängt.`);
    }
  }

  return { blocks, warnings };
}

async function extractPptxBlocks(
  bytes: Uint8Array,
): Promise<ExtractedDocument> {
  const files = await readWantedEntries(
    bytes,
    (name) => slideNumber(name) !== null,
  );

  if (files.size === 0) {
    throw new ExtractError(
      "corrupt",
      "Das PPTX-Archiv enthält keine Folien (ppt/slides/ fehlt).",
    );
  }

  const names = [...files.keys()].sort(
    (a, b) => (slideNumber(a) ?? 0) - (slideNumber(b) ?? 0),
  );
  const blocks: ExtractedBlock[] = [];

  for (const name of names) {
    const text = pptxSlideText(files.get(name) ?? "");

    if (text !== "") {
      blocks.push({
        text,
        ref: { kind: "slide", slide: slideNumber(name) ?? 0 },
      });
    }
  }

  return { blocks, warnings: [] };
}

function extractTextBlocks(bytes: Uint8Array): ExtractedDocument {
  let text: string;
  const warnings: string[] = [];

  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("utf-8").decode(bytes);
    warnings.push(
      "Die Datei ist kein sauberes UTF-8; ungültige Zeichen wurden ersetzt.",
    );
  }

  const lines = text.split(/\r?\n/);
  const blocks: ExtractedBlock[] = [];
  const GROUP_LINES = 50;

  for (let start = 0; start < lines.length; start += GROUP_LINES) {
    const group = lines.slice(start, start + GROUP_LINES);
    const joined = group.join("\n").replace(/[ \t]+\n/g, "\n").trim();

    if (joined !== "") {
      blocks.push({
        text: joined,
        ref: { kind: "lines", start: start + 1, end: start + group.length },
      });
    }
  }

  return { blocks, warnings };
}

// ------------------------------------------------------------------ entry

/**
 * Extracts one document. Throws `ExtractError` for unsupported,
 * protected, corrupted, or textless input — callers map the code to
 * an extraction status and show the message.
 */
export async function extractDocument(
  kind: string,
  bytes: Uint8Array,
): Promise<ExtractedDocument> {
  if (!isExtractableKind(kind)) {
    throw new ExtractError(
      "unsupported-kind",
      `Texterkennung für diesen Dateityp wird nicht unterstützt.`,
    );
  }

  if (bytes.length > MAX_EXTRACT_BYTES) {
    throw new ExtractError(
      "too-large",
      "Die Datei ist zu groß für die Texterkennung (max. 10 MB).",
    );
  }

  if (bytes.length === 0) {
    throw new ExtractError("empty", "Die Datei ist leer.");
  }

  let result: ExtractedDocument;

  switch (kind) {
    case "pdf":
      result = await extractPdfBlocks(bytes);
      break;
    case "docx":
      result = await extractDocxBlocks(bytes);
      break;
    case "pptx":
      result = await extractPptxBlocks(bytes);
      break;
    case "txt":
    case "md":
      result = extractTextBlocks(bytes);
      break;
  }

  const nonEmpty = result.blocks.filter((block) => block.text !== "");

  if (nonEmpty.length === 0) {
    throw new ExtractError(
      "empty",
      "In der Datei wurde kein lesbarer Text gefunden.",
    );
  }

  return { blocks: nonEmpty, warnings: result.warnings };
}

/** Full plain text (block order); used for previews and text stores. */
export function blocksToText(blocks: ExtractedBlock[]): string {
  return blocks.map((block) => block.text).join("\n\n");
}
