/**
 * In-app document previews: structured DOCX/PPTX views and Markdown
 * formatting. Runtime-agnostic (browser + API routes) and
 * dependency-free, like the extraction module it builds on.
 *
 * Safety: every parser returns plain text segments — the renderer
 * creates real elements from them, so document markup (including
 * `<script>`) can only ever render as literal text, never as HTML.
 */

import {
  drawingRunText,
  ExtractError,
  MAX_EXTRACT_BYTES,
  readDocxOfficeXml,
  readPptxSlideXml,
  splitDocxParagraphs,
  splitPptxLines,
  wordRunText,
} from "./extract";

/** Preview text cap (chars); longer content shows a "gekürzt" note. */
export const PREVIEW_TEXT_LIMIT = 50_000;

/** Preview block cap; longer documents show a "gekürzt" note. */
export const PREVIEW_BLOCK_LIMIT = 500;

// ------------------------------------------------------------------ DOCX

export type DocxPreviewList = {
  ordered: boolean;
  /** Nesting depth from `<w:ilvl>` (0 = top level). */
  level: number;
};

export type DocxPreviewBlock = {
  text: string;
  /** 0 = body paragraph, 1..3 = heading level. */
  heading: 0 | 1 | 2 | 3;
  list: DocxPreviewList | null;
  /** Stable 1-based paragraph number (matches extraction refs). */
  paragraph: number;
};

export type DocxPreview = {
  blocks: DocxPreviewBlock[];
  warnings: string[];
  truncated: boolean;
};

function headingLevelOf(paragraphXml: string): 0 | 1 | 2 | 3 {
  const match = /<w:pStyle[^>]*w:val="([^"]*)"/.exec(paragraphXml);

  if (match === null) return 0;

  const style = match[1] ?? "";

  if (/^title$/i.test(style)) return 1;

  // English "Heading1" and German Word "Überschrift 1"
  // (styleId "Ueberschrift1"); deeper levels clamp to h3.
  const level = /(?:heading|berschrift)\s*0*(\d+)/i.exec(style);

  if (level === null) return 0;

  return Math.min(3, Math.max(1, Number.parseInt(level[1] ?? "1", 10))) as
    | 1
    | 2
    | 3;
}

function numberingFormat(
  numberingXml: string | null,
  numId: number,
  level: number,
): string | null {
  if (numberingXml === null) return null;

  const numPattern = new RegExp(
    `<w:num\\b[^>]*w:numId="${numId}"[^>]*>` +
      `([\\s\\S]*?)</w:num>`,
  );
  const numBlock = numPattern.exec(numberingXml)?.[1] ?? "";

  if (numBlock === "") return null;

  const abstractId = /<w:abstractNumId[^>]*w:val="(\d+)"/.exec(numBlock)?.[1];

  if (abstractId === undefined) return null;

  const abstractPattern = new RegExp(
    `<w:abstractNum\\b[^>]*w:abstractNumId="${abstractId}"[^>]*>` +
      `([\\s\\S]*?)</w:abstractNum>`,
  );
  const abstractBlock = abstractPattern.exec(numberingXml)?.[1] ?? "";

  if (abstractBlock === "") return null;

  const lvlPattern = (ilvl: number): string | null => {
    const pattern = new RegExp(
      `<w:lvl\\b[^>]*w:ilvl="${ilvl}"[^>]*>([\\s\\S]*?)</w:lvl>`,
    );
    const lvlBlock = pattern.exec(abstractBlock)?.[1] ?? "";

    if (lvlBlock === "") return null;

    return /<w:numFmt[^>]*w:val="([^"]*)"/.exec(lvlBlock)?.[1] ?? null;
  };

  return lvlPattern(level) ?? lvlPattern(0);
}

function listOf(
  paragraphXml: string,
  numberingXml: string | null,
): DocxPreviewList | null {
  if (!/<w:numPr[\s>]/.test(paragraphXml)) return null;

  const numId = Number.parseInt(
    /<w:numId[^>]*w:val="(\d+)"/.exec(paragraphXml)?.[1] ?? "0",
    10,
  );

  if (!Number.isInteger(numId) || numId === 0) return null;

  const level = Math.min(
    8,
    Math.max(
      0,
      Number.parseInt(
        /<w:ilvl[^>]*w:val="(\d+)"/.exec(paragraphXml)?.[1] ?? "0",
        10,
      ),
    ),
  );
  const format = numberingFormat(numberingXml, numId, level);

  // Without numbering details we cannot know the marker; bullets are
  // the common case and never imply a false order.
  return { ordered: format !== null && format !== "bullet", level };
}

