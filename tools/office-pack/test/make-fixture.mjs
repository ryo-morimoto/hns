// make-fixture.mjs — writes tools/office-pack/test/fixtures/ja.docx, the one document the pack's
// smoke test renders. Hand-built (a docx is a zip of OOXML parts) so the repository carries a
// 1 KB file instead of a 140-page sample, and so the test does not depend on a network fetch.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? join(here, "fixtures", "ja.docx");

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buffer) => {
  let c = -1;
  for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
const paragraph = (text, size) =>
  '<w:p><w:pPr><w:rPr><w:rFonts w:ascii="IPAexGothic" w:eastAsia="IPAexGothic" w:hAnsi="IPAexGothic"/><w:sz w:val="' + size + '"/></w:rPr></w:pPr>' +
  '<w:r><w:rPr><w:rFonts w:ascii="IPAexGothic" w:eastAsia="IPAexGothic" w:hAnsi="IPAexGothic"/><w:sz w:val="' + size + '"/></w:rPr>' +
  '<w:t xml:space="preserve">' + text + "</w:t></w:r></w:p>";
const document =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="' + W + '" xmlns:r="' + R + '"><w:body>' +
  paragraph("hns Office pack", 32) +
  paragraph("日本語の本文です。フォントが pack から供給されます。", 20) +
  paragraph("ASCII text renders in DejaVu Sans; 漢字、ひらがな、カタカナ。", 20) +
  paragraph("Page 1", 16) +
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>' +
  "</w:body></w:document>";
const types =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const parts = [
  ["[Content_Types].xml", types],
  ["_rels/.rels", packageRels],
  ["word/document.xml", document],
  ["word/_rels/document.xml.rels", docRels],
];

// A stored (uncompressed) zip: every reader accepts it, and the fixture stays reviewable by eye.
const chunks = [];
const central = [];
let offset = 0;
for (const [name, text] of parts) {
  const nameBytes = Buffer.from(name, "utf8");
  const data = Buffer.from(text, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  chunks.push(header, nameBytes, data);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt32LE(crc32(data), 16);
  entry.writeUInt32LE(data.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(nameBytes.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBytes);
  offset += 30 + nameBytes.length + data.length;
}
const centralStart = offset;
const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(parts.length, 8);
end.writeUInt16LE(parts.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(centralStart, 16);

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, Buffer.concat([...chunks, ...central, end]));
process.stdout.write("wrote " + relative(process.cwd(), target) + "\n");
