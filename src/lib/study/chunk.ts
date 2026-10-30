/**
 * Chunking for study retrieval: extraction blocks become small,
 * overlapping, self-contained chunks that fit the 4B model's context.
 * Every chunk keeps the source refs of the blocks it was built from,
 * so citations always resolve to real extracted locations.
 */

import type { SourceRef } from "./extract";

export type DocumentChunk = {
  /** 0-based position inside the document. */
  index: number;
  text: string;
  refs: SourceRef[];
  charCount: number;
};

export type ChunkOptions = {
  /** Soft target size; default 1200. */
  targetChars?: number;
  /** Overlap between neighbors; default 150. */
  overlapChars?: number;
  /** Hard ceiling for a single block split; default 2000. */
  maxChars?: number;
};

const DEFAULT_TARGET = 1200;
const DEFAULT_OVERLAP = 150;
const DEFAULT_MAX = 2000;

function clampInt(value: number, fallback: number, min: number): number {
  return Number.isInteger(value) && value >= min ? value : fallback;
}

/** Splits overlong text on sentence, then word boundaries. */
function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const parts: string[] = [];
  let current = "";

  const push = (piece: string) => {
    if (piece === "") return;

    if ((`${current} ${piece}`.trim().length <= maxChars) || current === "") {
      current = `${current} ${piece}`.trim();
    } else {
      parts.push(current);
      current = piece;
    }
  };

  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      push(sentence);
      continue;
    }

    for (const word of sentence.split(/\s+/).filter((w) => w !== "")) {
      if (word.length > maxChars) {
        // One pathological token: hard-slice it, nothing else is honest.
        if (current !== "") {
          parts.push(current);
          current = "";
        }

        for (let at = 0; at < word.length; at += maxChars) {
          parts.push(word.slice(at, at + maxChars));
        }
      } else {
        push(word);
      }
    }
  }

  if (current !== "") parts.push(current);

  return parts;
}

/** Trailing overlap cut at a whitespace boundary when possible. */
function overlapOf(text: string, overlapChars: number): string {
  if (text.length <= overlapChars) return text;

  const slice = text.slice(text.length - overlapChars);
  const boundary = slice.search(/\s/);

  return boundary < 0 ? slice : slice.slice(boundary + 1);
}

export function chunkBlocks(
  blocks: { text: string; ref: SourceRef }[],
  options: ChunkOptions = {},
): DocumentChunk[] {
  const target = clampInt(options.targetChars ?? DEFAULT_TARGET, DEFAULT_TARGET, 200);
  const overlap = clampInt(options.overlapChars ?? DEFAULT_OVERLAP, DEFAULT_OVERLAP, 0);
  const max = Math.max(
    clampInt(options.maxChars ?? DEFAULT_MAX, DEFAULT_MAX, target),
    target,
  );

  // Normalize: drop empties, split overlong blocks (each piece keeps
  // the block ref — a page ref still points at the right page).
  const pieces: { text: string; ref: SourceRef }[] = [];

  for (const block of blocks) {
    const text = block.text.trim();

    if (text === "") continue;

    for (const part of splitLongText(text, max)) {
      pieces.push({ text: part, ref: block.ref });
    }
  }

  const chunks: DocumentChunk[] = [];
  let current: { text: string; ref: SourceRef }[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;

    const refs: SourceRef[] = [];
    const seen = new Set<string>();

    for (const piece of current) {
      const key = JSON.stringify(piece.ref);

      if (!seen.has(key)) {
        seen.add(key);
        refs.push(piece.ref);
      }
    }

    const text = current.map((piece) => piece.text).join("\n\n");

    chunks.push({
      index: chunks.length,
      text,
      refs,
      charCount: text.length,
    });

    // Seed the next chunk with the overlap tail (refs included).
    if (overlap > 0) {
      const tail = overlapOf(text, overlap);

      if (tail !== "" && tail !== text) {
        current = [{ text: tail, ref: refs[refs.length - 1]! }];
        currentChars = tail.length;

        return;
      }
    }

    current = [];
    currentChars = 0;
  };

  for (const piece of pieces) {
    if (
      current.length > 0 &&
      currentChars + 2 + piece.text.length > target &&
      currentChars >= Math.floor(target / 2)
    ) {
      flush();
    }

    current.push(piece);
    currentChars += (current.length === 1 ? 0 : 2) + piece.text.length;
  }

  flush();

  return chunks;
}

/** Rough token estimate (chars ÷ 4) for the `token_count` column. */
export function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;

  return Math.max(1, Math.round(chars / 4));
}
