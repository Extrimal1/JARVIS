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

// ------------------------------------------------------------------ deck
// Multi-slide PPTX for the topic-extraction regression tests: six
// slide files in shuffled presentation order [3,1,5,2,4,6] (file5
// is empty, so position 3 is the gap), slide2 notes via rels,
// slide4 notes via same-number fallback, slide4 with a table,
// slide6 with XML entities.

function buildDeck() {
  const slide = (lines) => `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
<p:sp><p:txBody>${lines
    .map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
  const notes = (lines) => `<?xml version="1.0" encoding="UTF-8"?>
<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
<p:sp><p:txBody>${lines
    .map((line) => `<a:p><a:r><a:t>${line}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`;
  const tableSlide = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>Genetik nach Mendel</a:t></a:r></a:p><a:p><a:r><a:t>Dominante und rezessive Merkmale bestimmen die Nachkommen.</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:txBody><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Merkmal</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Ausprägung</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Erbse</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>rund oder runzlig</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
  const emptySlide = `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree></p:spTree></p:cSld></p:sld>`;
  const types = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>`;
  const presentation = `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>
<p:sldId r:id="rId3"/><p:sldId r:id="rId1"/><p:sldId r:id="rId5"/><p:sldId r:id="rId2"/><p:sldId r:id="rId4"/><p:sldId r:id="rId6"/>
</p:sldIdLst></p:presentation>`;
  const presentationRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide4.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide5.xml"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide6.xml"/>
</Relationships>`;
  const slide2Rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/>
</Relationships>`;

  writeFileSync(
    join(DIR, "sample-deck.pptx"),
    zipArchive([
      { name: "[Content_Types].xml", data: Buffer.from(types, "utf8"), method: 0 },
      { name: "ppt/presentation.xml", data: Buffer.from(presentation, "utf8"), method: 8 },
      { name: "ppt/_rels/presentation.xml.rels", data: Buffer.from(presentationRels, "utf8"), method: 8 },
      {
        name: "ppt/slides/slide1.xml",
        data: Buffer.from(
          slide([
            "Photosynthese: Grundlagen der Energieumwandlung.",
            "Chlorophyll fängt Lichtenergie in den Blättern ein.",
            "Wasser und Kohlenstoffdioxid sind die Ausgangsstoffe der Reaktion.",
          ]),
          "utf8",
        ),
        method: 8,
      },
      {
        name: "ppt/slides/slide2.xml",
        data: Buffer.from(
          slide([
            "Zellatmung im Überblick.",
            "Glykolyse spaltet Glukose im Zytoplasma in Pyruvat.",
            "Citratzyklus läuft in den Mitochondrien und liefert Energie.",
          ]),
          "utf8",
        ),
        method: 8,
      },
      {
        name: "ppt/slides/slide3.xml",
        data: Buffer.from(
          slide([
            "Biologie Klausur: Themenübersicht.",
            "Alle prüfungsrelevanten Kapitel von Photosynthese bis Ökologie im Überblick.",
          ]),
          "utf8",
        ),
        method: 8,
      },
      {
        name: "ppt/slides/slide4.xml",
        data: Buffer.from(tableSlide, "utf8"),
        method: 8,
      },
      {
        name: "ppt/slides/slide5.xml",
        data: Buffer.from(emptySlide, "utf8"),
        method: 8,
      },
      {
        name: "ppt/slides/slide6.xml",
        data: Buffer.from(
          slide([
            "Ökologie &amp; Umwelt: Zusammenhänge verstehen.",
            "Nahrungsketten &amp; Nahrungsnetze erklären den Energiefluss.",
            "Stoffkreisläufe im Ökosystem Wald schließen den Kreislauf.",
          ]),
          "utf8",
        ),
        method: 8,
      },
      {
        name: "ppt/slides/_rels/slide2.xml.rels",
        data: Buffer.from(slide2Rels, "utf8"),
        method: 8,
      },
      {
        name: "ppt/notesSlides/notesSlide2.xml",
        data: Buffer.from(
          notes(["Sprechnotiz zu Zellatmung: ATP-Ausbeute von Glykolyse und Citratzyklus ausführlich erklären."]),
          "utf8",
        ),
        method: 8,
      },
      {
        name: "ppt/notesSlides/notesSlide4.xml",
        data: Buffer.from(
          notes(["Notiz zu Mendel: Erbsenexperimente mit Kreuzungsschema erwähnen."]),
          "utf8",
        ),
        method: 8,
      },
    ]),
  );
}

buildPdf();
buildDocx();
buildPptx();
buildDeck();
buildTxt();
console.log("fixtures written to", DIR);