/**
 * Classifies one raw `<w:p>` chunk (test seam; pure, no zip needed).
 */
export function classifyDocxParagraph(
  paragraphXml: string,
  numberingXml: string | null,
): { heading: 0 | 1 | 2 | 3; list: DocxPreviewList | null } {
  return {
    heading: headingLevelOf(paragraphXml),
    list: listOf(paragraphXml, numberingXml),
  };
}

export async function extractDocxPreview(
  bytes: Uint8Array,
  maxBlocks: number = PREVIEW_BLOCK_LIMIT,
): Promise<DocxPreview> {
  if (bytes.length > MAX_EXTRACT_BYTES) {
    throw new ExtractError(
      "too-large",
      "Die Datei ist zu groß für die Vorschau (max. 10 MB).",
    );
  }

  if (bytes.length === 0) {
    throw new ExtractError("empty", "Die Datei ist leer.");
  }

  const { documentXml, numberingXml, footnotesXml, endnotesXml } =
    await readDocxOfficeXml(bytes);
  const chunks = splitDocxParagraphs(documentXml);
  const blocks: DocxPreviewBlock[] = [];
  const warnings: string[] = [];
  let truncated = false;

  for (let index = 0; index < chunks.length; index += 1) {
    const text = wordRunText(chunks[index] ?? "");

    if (text === "") continue;

    if (blocks.length >= maxBlocks) {
      truncated = true;
      break;
    }

    const { heading, list } = classifyDocxParagraph(
      chunks[index] ?? "",
      numberingXml,
    );
    blocks.push({ text, heading, list, paragraph: index + 1 });
  }

  for (const [xml, label] of [
    [footnotesXml, "Fußnoten"],
    [endnotesXml, "Endnoten"],
  ] as const) {
    if (xml === null || truncated) continue;

    const notes = splitDocxParagraphs(xml)
      .map((chunk) => wordRunText(chunk))
      .filter((line) => line !== "")
      .join(" ");

    if (notes === "") continue;

    if (blocks.length >= maxBlocks) {
      truncated = true;
      break;
    }

    blocks.push({
      text: `${label}: ${notes}`,
      heading: 0,
      list: null,
      paragraph: blocks.length + 1,
    });
    warnings.push(`${label} wurden an den Text angehängt.`);
  }

  if (blocks.length === 0) {
    throw new ExtractError(
      "empty",
      "In der Datei wurde kein lesbarer Text gefunden.",
    );
  }

  return { blocks, warnings, truncated };
}

// ------------------------------------------------------------------ PPTX

export type PptxPreviewSlide = {
  slide: number;
  /** First line (usually the slide title); "" when textless. */
  title: string;
  /** Remaining lines. */
  lines: string[];
  empty: boolean;
};

export type PptxPreview = {
  slides: PptxPreviewSlide[];
  totalSlides: number;
  warnings: string[];
};

export async function extractPptxPreview(
  bytes: Uint8Array,
): Promise<PptxPreview> {
  if (bytes.length > MAX_EXTRACT_BYTES) {
    throw new ExtractError(
      "too-large",
      "Die Datei ist zu groß für die Vorschau (max. 10 MB).",
    );
  }

  if (bytes.length === 0) {
    throw new ExtractError("empty", "Die Datei ist leer.");
  }

  const parts = await readPptxSlideXml(bytes);
  const slides: PptxPreviewSlide[] = [];

  for (const { slide, xml } of parts) {
    const lines = splitPptxLines(xml)
      .map((line) => drawingRunText(line))
      .filter((line) => line !== "");

    slides.push({
      slide,
      title: lines[0] ?? "",
      lines: lines.slice(1),
      empty: lines.length === 0,
    });
  }

  const warnings: string[] = [];
  const textless = slides.filter((entry) => entry.empty).length;

  if (textless === slides.length) {
    throw new ExtractError(
      "empty",
      "In der Datei wurde kein lesbarer Text gefunden.",
    );
  }

  if (textless > 0) {
    warnings.push(
      `${textless} von ${slides.length} Folien enthalten keinen lesbaren Text.`,
    );
  }

  return { slides, totalSlides: slides.length, warnings };
}

