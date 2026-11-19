import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The three formats the office journey opens. */
export type FixtureFormat = "docx" | "xlsx" | "pptx";

/** One document: the parts it holds, the text page 1 must carry, and its page count. */
export interface OfficeFixture {
  readonly format: FixtureFormat;
  readonly path: string;
  /** The text page 1 of the preview must carry once the engine drew it. */
  readonly text: string;
  /** The document's page count, as the pack's engine exports it. */
  readonly pages: number;
  /** The document's bytes. */
  readonly bytes: () => Uint8Array;
}

/**
 * A ZIP archive of `entries`, written with the store method.
 *
 * @param entries - Member name to bytes, in the order they are written.
 * @returns The archive.
 *
 * @remarks
 * An OOXML document is a ZIP; the fixtures' parts are kept in `e2e/fixtures/office` as XML a
 * reviewer can read, and this is what makes them documents. No compression (the store method),
 * no data descriptors: the layout every Office reader accepts.
 */
export function zipOf(entries: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, 0x21, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.byteLength, true);
    view.setUint32(22, data.byteLength, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, data);
    const central = new Uint8Array(46 + nameBytes.length);
    const cview = new DataView(central.buffer);
    cview.setUint32(0, 0x02014b50, true);
    cview.setUint16(4, 20, true);
    cview.setUint16(6, 20, true);
    cview.setUint16(8, 0x0800, true);
    cview.setUint16(10, 0, true);
    cview.setUint16(12, 0, true);
    cview.setUint16(14, 0x21, true);
    cview.setUint32(16, crc, true);
    cview.setUint32(20, data.byteLength, true);
    cview.setUint32(24, data.byteLength, true);
    cview.setUint16(28, nameBytes.length, true);
    cview.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.byteLength + data.byteLength;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const eview = new DataView(end.buffer);
  eview.setUint32(0, 0x06054b50, true);
  eview.setUint16(8, centrals.length, true);
  eview.setUint16(10, centrals.length, true);
  eview.setUint32(12, centralSize, true);
  eview.setUint32(16, offset, true);
  const all = [...parts, ...centrals, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** CRC-32, as the ZIP headers carry it. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The fixture directory: parts named after their part path, `/` written as `.`. */
const DIR = fileURLToPath(new URL("../fixtures/office/", import.meta.url));

/**
 * The part name one fixture file stands for.
 *
 * @param file - The file's name in `e2e/fixtures/office`.
 * @returns The part's path inside the document.
 *
 * @remarks
 * A part's file name is its part name with `/` written as `.` (`word/document.xml` is
 * `word.document.xml`), so the set stays one directory deep; the package root's
 * `[Content_Types].xml` and `_rels/.rels` carry a prefix, because a file name cannot start
 * with `_` in every tool that opens this directory.
 */
/** The part name of a fixture file, with each `/` put back where a part's directory ends. */
function partName(file: string): string {
  if (file === "pkg.Content_Types.xml") return "[Content_Types].xml";
  if (file === "pkg.rels") return "_rels/.rels";
  // word.document.xml -> word/document.xml; word._rels.document.xml.rels ->
  // word/_rels/document.xml.rels; ppt.slides._rels.slide1.xml.rels ->
  // ppt/slides/_rels/slide1.xml.rels (a part's rels live beside it, as OOXML has them)
  const rels = /^(.*?)\._rels\.(.*)\.rels$/u.exec(file);
  if (rels !== null) return (rels[1] ?? "") + "/_rels/" + (rels[2] ?? "") + ".rels";
  // A document part: only the extension's dot is not a directory separator.
  const extension = /\.(xml|rels)$/u.exec(file)?.[0] ?? "";
  return (extension === "" ? file : file.slice(0, -extension.length)).replace(/\./gu, "/") + extension;
}

export { partName };

/**
 * One format's package parts: its own [Content_Types].xml and _rels/.rels, and its content.
 *
 * @param format - The format whose package this is.
 * @returns Every part, by the name it is written as inside the document.
 *
 * @remarks
 * **A package's own files are per format.** [Content_Types].xml and _rels/.rels name the format's
 * main part (`word/document.xml`, `xl/workbook.xml`, `ppt/presentation.xml`), so a package that
 * took another format's copies is not a document of its own kind: the engine looks for the main
 * part the types declare and finds none (0239 — the xlsx fixture failed as "word/document.xml が
 * ありません"). The `<format>.Content_Types.xml` / `<format>.rels` files are that format's copies;
 * a format with none of its own uses the common one.
 */
function packageOf(format: FixtureFormat, names: readonly string[]): Uint8Array {
  const present = new Set(readdirSync(DIR));
  /** The fixture file one part is read from: the format's own copy when it has one. */
  const fileOf = (name: string): string => {
    if (name === "[Content_Types].xml" && present.has(format + ".Content_Types.xml")) {
      return format + ".Content_Types.xml";
    }
    if (name === "_rels/.rels" && present.has(format + ".rels")) return format + ".rels";
    return fileNameOfPart(name);
  };
  const picked = new Map<string, Uint8Array>();
  for (const name of names) {
    const file = fileOf(name);
    if (!present.has(file)) throw new Error("the fixture set has no " + name + " for " + format);
    picked.set(name, new Uint8Array(readFileSync(join(DIR, file))));
  }
  return zipOf(picked);
}

/** The fixture file name one part is kept under (the inverse of {@link partName}'s rule). */
function fileNameOfPart(name: string): string {
  if (name === "[Content_Types].xml") return "pkg.Content_Types.xml";
  if (name === "_rels/.rels") return "pkg.rels";
  // Exactly partName's rule run backwards: a part's directory, then `_rels`, then the
  // rels file's own name (`ppt/_rels/slide1.xml.rels` is `ppt._rels.slide1.xml.rels`).
  const rels = /^(.*)\/_rels\/([^/]+)\.rels$/u.exec(name);
  if (rels !== null) {
    return (rels[1] ?? "").replace(/\//gu, ".") + "._rels." + (rels[2] ?? "") + ".rels";
  }
  // A document part: only the extension's dot is not a directory separator.
  const extension = /\.(xml|rels)$/u.exec(name)?.[0] ?? "";
  return (extension === "" ? name : name.slice(0, -extension.length)).replace(/\//gu, ".") + extension;
}

/**
 * The documents the journey opens.
 *
 * @returns One fixture per format, in the order the journey opens them.
 *
 * @remarks
 * The page counts are the pack's own engine's (`tools/office-pack`, v0.8.7): each document has one
 * paragraph or one slide, so one page. The text is what page 1 must say once the engine drew it.
 */
export function officeFixtures(): readonly OfficeFixture[] {
  return [
    {
      format: "docx",
      path: "提案書.docx",
      text: "提案書の本文です",
      pages: 1,
      bytes: () =>
        packageOf("docx", [
          "[Content_Types].xml",
          "_rels/.rels",
          "word/document.xml",
          "word/_rels/document.xml.rels",
        ]),
    },
    {
      format: "xlsx",
      path: "売上表.xlsx",
      text: "売上表",
      pages: 1,
      bytes: () =>
        packageOf("xlsx", [
          "[Content_Types].xml",
          "_rels/.rels",
          "xl/workbook.xml",
          "xl/_rels/workbook.xml.rels",
          "xl/worksheets/sheet1.xml",
          "xl/styles.xml",
        ]),
    },
    {
      format: "pptx",
      path: "報告資料.pptx",
      text: "報告資料",
      pages: 1,
      bytes: () =>
        packageOf("pptx", [
          "[Content_Types].xml",
          "_rels/.rels",
          "ppt/presentation.xml",
          "ppt/_rels/presentation.xml.rels",
          "ppt/slides/slide1.xml",
          "ppt/slides/_rels/slide1.xml.rels",
          "ppt/slideLayouts/slideLayout1.xml",
          "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
          "ppt/slideMasters/slideMaster1.xml",
          "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        ]),
    },
  ];
}
