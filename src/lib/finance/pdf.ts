/**
 * Minimal PDF text-layer extractor (no dependencies).
 *
 * Supported: header/xref-less files, FlateDecode content streams,
 * WinAnsi-encoded simple fonts, Differences arrays, positioned text.
 * Limitations (reported honestly, never silently wrong):
 * - encrypted PDFs, compressed object streams, ToUnicode/CID fonts,
 *   predictor streams, rotated text positioning, scanned pages (OCR).
 *
 * All byte offsets stay valid because parsing runs on a 1:1 latin1
 * view (string index == byte index).
 */

export type PdfExtractErrorCode =
  | "corrupt"
  | "encrypted"
  | "scanned"
  | "unsupported";

export class PdfExtractError extends Error {
  code: PdfExtractErrorCode;

  constructor(code: PdfExtractErrorCode) {
    super(PDF_ERROR_MESSAGES[code]);
    this.name = "PdfExtractError";
    this.code = code;
  }
}

export const PDF_ERROR_MESSAGES: Record<PdfExtractErrorCode, string> = {
  corrupt: "Die Datei ist beschädigt oder kein lesbares PDF.",
  encrypted:
    "Das PDF ist passwortgeschützt. Bitte lade eine ungeschützte Version hoch.",
  scanned:
    "Im PDF wurde keine Textebene gefunden – vermutlich ist es eingescannt. Dafür wäre OCR nötig, das es in dieser Version noch nicht gibt.",
  unsupported:
    "Dieses PDF verwendet Funktionen, die noch nicht unterstützt werden (z. B. spezielle Schriften oder komprimierte Objektströme).",
};

export type PdfTextLine = {
  /** 1-based page number. */
  page: number;
  /** PDF y coordinate (grows upwards); lines are pre-sorted top-down. */
  y: number;
  text: string;
};

export type ExtractedPdf = {
  pageCount: number;
  lines: PdfTextLine[];
  warnings: string[];
};

/**
 * Future OCR boundary. No implementation ships in this phase; when one
 * is added it registers here and the import pipeline can consult it
 * for scanned PDFs without touching this extractor.
 */
export interface OcrExtractor {
  readonly id: string;
  readonly label: string;
  extractLines(imageBytes: Uint8Array): Promise<PdfTextLine[]>;
}

let ocrExtractor: OcrExtractor | null = null;

export function registerOcrExtractor(extractor: OcrExtractor): void {
  ocrExtractor = extractor;
}

export function getOcrExtractor(): OcrExtractor | null {
  return ocrExtractor;
}

/** Maximum import size: 15 MB per file. */
export const MAX_PDF_SIZE_BYTES = 15 * 1024 * 1024;

export function validatePdfFile(
  file: File,
): { ok: true } | { ok: false; error: string } {
  const dot = file.name.lastIndexOf(".");
  const extension =
    dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";

  if (extension !== "pdf") {
    return {
      ok: false,
      error: `„${file.name}“ ist kein PDF. Es werden nur PDF-Dateien unterstützt.`,
    };
  }

  if (
    file.type !== "" &&
    file.type !== "application/pdf" &&
    file.type !== "application/octet-stream"
  ) {
    return {
      ok: false,
      error: `„${file.name}“: Der erkannte Dateityp passt nicht zu einem PDF.`,
    };
  }

  if (file.size <= 0) {
    return { ok: false, error: `„${file.name}“ ist leer.` };
  }

  if (file.size > MAX_PDF_SIZE_BYTES) {
    return {
      ok: false,
      error: `„${file.name}“ ist zu groß. Maximal 15 MB pro Datei.`,
    };
  }

  return { ok: true };
}

const WIN1252_EXTRA: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
  0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
  0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’",
  0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ",
  0x9e: "ž", 0x9f: "Ÿ",
};

function winAnsiChar(code: number): string {
  if (code < 0x80 || code >= 0xa0) {
    return String.fromCharCode(code);
  }

  return WIN1252_EXTRA[code] ?? "";
}

