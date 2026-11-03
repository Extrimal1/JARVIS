/**
 * Document preview/download regression tests (issue 2):
 * - the download API serves real bytes with correct Content-Type and
 *   an `inline` Content-Disposition (never `attachment`), reading
 *   private Storage with the user's JWT (no service-role);
 * - bytes are compared end to end, not just the status;
 * - DOCX previews keep headings/paragraphs/lists, PPTX previews keep
 *   slides, Markdown renders formatted without raw HTML;
 * - the client maps genuine 404s to null and throws honest errors.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 as crc32Of } from "node:zlib";
import {
  asciiFileName,
  buildDownloadHeaders,
  downloadStudyDocBytes,
  KIND_CONTENT_TYPES,
} from "@/src/lib/api/modules/documents";
import { dbFor } from "@/src/lib/supabase/db";
import { ExtractError } from "@/src/lib/study/extract";
import {
  classifyDocxParagraph,
  extractDocxPreview,
  extractPptxPreview,
  parseMarkdown,
  parseMarkdownInline,
} from "@/src/lib/study/preview";

function fixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
  );
}

// ------------------------------------------------------- stubbed backend

const DB = dbFor(
  { url: "https://supabase.test", anonKey: "anon" },
  "user-jwt-token",
  "user-1",
);

type FetchArgs = {
  url: string;
  method: string;
  headers: Record<string, string>;
};

type Route = {
  match: (args: FetchArgs) => boolean;
  respond: (args: FetchArgs) => Response;
};

let routes: Route[] = [];
let hits: FetchArgs[] = [];
const realFetch = globalThis.fetch;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function headersOf(init?: { headers?: unknown }): Record<string, string> {
  if (init?.headers === undefined || init.headers === null) return {};

  if (typeof Headers !== "undefined" && init.headers instanceof Headers) {
    return Object.fromEntries(init.headers.entries());
  }

  if (Array.isArray(init.headers)) {
    return Object.fromEntries(init.headers as [string, string][]);
  }

  return { ...(init.headers as Record<string, string>) };
}

beforeEach(() => {
  routes = [];
  hits = [];
  globalThis.fetch = (async (input: unknown, init?: {
    method?: string;
    headers?: unknown;
  }) => {
    const args: FetchArgs = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: headersOf(init),
    };
    hits.push(args);

    const route = routes.find((candidate) => candidate.match(args));

    if (route === undefined) {
      throw new Error(`unstubbed fetch: ${args.method} ${args.url}`);
    }

    return route.respond(args);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function onRest(
  method: string,
  table: string,
  respond: (args: FetchArgs) => Response,
): void {
  routes.push({
    match: (args) =>
      args.method === method &&
      args.url.startsWith(`https://supabase.test/rest/v1/${table}`),
    respond,
  });
}

function onStorageObject(respond: (args: FetchArgs) => Response): void {
  routes.push({
    match: (args) =>
      args.method === "GET" &&
      args.url.startsWith("https://supabase.test/storage/v1/object/"),
    respond,
  });
}

function docRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "doc-1",
    name: "Übungsblatt 1.pdf",
    mime: "application/pdf",
    size: 879,
    kind: "pdf",
    subject: null,
    description: "",
    uploaded_at: "2026-10-31T10:00:00.000Z",
    extraction_status: "completed",
    storage_path: "user-1/doc-1/Ubungsblatt_1.pdf",
    text_path: "",
    ...overrides,
  };
}

// ------------------------------------------------------------- server API

describe("downloadStudyDocBytes", () => {
  it("returns exact file bytes with the canonical content type", async () => {
    const pdf = fixture("sample.pdf");
    onRest("GET", "study_documents", () => json([docRow()]));
    onStorageObject(() => new Response(Buffer.from(pdf) as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }));

    const result = await downloadStudyDocBytes(DB, "doc-1", "file");

    assert.equal(result.status, "ok");

    if (result.status !== "ok") return;

    // Bytes, not just 200: the browser must receive the stored file.
    assert.deepEqual(
      Buffer.from(result.bytes),
      Buffer.from(pdf),
    );
    assert.equal(result.contentType, "application/pdf");
    assert.equal(result.contentType, KIND_CONTENT_TYPES.pdf);
    assert.equal(result.fileName, "Übungsblatt 1.pdf");
  });

  it("reads private storage with the user JWT and an owner filter", async () => {
    const pdf = fixture("sample.pdf");
    onRest("GET", "study_documents", () => json([docRow()]));
    onStorageObject(() => new Response(Buffer.from(pdf) as unknown as BodyInit));

    await downloadStudyDocBytes(DB, "doc-1", "file");

    const rest = hits.find((hit) => hit.url.includes("/rest/v1/"));
    const storage = hits.find((hit) => hit.url.includes("/storage/v1/"));

    assert.ok(rest?.url.includes("user_id=eq.user-1"));
    assert.equal(rest?.headers.Authorization, "Bearer user-jwt-token");
    assert.equal(storage?.headers.Authorization, "Bearer user-jwt-token");
    // No service-role key anywhere on the wire.
    for (const hit of hits) {
      assert.ok(!Object.values(hit.headers).some((value) => value.includes("service_role")));
    }
  });

  it("serves extracted text via the text variant", async () => {
    onRest("GET", "study_documents", () =>
      json([docRow({ text_path: "user-1/doc-1.txt" })]),
    );
    onStorageObject((args) => {
      assert.ok(args.url.includes("user-1/doc-1.txt"));

      return new Response("Hallo Welt", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const result = await downloadStudyDocBytes(DB, "doc-1", "text");

    assert.equal(result.status, "ok");

    if (result.status !== "ok") return;

    assert.equal(Buffer.from(result.bytes).toString("utf8"), "Hallo Welt");
    assert.equal(result.contentType, "text/plain;charset=utf-8");
  });

  it("reports no-text without touching storage when nothing was extracted", async () => {
    onRest("GET", "study_documents", () => json([docRow({ text_path: "" })]));

    const result = await downloadStudyDocBytes(DB, "doc-1", "text");

    assert.deepEqual(result, { status: "no-text" });
    assert.equal(
      hits.filter((hit) => hit.url.includes("/storage/v1/")).length,
      0,
    );
  });

  it("reports not-found for foreign or missing rows", async () => {
    onRest("GET", "study_documents", () => json([]));

    assert.deepEqual(await downloadStudyDocBytes(DB, "doc-x", "file"), {
      status: "not-found",
    });
    assert.deepEqual(await downloadStudyDocBytes(DB, "doc-x", "text"), {
      status: "not-found",
    });
  });

  it("maps a missing file object to OBJECT_NOT_FOUND, a missing text to no-text", async () => {
    onRest("GET", "study_documents", () =>
      json([docRow({ text_path: "user-1/doc-1.txt" })]),
    );
    onStorageObject(() => json({ message: "Object not found" }, 404));

    await assert.rejects(
      downloadStudyDocBytes(DB, "doc-1", "file"),
      /OBJECT_NOT_FOUND/,
    );
    assert.deepEqual(await downloadStudyDocBytes(DB, "doc-1", "text"), {
      status: "no-text",
    });
  });

  it("falls back to octet-stream for unknown kinds", async () => {
    onRest("GET", "study_documents", () =>
      json([docRow({ kind: "zip", name: "archiv.zip" })]),
    );
    onStorageObject(() => new Response("PK", { status: 200 }));

    const result = await downloadStudyDocBytes(DB, "doc-1", "file");

    assert.equal(result.status, "ok");

    if (result.status !== "ok") return;

    assert.equal(result.contentType, "application/octet-stream");
  });
});

describe("buildDownloadHeaders", () => {
  it("is always inline with length, umlaut-safe name, and nosniff", () => {
    const headers = buildDownloadHeaders({
      contentType: "application/pdf",
      fileName: "Übungsblatt 1.pdf",
      byteLength: 879,
    });

    assert.equal(headers["Content-Type"], "application/pdf");
    assert.equal(headers["Content-Length"], "879");
    assert.ok(headers["Content-Disposition"]?.startsWith("inline;"));
    assert.ok(!headers["Content-Disposition"]?.includes("attachment"));
    assert.ok(
      headers["Content-Disposition"]?.includes(
        "filename*=UTF-8''%C3%9Cbungsblatt%201.pdf",
      ),
    );
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["Cache-Control"], "private, no-store");
  });

  it("sanitizes the ASCII fallback and empty names", () => {
    assert.equal(asciiFileName('a"b\\c.pdf'), "a_b_c.pdf");
    assert.equal(asciiFileName(""), "dokument");

    const headers = buildDownloadHeaders({
      contentType: "application/pdf",
      fileName: "",
      byteLength: 10,
    });

    assert.ok(headers["Content-Disposition"]?.includes('filename="dokument"'));
  });
});

// ------------------------------------------------------------ DOCX preview

function storedZip(entries: { name: string; data: Buffer }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc32Of(data) >>> 0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc32Of(data) >>> 0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...locals, centralDir, eocd]));
}

describe("extractDocxPreview", () => {
  it("keeps plain paragraphs with stable numbering on the fixture", async () => {
    const preview = await extractDocxPreview(fixture("sample.docx"));

    assert.equal(preview.truncated, false);
    assert.equal(preview.blocks.length, 4);
    assert.deepEqual(
      preview.blocks.map((block) => ({
        heading: block.heading,
        list: block.list,
        paragraph: block.paragraph,
      })),
      [
        { heading: 0, list: null, paragraph: 1 },
        { heading: 0, list: null, paragraph: 2 },
        { heading: 0, list: null, paragraph: 4 },
        { heading: 0, list: null, paragraph: 4 },
      ],
    );
    assert.match(preview.blocks[0]?.text ?? "", /Bastille/);
  });

  it("detects headings and bullet/numbered lists end to end", async () => {
    const documentXml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Skript</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Kapitel</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:pStyle w:val="Ueberschrift2"/></w:pPr><w:r><w:t>Abschnitt</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Erster Punkt</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Unterpunkt</w:t></w:r></w:p>` +
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="8"/></w:numPr></w:pPr><w:r><w:t>Schritt eins</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>Fließtext.</w:t></w:r></w:p>` +
      `</w:body></w:document>`;
    const numberingXml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>` +
      `<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>` +
      `<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>` +
      `<w:num w:numId="7"><w:abstractNumId w:val="1"/></w:num>` +
      `<w:num w:numId="8"><w:abstractNumId w:val="2"/></w:num>` +
      `</w:numbering>`;
    const bytes = storedZip([
      { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
      { name: "word/numbering.xml", data: Buffer.from(numberingXml, "utf8") },
    ]);

    const preview = await extractDocxPreview(bytes);

    assert.deepEqual(
      preview.blocks.map((block) => ({
        text: block.text,
        heading: block.heading,
        list: block.list,
      })),
      [
        { text: "Skript", heading: 1, list: null },
        { text: "Kapitel", heading: 1, list: null },
        { text: "Abschnitt", heading: 2, list: null },
        {
          text: "Erster Punkt",
          heading: 0,
          list: { ordered: false, level: 0 },
        },
        { text: "Unterpunkt", heading: 0, list: { ordered: false, level: 1 } },
        { text: "Schritt eins", heading: 0, list: { ordered: true, level: 0 } },
        { text: "Fließtext.", heading: 0, list: null },
      ],
    );
  });

  it("classifies styles without numbering as bullets and numId 0 as plain", () => {
    assert.deepEqual(
      classifyDocxParagraph(
        `<w:p><w:pPr><w:pStyle w:val="Heading9"/></w:pPr><w:r><w:t>T</w:t></w:r></w:p>`,
        null,
      ),
      { heading: 3, list: null },
    );
    assert.deepEqual(
      classifyDocxParagraph(
        `<w:p><w:pPr><w:numPr><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>L</w:t></w:r></w:p>`,
        null,
      ),
      { heading: 0, list: { ordered: false, level: 0 } },
    );
    assert.deepEqual(
      classifyDocxParagraph(
        `<w:p><w:pPr><w:numPr><w:numId w:val="0"/></w:numPr></w:pPr><w:r><w:t>L</w:t></w:r></w:p>`,
        null,
      ),
      { heading: 0, list: null },
    );
  });

  it("truncates long documents and rejects textless ones", async () => {
    const preview = await extractDocxPreview(fixture("sample.docx"), 2);

    assert.equal(preview.blocks.length, 2);
    assert.equal(preview.truncated, true);

    const empty = storedZip([
      {
        name: "word/document.xml",
        data: Buffer.from(
          `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>   </w:t></w:r></w:p></w:body></w:document>`,
          "utf8",
        ),
      },
    ]);

    await assert.rejects(extractDocxPreview(empty), (error: unknown) => {
      assert.ok(error instanceof ExtractError);
      assert.equal(error.code, "empty");

      return true;
    });
  });
});

// ------------------------------------------------------------ PPTX preview

describe("extractPptxPreview", () => {
  it("keeps slides with titles, lines, and textless markers", async () => {
    const preview = await extractPptxPreview(fixture("sample.pptx"));

    assert.equal(preview.totalSlides, 3);
    assert.equal(preview.slides.length, 3);
    assert.deepEqual(
      preview.slides.map((slide) => ({
        slide: slide.slide,
        title: slide.title,
        empty: slide.empty,
      })),
      [
        {
          slide: 1,
          title: "Newtons erstes Gesetz: Trägheitsprinzip.",
          empty: false,
        },
        {
          slide: 2,
          title: "Newtons zweites Gesetz: Kraft ist Masse mal Beschleunigung.",
          empty: false,
        },
        { slide: 3, title: "", empty: true },
      ],
    );
    assert.deepEqual(preview.slides[0]?.lines, [
      "Ein Körper bleibt in Ruhe oder gleichförmiger Bewegung.",
    ]);
    assert.deepEqual(preview.warnings, [
      "1 von 3 Folien enthalten keinen lesbaren Text.",
    ]);
  });
});

// -------------------------------------------------------- Markdown preview

describe("parseMarkdown", () => {
  it("parses headings, rich text, lists, code, quotes, and rules", () => {
    const preview = parseMarkdown(
      [
        "# Titel",
        "",
        "Ein **fetter** und *kursiver* Text mit `Code` und [Link](https://example.org/a).",
        "",
        "- Punkt eins",
        "  - Unterpunkt",
        "",
        "1. Schritt eins",
        "",
        "> Ein Zitat",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "---",
        "",
        "## Ende",
      ].join("\n"),
    );

    assert.equal(preview.truncated, false);
    assert.deepEqual(
      preview.blocks.map((block) => block.type),
      ["heading", "paragraph", "list", "list", "quote", "code", "rule", "heading"],
    );

    const [title, paragraph, bullets, steps, quote, code] = preview.blocks;
    assert.equal(title?.type === "heading" ? title.level : 0, 1);
    assert.ok(
      (paragraph?.type === "paragraph" ? paragraph.inline : []).some(
        (segment) => segment.bold && segment.text === "fetter",
      ),
    );
    assert.ok(
      (paragraph?.type === "paragraph" ? paragraph.inline : []).some(
        (segment) => segment.href === "https://example.org/a",
      ),
    );
    assert.equal(
      bullets?.type === "list"
        ? bullets.items[1]?.level
        : -1,
      1,
    );
    assert.equal(steps?.type === "list" ? steps.ordered : null, true);
    assert.equal(quote?.type === "quote", true);
    assert.equal(code?.type === "code" ? code.language : "", "ts");
  });

  it("never emits raw HTML or unsafe links", () => {
    const inline = parseMarkdownInline(
      `<script>alert(1)</script> und [böse](javascript:alert(1))`,
    );

    assert.ok(inline.every((segment) => segment.href === null));
    assert.ok(
      inline.some((segment) => segment.text.includes("<script>")),
    );
  });

  it("truncates long input", () => {
    const preview = parseMarkdown("# A\n\n# B\n\n# C\n", 2);

    assert.equal(preview.blocks.length, 2);
    assert.equal(preview.truncated, true);
  });
});

// --------------------------------------------------------------- client IO

describe("cloud document IO", () => {
  it("returns server bytes verbatim and maps 404 to null", async () => {
    process.env.NEXT_PUBLIC_CLOUD_ENABLED = "1";

    const pdf = fixture("sample.pdf");
    const client = await import("@/src/lib/db/documents");
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);

      if (url === "/api/documents/doc-1/download") {
        return new Response(Buffer.from(pdf) as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }

      if (url === "/api/documents/doc-1/download?variant=text") {
        return new Response("Extrakt", {
          status: 200,
          headers: { "content-type": "text/plain;charset=utf-8" },
        });
      }

      if (url === "/api/documents/gone/download?variant=text") {
        return json(
          { ok: false, error: { code: "not-found", message: "Kein Text." } },
          404,
        );
      }

      return json(
        { ok: false, error: { code: "not-found", message: "Fehlt." } },
        404,
      );
    }) as typeof fetch;

    const blob = await client.getDocumentBlob("doc-1");

    assert.ok(blob instanceof Blob);
    assert.deepEqual(
      Buffer.from(await blob.arrayBuffer()),
      Buffer.from(pdf),
    );
    assert.equal(blob.type, "application/pdf");
    assert.equal(await client.getDocumentText("doc-1"), "Extrakt");
    assert.equal(await client.getDocumentBlob("gone"), null);
    assert.equal(await client.getDocumentText("gone"), null);
    assert.ok(calls.includes("/api/documents/doc-1/download?variant=text"));

    delete process.env.NEXT_PUBLIC_CLOUD_ENABLED;
  });

  it("throws the server message on real failures", async () => {
    process.env.NEXT_PUBLIC_CLOUD_ENABLED = "1";

    const client = await import("@/src/lib/db/documents");
    globalThis.fetch = (async () =>
      json(
        {
          ok: false,
          error: { code: "upstream-error", message: "Backend kaputt." },
        },
        502,
      )) as typeof fetch;

    await assert.rejects(client.getDocumentBlob("doc-1"), /Backend kaputt/);
    await assert.rejects(client.getDocumentText("doc-1"), /Backend kaputt/);

    delete process.env.NEXT_PUBLIC_CLOUD_ENABLED;
  });
});