// --------------------------------------------------------------- Markdown

export type MdInlineSegment = {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  /** Absolute http(s) URL, or null for plain text. */
  href: string | null;
};

export type MdBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; inline: MdInlineSegment[] }
  | { type: "paragraph"; inline: MdInlineSegment[] }
  | {
      type: "list";
      ordered: boolean;
      items: { level: number; inline: MdInlineSegment[] }[];
    }
  | { type: "code"; language: string; code: string }
  | { type: "quote"; inline: MdInlineSegment[] }
  | { type: "rule" };

export type MdPreview = {
  blocks: MdBlock[];
  truncated: boolean;
};

const ESCAPES: Record<string, string> = {
  "\\*": "\u0000STAR\u0000",
  "\\`": "\u0000TICK\u0000",
  "\\[": "\u0000OPEN\u0000",
  "\\]": "\u0000CLOSE\u0000",
  "\\\\": "\u0000BACK\u0000",
  "\\#": "\u0000HASH\u0000",
};

function protectEscapes(text: string): string {
  let out = text;

  for (const [from, to] of Object.entries(ESCAPES)) {
    out = out.split(from).join(to);
  }

  return out;
}

function restoreEscapes(text: string): string {
  let out = text;

  for (const [from, to] of Object.entries(ESCAPES)) {
    out = out.split(to).join(from.slice(1));
  }

  return out;
}

function segment(
  text: string,
  flags: Partial<Omit<MdInlineSegment, "text">> = {},
): MdInlineSegment {
  return {
    text: restoreEscapes(text),
    bold: flags.bold ?? false,
    italic: flags.italic ?? false,
    code: flags.code ?? false,
    href: flags.href ?? null,
  };
}

function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(href);
}