const GLYPH_TO_UNICODE: Record<string, string> = {
  space: " ", germandbls: "ß", Adieresis: "Ä", adieresis: "ä",
  Odieresis: "Ö", odieresis: "ö", Udieresis: "Ü", udieresis: "ü",
  Euro: "€", quotedblbase: "„", quotedblleft: "“", quotedblright: "”",
  quoteleft: "‘", quoteright: "’", quotesinglebase: "‚",
  quotesinglbase: "‚", endash: "–", emdash: "—", bullet: "•",
  trademark: "™", copyright: "©", registered: "®", degree: "°",
  plusminus: "±", multiply: "×", divide: "÷", ae: "æ", AE: "Æ",
  oe: "œ", OE: "Œ", guilsinglleft: "‹", guilsinglright: "›",
  guillemotleft: "«", guillemotright: "»", dagger: "†",
  daggerdbl: "‡", perthousand: "‰", circumflex: "ˆ", tilde: "˜",
  dieresis: "¨", acute: "´", grave: "`", cedilla: "¸", ring: "˚",
  hungarumlaut: "˝", ogonek: "˛", caron: "ˇ", breve: "˘",
  dotaccent: "˙", macron: "¯", onehalf: "½", onequarter: "¼",
  threequarters: "¾",
};

for (let c = 65; c <= 90; c += 1) {
  const letter = String.fromCharCode(c);
  GLYPH_TO_UNICODE[letter] = letter;
  GLYPH_TO_UNICODE[letter.toLowerCase()] = letter.toLowerCase();
}

for (let c = 48; c <= 57; c += 1) {
  const digit = String.fromCharCode(c);
  GLYPH_TO_UNICODE[digit] = digit;
}

function glyphToUnicode(name: string): string {
  const known = GLYPH_TO_UNICODE[name];
  if (known !== undefined) return known;
  if (name.length === 1) return name;

  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (uni) return String.fromCharCode(Number.parseInt(uni[1], 16));

  return "";
}

function bytesToLatin1(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let out = "";

  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }

  return out;
}

function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);

  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }

  return out;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const raw = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });

  // The lib's DecompressionStream types predate generic streams; narrow here.
  const pipe = new DecompressionStream("deflate") as unknown as {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  const stream = raw.pipeThrough(pipe);

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type PdfValue =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "str"; v: string }
  | { t: "ref"; num: number; gen: number }
  | { t: "arr"; items: PdfValue[] }
  | { t: "dict"; map: Map<string, PdfValue> }
  | { t: "bool"; v: boolean }
  | { t: "null" };

function isPdfSpace(char: string): boolean {
  return (
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "\f" ||
    char === "\0"
  );
}

function isPdfDelimiter(char: string): boolean {
  return (
    char === "(" ||
    char === ")" ||
    char === "<" ||
    char === ">" ||
    char === "[" ||
    char === "]" ||
    char === "/" ||
    char === "%"
  );
}

class ModelCursor {
  index = 0;
  src: string;

  constructor(src: string) {
    this.src = src;
  }

  skipSpace(): void {
    while (this.index < this.src.length) {
      const char = this.src[this.index];

      if (char === "%") {
        while (
          this.index < this.src.length &&
          this.src[this.index] !== "\n" &&
          this.src[this.index] !== "\r"
        ) {
          this.index += 1;
        }

        continue;
      }

      if (!isPdfSpace(char)) return;
      this.index += 1;
    }
  }

  parseValue(): PdfValue | null {
    this.skipSpace();
    if (this.index >= this.src.length) return null;

    const char = this.src[this.index];

    if (char === "(") return { t: "str", v: this.parseLiteral() };
    if (char === "<") {
      if (this.src[this.index + 1] === "<") return this.parseDict();

      return { t: "str", v: this.parseHex() };
    }
    if (char === "[") return this.parseArray();
    if (char === "/") return { t: "name", v: this.parseName() };
    if (char === "t" || char === "f") return this.parseBool();
    if (char === "n") {
      this.index += 4;

      return { t: "null" };
    }
    if (
      (char >= "0" && char <= "9") ||
      char === "+" ||
      char === "-" ||
      char === "."
    ) {
      return this.parseNumberOrRef();
    }

    return null;
  }

  parseBool(): PdfValue {
    if (this.src.startsWith("true", this.index)) {
      this.index += 4;

      return { t: "bool", v: true };
    }

    this.index += 5; // "false"

    return { t: "bool", v: false };
  }

