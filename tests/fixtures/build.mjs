// Builds real binary fixtures for the study extraction tests.
// Run once with `node tests/fixtures/build.mjs`; the outputs are
// committed so tests never depend on this script at runtime.
import { deflateSync, deflateRawSync, crc32 } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
mkdirSync(DIR, { recursive: true });

// ------------------------------------------------------------------ PDF
// Two pages: page 1 raw stream, page 2 FlateDecode stream. WinAnsi
// text with umlauts (latin1 bytes). xref-less, trailer /Root.

function pdfEscape(text) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function pdfPageStream(lines) {
  let out = "BT /F1 12 Tf 72 720 Td ";
  lines.forEach((line, index) => {
    if (index > 0) out += "0 -20 Td ";
    out += `(${pdfEscape(line)}) Tj `;
  });
  out += "ET";
  return out;
}

function buildPdf() {
  const page1 = pdfPageStream([
    "Zellatmung: Die Glykolyse spaltet Glukose im Zytoplasma.",
    "Dabei entstehen zwei Moleküle Pyruvat und etwas ATP.",
  ]);
  const page2 = pdfPageStream([
    "Der Citratzyklus läuft in den Mitochondrien ab.",
    "Am Ende steht die oxidative Phosphorylierung mit viel ATP.",
  ]);
  const page1Bytes = Buffer.from(page1, "latin1");
  const page2Raw = Buffer.from(page2, "latin1");
  const page2Bytes = deflateSync(page2Raw);

  const parts = [];
  parts.push(Buffer.from("%PDF-1.4\n", "latin1"));
  parts.push(
    Buffer.from(
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "latin1",
    ),
  );
  parts.push(
    Buffer.from(
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n",
      "latin1",
    ),
  );
  for (const [num, contents] of [
    [3, 6],
    [4, 7],
  ]) {
    parts.push(
      Buffer.from(
        `${num} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contents} 0 R >>\nendobj\n`,
        "latin1",
      ),
    );
  }
  parts.push(
    Buffer.from(
      "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
      "latin1",
    ),
  );
  parts.push(
    Buffer.from(`6 0 obj\n<< /Length ${page1Bytes.length} >>\nstream\n`, "latin1"),
  );
  parts.push(page1Bytes);
  parts.push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  parts.push(
    Buffer.from(
      `7 0 obj\n<< /Length ${page2Bytes.length} /Filter /FlateDecode >>\nstream\n`,
      "latin1",
    ),
  );
  parts.push(page2Bytes);
  parts.push(Buffer.from("\nendstream\nendobj\n", "latin1"));
  parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\n", "latin1"));

  writeFileSync(join(DIR, "sample.pdf"), Buffer.concat(parts));
}

// ------------------------------------------------------------------ zip
// Minimal writer: stored + raw-deflate entries, central directory.

function zipArchive(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data, method } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const payload = method === 8 ? deflateRawSync(data) : Buffer.from(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centrals.push(central);

    offset += local.length + payload.length;
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

  return Buffer.concat([...locals, centralDir, eocd]);
}

function buildDocx() {
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Die Französische Revolution begann 1789 mit dem Sturm auf die Bastille.</w:t></w:r></w:p>
<w:p><w:r><w:t>Die Nationalversammlung verabschiedete die Erklärung der Menschen- und Bürgerrechte.</w:t></w:r></w:p>
<w:p><w:r></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Forschung &amp; Freiheit prägten die Debatten des Direktoriums.</w:t></w:r></w:p>
</w:body></w:document>`;
  const footnotesXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:footnote><w:p><w:r><w:t>Bastille: Festung und Gefängnis in Paris.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;

  writeFileSync(
    join(DIR, "sample.docx"),
    zipArchive([
      { name: "[Content_Types].xml", data: Buffer.from(types, "utf8"), method: 0 },
      { name: "word/document.xml", data: Buffer.from(documentXml, "utf8"), method: 8 },
      { name: "word/footnotes.xml", data: Buffer.from(footnotesXml, "utf8"), method: 8 },
    ]),
  );
}

function buildPptx() {
  const slide = (lines) => `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
<p:sp><p:txBody>${lines
    .map(
      (line) =>
        `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`,
    )
    .join("")}</p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;

  writeFileSync(
    join(DIR, "sample.pptx"),
    zipArchive([
      { name: "[Content_Types].xml", data: Buffer.from(types, "utf8"), method: 0 },
      {
        name: "ppt/slides/slide1.xml",
        data: Buffer.from(
          slide([
            "Newtons erstes Gesetz: Trägheitsprinzip.",
            "Ein Körper bleibt in Ruhe oder gleichförmiger Bewegung.",
          ]),
          "utf8",
        ),
        method: 8,
      },
      {
        name: "ppt/slides/slide2.xml",
        data: Buffer.from(
          slide(["Newtons zweites Gesetz: Kraft ist Masse mal Beschleunigung."]),
          "utf8",
        ),
        method: 8,
      },
      {
        name: "ppt/slides/slide3.xml",
        data: Buffer.from(
          `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`,
          "utf8",
        ),
        method: 8,
      },
    ]),
  );
}

function buildTxt() {
  const lines = [];
  for (let n = 1; n <= 65; n += 1) {
    lines.push(`Zeile ${n}: Das Periodensystem ordnet die Elemente nach Ordnungszahl.`);
  }
  writeFileSync(join(DIR, "sample.txt"), lines.join("\n"), "utf8");
}

buildPdf();
buildDocx();
buildPptx();
buildTxt();
console.log("fixtures written to", DIR);