/** Splits rich inline markup into flat styled segments. */
export function parseMarkdownInline(text: string): MdInlineSegment[] {
  const source = protectEscapes(text);
  const out: MdInlineSegment[] = [];
  const codePattern = /`([^`\n]+)`/g;
  let rest: { text: string; code: boolean }[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(source)) !== null) {
    if (match.index > last) {
      rest.push({ text: source.slice(last, match.index), code: false });
    }

    rest.push({ text: match[1] ?? "", code: true });
    last = match.index + match[0].length;
  }

  if (last < source.length) {
    rest.push({ text: source.slice(last), code: false });
  }

  if (rest.length === 0) rest = [{ text: "", code: false }];

  const linkPattern = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;

  for (const chunk of rest) {
    if (chunk.code) {
      if (chunk.text !== "") out.push(segment(chunk.text, { code: true }));

      continue;
    }

    // Links first (their text stays literal afterwards).
    const linkParts: { text: string; href: string | null }[] = [];
    let remaining = chunk.text;
    let linkMatch: RegExpExecArray | null;

    while (
      (linkMatch = linkPattern.exec(remaining)) !== null &&
      linkMatch.index !== undefined
    ) {
      if (linkMatch.index > 0) {
        linkParts.push({
          text: remaining.slice(0, linkMatch.index),
          href: null,
        });
      }

      const href = linkMatch[2] ?? "";
      linkParts.push({
        text: linkMatch[1] ?? "",
        href: isSafeHref(href) ? href : null,
      });
      remaining = remaining.slice(
        linkMatch.index + linkMatch[0].length,
      );
    }

    linkParts.push({ text: remaining, href: null });

    for (const part of linkParts) {
      if (part.href !== null) {
        out.push(segment(part.text, { href: part.href }));

        continue;
      }

      // Bold, then italic inside each remainder.
      const boldParts = part.text.split(/\*\*([^*]+)\*\*/g);

      for (let index = 0; index < boldParts.length; index += 1) {
        const piece = boldParts[index] ?? "";
        const bold = index % 2 === 1;

        if (piece === "") continue;

        const italicParts = bold
          ? [piece]
          : piece.split(/(?:\*([^*\n]+)\*|_([^_\n]+)_)/g);

        for (let inner = 0; inner < italicParts.length; inner += 1) {
          const word = italicParts[inner] ?? "";

          if (word === "") continue;

          // Split groups: [plain, *..*, _.._] repeating.
          const italic = !bold && inner % 3 !== 0;
          out.push(segment(word, { bold, italic }));
        }
      }
    }
  }

  return out.filter((entry) => entry.text !== "");
}

function listItemOf(line: string): {
  ordered: boolean;
  level: number;
  text: string;
} | null {
  const match = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);

  if (match === null) return null;

  return {
    ordered: match[3] !== undefined,
    level: Math.min(3, Math.floor((match[1] ?? "").length / 2)),
    text: match[4] ?? "",
  };
}

export function parseMarkdown(
  source: string,
  maxBlocks: number = PREVIEW_BLOCK_LIMIT,
): MdPreview {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let truncated = false;

  const push = (block: MdBlock): boolean => {
    if (blocks.length >= maxBlocks) {
      truncated = true;

      return false;
    }

    blocks.push(block);

    return true;
  };

  let index = 0;

  const flushParagraph = (buffer: string[]): void => {
    if (truncated) return;

    const text = buffer.join("\n").trim();

    if (text !== "") {
      push({ type: "paragraph", inline: parseMarkdownInline(text) });
    }
  };

  let paragraph: string[] = [];

  while (index < lines.length && !truncated) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    // Fenced code.
    const fence = /^```(\w*)\s*$/.exec(trimmed);

    if (fence !== null) {
      flushParagraph(paragraph);
      paragraph = [];
      const language = fence[1] ?? "";
      const code: string[] = [];
      index += 1;

      while (index < lines.length && (lines[index] ?? "").trim() !== "```") {
        code.push(lines[index] ?? "");
        index += 1;
      }

      index += 1;
      push({ type: "code", language, code: code.join("\n") });

      continue;
    }

    // Headings.
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);

    if (heading !== null) {
      flushParagraph(paragraph);
      paragraph = [];
      const text = (heading[2] ?? "").replace(/\s+#+\s*$/, "").trim();

      if (text !== "") {
        push({
          type: "heading",
          level: Math.min(6, heading[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6,
          inline: parseMarkdownInline(text),
        });
      }

      index += 1;

      continue;
    }

    // Horizontal rule.
    if (/^(?:\*\*\*+|---+|___+)\s*$/.test(trimmed)) {
      flushParagraph(paragraph);
      paragraph = [];
      push({ type: "rule" });
      index += 1;

      continue;
    }

    // Quote (consecutive `>` lines merge).
    if (trimmed.startsWith(">")) {
      flushParagraph(paragraph);
      paragraph = [];
      const quoted: string[] = [];

      while (
        index < lines.length &&
        (lines[index] ?? "").trim().startsWith(">")
      ) {
        quoted.push((lines[index] ?? "").trim().replace(/^>\s?/, ""));
        index += 1;
      }

      const text = quoted.join("\n").trim();

      if (text !== "") {
        push({ type: "quote", inline: parseMarkdownInline(text) });
      }

      continue;
    }

    // Lists (consecutive same-ordered items merge; nesting by indent).
    const item = listItemOf(line);

    if (item !== null) {
      flushParagraph(paragraph);
      paragraph = [];
      const ordered = item.ordered;
      const items: { level: number; inline: MdInlineSegment[] }[] = [];

      while (index < lines.length) {
        const next = listItemOf(lines[index] ?? "");

        if (next === null || next.ordered !== ordered) break;

        if (next.text.trim() !== "") {
          items.push({
            level: next.level,
            inline: parseMarkdownInline(next.text.trim()),
          });
        }

        index += 1;
      }

      if (items.length > 0) {
        push({ type: "list", ordered, items });
      }

      continue;
    }

    if (trimmed === "") {
      flushParagraph(paragraph);
      paragraph = [];
      index += 1;

      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph(paragraph);

  return { blocks, truncated };
}