  parseNumberOrRef(): PdfValue {
    const start = this.index;

    while (
      this.index < this.src.length &&
      /[0-9+\-.eE]/.test(this.src[this.index])
    ) {
      this.index += 1;
    }

    const first = Number(this.src.slice(start, this.index));
    const saved = this.index;
    this.skipSpace();

    const secondStart = this.index;
    let digits = 0;

    while (
      this.index < this.src.length &&
      this.src[this.index] >= "0" &&
      this.src[this.index] <= "9"
    ) {
      this.index += 1;
      digits += 1;
    }

    if (digits > 0) {
      const second = Number(this.src.slice(secondStart, this.index));
      this.skipSpace();

      if (this.src[this.index] === "R") {
        this.index += 1;

        return { t: "ref", num: first, gen: second };
      }
    }

    this.index = saved;

    return { t: "num", v: first };
  }

  parseName(): string {
    // Caller consumed the leading slash check; skip it here.
    this.index += 1;
    let out = "";

    while (this.index < this.src.length) {
      const char = this.src[this.index];

      if (isPdfSpace(char) || isPdfDelimiter(char)) break;

      if (
        char === "#" &&
        this.index + 2 < this.src.length &&
        /[0-9A-Fa-f]{2}/.test(this.src.slice(this.index + 1, this.index + 3))
      ) {
        out += String.fromCharCode(
          Number.parseInt(this.src.slice(this.index + 1, this.index + 3), 16),
        );
        this.index += 3;
      } else {
        out += char;
        this.index += 1;
      }
    }

    return out;
  }

  parseLiteral(): string {
    this.index += 1; // consume (
    let out = "";
    let depth = 1;

    while (this.index < this.src.length && depth > 0) {
      const char = this.src[this.index];

      if (char === "\\") {
        const next = this.src[this.index + 1] ?? "";
        this.index += 2;

        if (next === "n") out += "\n";
        else if (next === "r") out += "\r";
        else if (next === "t") out += "\t";
        else if (next === "b") out += "\b";
        else if (next === "f") out += "\f";
        else if (next === "\n") out += "";
        else if (next === "\r") {
          if (this.src[this.index] === "\n") this.index += 1;
          out += "";
        } else if (next >= "0" && next <= "7") {
          let octal = next;
          this.index -= 1;

          for (let i = 0; i < 2; i += 1) {
            const digit = this.src[this.index + 1];
            if (digit === undefined || digit < "0" || digit > "7") break;
            octal += digit;
            this.index += 1;
          }

          this.index += 1;
          out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
        } else {
          out += next;
        }

        continue;
      }

      if (char === "(") {
        depth += 1;
        out += char;
        this.index += 1;
        continue;
      }

      if (char === ")") {
        depth -= 1;
        this.index += 1;

        if (depth > 0) out += char;
        continue;
      }

      out += char;
      this.index += 1;
    }

    return out;
  }

  parseHex(): string {
    this.index += 1; // consume <
    let hex = "";

    while (this.index < this.src.length && this.src[this.index] !== ">") {
      const char = this.src[this.index];
      this.index += 1;

      if (!isPdfSpace(char)) hex += char;
    }

    this.index += 1; // consume >
    if (hex.length % 2 === 1) hex += "0";

    let out = "";

    for (let i = 0; i < hex.length; i += 2) {
      out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
    }

    return out;
  }

  parseArray(): PdfValue {
    this.index += 1; // consume [
    const items: PdfValue[] = [];

    for (;;) {
      this.skipSpace();
      if (this.index >= this.src.length) break;
      if (this.src[this.index] === "]") {
        this.index += 1;
        break;
      }

      const value = this.parseValue();
      if (value === null) {
        this.index += 1;
        continue;
      }

      items.push(value);
    }

    return { t: "arr", items };
  }

  parseDict(): PdfValue {
    this.index += 2; // consume <<
    const map = new Map<string, PdfValue>();

    for (;;) {
      this.skipSpace();
      if (this.index >= this.src.length) break;

      if (
        this.src[this.index] === ">" &&
        this.src[this.index + 1] === ">"
      ) {
        this.index += 2;
        break;
      }

      if (this.src[this.index] !== "/") {
        this.index += 1;
        continue;
      }

      const key = this.parseName();
      const value = this.parseValue();

      if (value !== null) {
        map.set(key, value);
      }
    }

    return { t: "dict", map };
  }
}

