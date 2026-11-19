/**
 * The 150-page document the performance criterion (C6, 0239) is measured on.
 *
 * @remarks
 * The document is made here rather than kept in \`fixtures/\` because its bytes are generated from a
 * count, not written: 150 paragraphs, one page each once the engine lays them out. It is a real
 * DOCX (the same parts the journey's fixture has), so the engine reads it as one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipOf } from "../support/fixtures.ts";

const DIR = fileURLToPath(new URL("../fixtures/office/", import.meta.url));

/**
 * One page's paragraph, with an explicit page break before it after the first.
 *
 * @param n - The page's number.
 * @returns The paragraph XML.
 *
 * @remarks
 * The break is the document's own (`w:pageBreakBefore`), not a layout accident: the criterion is a
 * document of a stated number of pages, and a measurement whose document came out as six pages
 * would be a number about a different document.
 */
function paragraph(n: number): string {
  const pageBreak = n === 1 ? "" : '<w:pageBreakBefore/>';
  return (
    "<w:p><w:pPr>" +
    pageBreak +
    '<w:spacing w:after="240"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="IPAexGothic" ' +
    'w:eastAsia="IPAexGothic"/></w:rPr><w:t>第' +
    String(n) +
    "ページ。売上表の本文です。この文書は 150 ページの計測用です。</w:t></w:r></w:p>"
  );
}

/**
 * The document.
 *
 * @param pages - How many pages (one paragraph each).
 * @returns Its bytes.
 */
export function pagesDocument(pages: number): Uint8Array {
  const body = Array.from({ length: pages }, (_, index) => paragraph(index + 1)).join("");
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:body>" +
    body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" ' +
    'w:bottom="1134" w:left="1134"/></w:sectPr>' +
    "</w:body></w:document>";
  return zipOf(
    new Map([
      ["[Content_Types].xml", readFileSync(join(DIR, "pkg.Content_Types.xml"))],
      ["_rels/.rels", readFileSync(join(DIR, "pkg.rels"))],
      ["word/document.xml", new TextEncoder().encode(document)],
      ["word/_rels/document.xml.rels", readFileSync(join(DIR, "word._rels.document.xml.rels"))],
    ]),
  );
}