type RawObject = {
  num: number;
  gen: number;
  dictSrc: string;
  stream: string | null;
};

function skipEol(src: string, index: number): number {
  if (src[index] === "\r" && src[index + 1] === "\n") return index + 2;
  if (src[index] === "\r" || src[index] === "\n") return index + 1;

  return index;
}

function scanObjects(src: string): Map<string, RawObject> {
  const objects = new Map<string, RawObject>();
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
  let guard = 0;
  let match = pattern.exec(src);

  while (match !== null) {
    guard += 1;
    if (guard > 200_000) break;

    const num = Number(match[1]);
    const gen = Number(match[2]);
    const bodyStart = match.index + match[0].length;
    const endobj = src.indexOf("endobj", bodyStart);
    const streamKw = src.indexOf("stream", bodyStart);
    let dictSrc: string;
    let stream: string | null = null;

    if (endobj === -1) {
      match = pattern.exec(src);
      continue;
    }

    if (streamKw !== -1 && streamKw < endobj) {
      dictSrc = src.slice(bodyStart, streamKw);
      const lengthMatch = /\/Length\s+(\d+)/.exec(dictSrc);
      const dataStart = skipEol(src, streamKw + 6);

      if (lengthMatch) {
        const length = Number(lengthMatch[1]);
        stream = src.slice(dataStart, dataStart + length);
      }
    } else {
      dictSrc = src.slice(bodyStart, endobj);
    }

    objects.set(`${num} ${gen}`, { num, gen, dictSrc, stream });
    match = pattern.exec(src);
  }

  return objects;
}

function parseDictSrc(dictSrc: string): Map<string, PdfValue> {
  const cursor = new ModelCursor(dictSrc);
  cursor.skipSpace();

  if (dictSrc.startsWith("<<", cursor.index)) {
    const value = cursor.parseDict();

    if (value.t === "dict") return value.map;
  }

  return new Map();
}

type TextRun = { x: number; y: number; size: number; text: string };

type ContentToken =
  | { t: "str"; bytes: number[] }
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "op"; v: string }
  | { t: "arr"; items: ContentToken[] };

function parseContentString(src: string, index: number): {
  bytes: number[];
  next: number;
} {
  let i = index + 1; // consume (
  const bytes: number[] = [];
  let depth = 1;

  while (i < src.length && depth > 0) {
    const code = src.charCodeAt(i);

    if (src[i] === "\\") {
      const next = src[i + 1] ?? "";
      i += 2;

      if (next === "n") bytes.push(10);
      else if (next === "r") bytes.push(13);
      else if (next === "t") bytes.push(9);
      else if (next === "b") bytes.push(8);
      else if (next === "f") bytes.push(12);
      else if (next === "\n") outnoop();
      else if (next === "\r") {
        if (src[i] === "\n") i += 1;
      } else if (next >= "0" && next <= "7") {
        let octal = next;
        i -= 1;

        for (let k = 0; k < 2; k += 1) {
          const digit = src[i + 1];
          if (digit === undefined || digit < "0" || digit > "7") break;
          octal += digit;
          i += 1;
        }

        i += 1;
        bytes.push(Number.parseInt(octal, 8) & 0xff);
      } else if (next !== "") {
        bytes.push(next.charCodeAt(0) & 0xff);
      }

      continue;
    }

    if (src[i] === "(") {
      depth += 1;
      bytes.push(code);
      i += 1;
      continue;
    }

    if (src[i] === ")") {
      depth -= 1;
      i += 1;

      if (depth > 0) bytes.push(code);
      continue;
    }

    bytes.push(code & 0xff);
    i += 1;
  }

  function outnoop(): void {
    // line continuation: nothing to emit
  }

  return { bytes, next: i };
}

function tokenizeContent(src: string): ContentToken[] {
  const tokens: ContentToken[] = [];
  let i = 0;

  function skipSpaceAndComments(): void {
    while (i < src.length) {
      if (src[i] === "%") {
        while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i += 1;
        continue;
      }

      if (!isPdfSpace(src[i])) return;
      i += 1;
    }
  }

  function parseArray(): ContentToken[] {
    i += 1; // consume [
    const items: ContentToken[] = [];

    for (;;) {
      skipSpaceAndComments();
      if (i >= src.length || src[i] === "]") {
        i += 1;
        break;
      }

      if (src[i] === "(") {
        const parsed = parseContentString(src, i);
        i = parsed.next;
        items.push({ t: "str", bytes: parsed.bytes });
      } else if (src[i] === "<") {
        let hex = "";
        i += 1;

        while (i < src.length && src[i] !== ">") {
          if (!isPdfSpace(src[i])) hex += src[i];
          i += 1;
        }

        i += 1;
        if (hex.length % 2 === 1) hex += "0";

        const bytes: number[] = [];

        for (let k = 0; k < hex.length; k += 2) {
          const byte = Number.parseInt(hex.slice(k, k + 2), 16);
          bytes.push(Number.isNaN(byte) ? 32 : byte);
        }

        items.push({ t: "str", bytes });
      } else if (/[0-9+\-.]/.test(src[i])) {
        const start = i;

        while (i < src.length && /[0-9+\-.eE]/.test(src[i])) i += 1;
        items.push({ t: "num", v: Number(src.slice(start, i)) });
      } else {
        i += 1;
      }
    }

    return items;
  }

  while (i < src.length) {
    skipSpaceAndComments();
    if (i >= src.length) break;

    const char = src[i];

    if (char === "(") {
      const parsed = parseContentString(src, i);
      i = parsed.next;
      tokens.push({ t: "str", bytes: parsed.bytes });
    } else if (char === "<") {
      if (src[i + 1] === "<") {
        i += 2;
      } else {
        // Reuse array hex logic via a tiny local parse.
        let hex = "";
        i += 1;

        while (i < src.length && src[i] !== ">") {
          if (!isPdfSpace(src[i])) hex += src[i];
          i += 1;
        }

        i += 1;
        if (hex.length % 2 === 1) hex += "0";

        const bytes: number[] = [];

        for (let k = 0; k < hex.length; k += 2) {
          const byte = Number.parseInt(hex.slice(k, k + 2), 16);
          bytes.push(Number.isNaN(byte) ? 32 : byte);
        }

        tokens.push({ t: "str", bytes });
      }
    } else if (char === "[") {
      tokens.push({ t: "arr", items: parseArray() });
    } else if (char === "/") {
      let name = "";
      i += 1;

      while (
        i < src.length &&
        !isPdfSpace(src[i]) &&
        !isPdfDelimiter(src[i])
      ) {
        name += src[i];
        i += 1;
      }

      tokens.push({ t: "name", v: name });
    } else if (/[0-9+\-.]/.test(char)) {
      const start = i;

      while (i < src.length && /[0-9+\-.eE]/.test(src[i])) i += 1;
      tokens.push({ t: "num", v: Number(src.slice(start, i)) });
    } else if (/[A-Za-z'"]/.test(char)) {
      const start = i;

      while (i < src.length && /[A-Za-z0-9*'"_-]/.test(src[i])) i += 1;
      const word = src.slice(start, i);

      if (word === "BI") {
        // Inline image: skip binary data until the EI terminator.
        let end = i;

        for (;;) {
          end = src.indexOf("EI", end);
          if (end === -1) {
            i = src.length;
            break;
          }

          const before = src[end - 1] ?? " ";
          const after = src[end + 2] ?? " ";

          if (isPdfSpace(before) && (isPdfSpace(after) || after === ">")) {
            i = end + 2;
            break;
          }

          end += 2;
        }
      } else {
        tokens.push({ t: "op", v: word });
      }
    } else {
      i += 1;
    }
  }

  return tokens;
}

type ResolvedFont = {
  usable: boolean;
  decode: (code: number) => string;
};

function resolveFont(
  fontValue: PdfValue | undefined,
  resolve: (value: PdfValue | undefined) => PdfValue | undefined,
): ResolvedFont {
  const winAnsi = { usable: true, decode: winAnsiChar };
  const direct =
    fontValue?.t === "ref" ? resolve(fontValue) : fontValue;

  if (direct?.t !== "dict") return winAnsi;

  const subtype = direct.map.get("Subtype");
  if (
    subtype?.t === "name" &&
    (subtype.v === "Type0" ||
      subtype.v.startsWith("CIDFont"))
  ) {
    return { usable: false, decode: () => "" };
  }

  if (direct.map.has("ToUnicode")) {
    return { usable: false, decode: () => "" };
  }

  const encodingRaw = direct.map.get("Encoding");
  const encoding =
    encodingRaw?.t === "ref" ? resolve(encodingRaw) : encodingRaw;

  if (encoding === undefined) return winAnsi;
  if (encoding.t === "name") {
    if (encoding.v === "WinAnsiEncoding") return winAnsi;

    return { usable: false, decode: () => "" };
  }
  if (encoding.t !== "dict") return winAnsi;

  const base = encoding.map.get("BaseEncoding");
  if (
    base?.t === "name" &&
    base.v !== "WinAnsiEncoding" &&
    base.v !== "StandardEncoding"
  ) {
    return { usable: false, decode: () => "" };
  }

  const differences = encoding.map.get("Differences");
  if (differences?.t !== "arr") return winAnsi;

  const map = new Map<number, string>();
  let code = 0;

  for (const item of differences.items) {
    if (item.t === "num") {
      code = item.v;
    } else if (item.t === "name") {
      map.set(code, glyphToUnicode(item.v));
      code += 1;
    }
  }

  return {
    usable: true,
    decode: (value: number) => map.get(value) ?? winAnsiChar(value),
  };
}

type TextState = {
  font: ResolvedFont;
  size: number;
  leading: number;
  x: number;
  y: number;
};

function freshTextState(defaultFont: ResolvedFont): TextState {
  return { font: defaultFont, size: 12, leading: 0, x: 0, y: 0 };
}

function runContentTokens(
  tokens: ContentToken[],
  state: TextState,
  fonts: Map<string, ResolvedFont>,
  runs: TextRun[],
  skipped: { count: number },
): void {
  const stack: (number | string)[] = [];

  function popNumbers(count: number): number[] {
    const out: number[] = [];

    for (let i = 0; i < count; i += 1) {
      const value = stack.pop();
      out.unshift(typeof value === "number" ? value : 0);
    }

    return out;
  }

  function emit(bytes: number[]): void {
    if (!state.font.usable) {
      skipped.count += 1;
      return;
    }

    let text = "";

    for (const byte of bytes) {
      text += state.font.decode(byte);
    }

    if (text !== "") {
      runs.push({ x: state.x, y: state.y, size: state.size, text });
    }

    state.x += text.length * state.size * 0.5;
  }

  for (const token of tokens) {
    if (token.t === "num") {
      stack.push(token.v);
    } else if (token.t === "name") {
      stack.push(token.v);
    } else if (token.t === "str") {
      // Awaiting its showing operator; TJ arrays carry their own.
      stack.push(`\0STR${runs.length}:${token.bytes.join(",")}`);
    } else if (token.t === "arr") {
      let combined = "";

      for (const item of token.items) {
        if (item.t === "str") {
          if (!state.font.usable) {
            skipped.count += 1;
            continue;
          }

          for (const byte of item.bytes) {
            combined += state.font.decode(byte);
          }
        } else if (item.t === "num" && item.v < -120) {
          combined += " ";
        }
      }

      if (combined !== "" && state.font.usable) {
        runs.push({ x: state.x, y: state.y, size: state.size, text: combined });
        state.x += combined.length * state.size * 0.5;
      }

      stack.length = 0;
    } else if (token.t === "op") {
      const op = token.v;

      if (op === "BT") {
        state.x = 0;
        state.y = 0;
        stack.length = 0;
      } else if (op === "Tf") {
        const size = stack.pop();
        const name = stack.pop();
        state.size =
          typeof size === "number" && size > 0 && size < 1000 ? size : 12;

        if (typeof name === "string") {
          state.font =
            fonts.get(name) ??
            ({ usable: true, decode: winAnsiChar } as ResolvedFont);
        }

        stack.length = 0;
      } else if (op === "Tm") {
        const [a, b, c, d, e, f] = popNumbers(6);
        void a;
        void b;
        void c;
        void d;
        state.x = e;
        state.y = f;
      } else if (op === "Td" || op === "TD") {
        const [tx, ty] = popNumbers(2);
        if (op === "TD") state.leading = -ty;
        state.x += tx;
        state.y += ty;
      } else if (op === "TL") {
        const [ty] = popNumbers(1);
        state.leading = ty;
      } else if (op === "T*") {
        state.y -= state.leading !== 0 ? state.leading : state.size;
      } else if (op === "Tj" || op === "'" || op === '"') {
        if (op !== "Tj") {
          state.y -= state.leading !== 0 ? state.leading : state.size;
        }

        const top = stack.pop();

        if (typeof top === "string" && top.startsWith("\0STR")) {
          const bytes = top
            .slice(top.indexOf(":") + 1)
            .split(",")
            .filter((part) => part !== "")
            .map(Number);
          emit(bytes);
        }

        stack.length = 0;
      } else {
        stack.length = Math.max(0, stack.length - 6);
      }
    }
  }
}

export async function extractPdfText(
  input: Uint8Array | ArrayBuffer,
): Promise<ExtractedPdf> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const src = bytesToLatin1(bytes);

  if (!src.slice(0, 1024).includes("%PDF-")) {
    throw new PdfExtractError("corrupt");
  }

  if (/(^|[^\w])\/Encrypt\b/.test(src)) {
    throw new PdfExtractError("encrypted");
  }

  const objects = scanObjects(src);

  if (objects.size === 0) {
    throw new PdfExtractError("corrupt");
  }

  const parsed = new Map<string, Map<string, PdfValue>>();

  function objectDict(key: string): Map<string, PdfValue> | null {
    const cached = parsed.get(key);
    if (cached) return cached;

    const raw = objects.get(key);
    if (!raw) return null;

    const map = parseDictSrc(raw.dictSrc);
    parsed.set(key, map);

    return map;
  }

  function resolve(value: PdfValue | undefined): PdfValue | undefined {
    if (value?.t !== "ref") return value;

    const target = objects.get(`${value.num} ${value.gen}`);
    if (!target) return undefined;

    return { t: "dict", map: objectDict(`${value.num} ${value.gen}`) ?? new Map() };
  }

  function refKey(value: PdfValue | undefined): string | null {
    if (value?.t !== "ref") return null;

    return `${value.num} ${value.gen}`;
  }

  let catalog: Map<string, PdfValue> | null = null;
  const trailerAt = src.lastIndexOf("trailer");

  if (trailerAt !== -1) {
    const cursor = new ModelCursor(src.slice(trailerAt + 7));
    const trailer = cursor.parseDict();

    if (trailer.t === "dict") {
      const root = resolve(trailer.map.get("Root"));
      if (root?.t === "dict") catalog = root.map;
    }
  }

  if (!catalog) {
    for (const key of objects.keys()) {
      const dict = objectDict(key);
      const type = dict?.get("Type");

      if (type?.t === "name" && type.v === "Catalog") {
        catalog = dict ?? null;
        break;
      }
    }
  }

  if (!catalog) {
    throw new PdfExtractError("corrupt");
  }

  type PageInfo = {
    contents: string[];
    resources: Map<string, PdfValue> | null;
  };
  const pages: PageInfo[] = [];

  function walkPages(
    node: Map<string, PdfValue> | null,
    inherited: Map<string, PdfValue> | null,
  ): void {
    if (!node) return;

    const kidsRaw = node.get("Kids");
    const kids = kidsRaw?.t === "ref" ? resolve(kidsRaw) : kidsRaw;

    if (kids?.t !== "arr") return;

    for (const kid of kids.items) {
      const resolved = kid.t === "ref" ? resolve(kid) : kid;
      if (resolved?.t !== "dict") continue;

      const type = resolved.map.get("Type");
      const ownResourcesRaw = resolved.map.get("Resources");
      const ownResources =
        ownResourcesRaw?.t === "ref"
          ? resolve(ownResourcesRaw)
          : ownResourcesRaw;
      const resources =
        ownResources?.t === "dict" ? ownResources.map : inherited;

      if (type?.t === "name" && type.v === "Pages") {
        walkPages(resolved.map, resources);
        continue;
      }

      // Treat unknown/missing types as pages when they carry contents.
      const contentsRaw = resolved.map.get("Contents");
      const contents: string[] = [];

      if (contentsRaw?.t === "ref") {
        const key = refKey(contentsRaw);
        if (key) contents.push(key);
      } else if (contentsRaw?.t === "arr") {
        for (const item of contentsRaw.items) {
          const key = refKey(item);
          if (key) contents.push(key);
        }
      }

      if (contents.length > 0) {
        pages.push({ contents, resources });
      }
    }
  }

  const pagesRoot = resolve(catalog.get("Pages"));
  walkPages(pagesRoot?.t === "dict" ? pagesRoot.map : null, null);

  if (pages.length === 0) {
    throw new PdfExtractError("corrupt");
  }

  const warnings: string[] = [];
  const lines: PdfTextLine[] = [];
  let skippedStreams = 0;
  let skippedFontRuns = 0;
  const defaultFont: ResolvedFont = { usable: true, decode: winAnsiChar };

  let pageNumber = 0;

  for (const page of pages) {
    pageNumber += 1;

    const fonts = new Map<string, ResolvedFont>();
    const fontDictRaw = page.resources?.get("Font");
    const fontDict =
      fontDictRaw?.t === "ref" ? resolve(fontDictRaw) : fontDictRaw;

    if (fontDict?.t === "dict") {
      for (const [name, value] of fontDict.map) {
        fonts.set(name, resolveFont(value, resolve));
      }
    }

    const runs: TextRun[] = [];
    const state = freshTextState(defaultFont);
    const skipped = { count: 0 };

    for (const key of page.contents) {
      const raw = objects.get(key);
      if (!raw || raw.stream === null) continue;

      const dict = objectDict(key);
      const filterRaw = dict?.get("Filter");
      const filters: string[] = [];

      if (filterRaw?.t === "name") {
        filters.push(filterRaw.v);
      } else if (filterRaw?.t === "arr") {
        for (const item of filterRaw.items) {
          if (item.t === "name") filters.push(item.v);
        }
      }

      const params = dict?.get("DecodeParms");
      const predictor =
        params?.t === "dict" ? params.map.get("Predictor") : undefined;

      let content = raw.stream;

      if (filters.length > 0) {
        const onlyFlate =
          filters.length > 0 &&
          filters.every((name) => name === "FlateDecode");

        if (
          !onlyFlate ||
          (predictor?.t === "num" && predictor.v > 1) ||
          typeof DecompressionStream === "undefined"
        ) {
          skippedStreams += 1;
          continue;
        }

        try {
          const inflated = await inflateRaw(latin1ToBytes(content));
          content = bytesToLatin1(inflated);
        } catch {
          skippedStreams += 1;
          continue;
        }
      }

      runContentTokens(tokenizeContent(content), state, fonts, runs, skipped);
    }

    skippedFontRuns += skipped.count;

    runs.sort((a, b) => b.y - a.y || a.x - b.x);

    const tolerance = 3;
    let group: TextRun[] = [];
    let groupY = 0;

    function flushGroup(): void {
      if (group.length === 0) return;

      const text = group
        .map((run) => run.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (text !== "") {
        lines.push({ page: pageNumber, y: groupY, text });
      }

      group = [];
    }

    for (const run of runs) {
      if (group.length === 0 || Math.abs(run.y - groupY) <= tolerance) {
        if (group.length === 0) groupY = run.y;
        group.push(run);
      } else {
        flushGroup();
        groupY = run.y;
        group.push(run);
      }
    }

    flushGroup();
  }

  if (skippedStreams > 0) {
    warnings.push(
      `${skippedStreams} Inhalte konnten nicht gelesen werden (unbekannte Komprimierung).`,
    );
  }

  if (lines.length === 0) {
    if (skippedFontRuns > 0 || /\/ToUnicode\b/.test(src)) {
      throw new PdfExtractError("unsupported");
    }

    throw new PdfExtractError("scanned");
  }

  return { pageCount: pages.length, lines, warnings };
}
