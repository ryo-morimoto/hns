import { expect, test } from "vitest";
import { DEFAULT_OFFICE_LIMITS } from "@hns/core/office";
import type { OfficeLimits } from "@hns/core/office";
import { buildZip64, zipOf } from "../../test/support/zip.ts";
import { scanOfficeInput } from "./prescan.ts";

// The prescan is what turns "the engine ran out of memory" into an answer, so each test here states
// a bound and the refusal it must produce *before* anything runs: no engine is started, and the
// only input is a byte array.

/** The fixture's bounds, with the one a scenario bends. */
function limits(overrides: Partial<OfficeLimits> = {}): OfficeLimits {
  return { ...DEFAULT_OFFICE_LIMITS, ...overrides };
}

/** Scan one archive as a document of the named format. */
function scan(bytes: Uint8Array, format: "docx" | "xlsx" | "pptx" | "pdf", bounds = limits()) {
  return scanOfficeInput({ format, limits: bounds, bytes, name: "document." + format });
}

/** A workbook whose one sheet declares the given dimension. */
function workbook(dimension: string): Uint8Array {
  return zipOf(
    new Map([
      [
        "xl/worksheets/sheet1.xml",
        '<?xml version="1.0" encoding="UTF-8"?><worksheet><dimension ref="' +
          dimension +
          '"/><sheetData/></worksheet>',
      ],
    ]),
  );
}

// Catches: a workbook of 310,000 cells (31 columns x 10,000 rows) answered "ok" so the engine runs
// and allocates it, or refused with a code the contract does not have for a size.
test("C1: a workbook over the cell bound is too_many_cells, before anything runs", () => {
  const verdict = scan(workbook("A1:AE10000"), "xlsx");
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  expect(verdict.error).toBe("too_many_cells");
  expect(verdict.message).toContain("310000");
});

// Catches: the cell bound ignored for the document that actually holds the cells (the dimension
// is read from the workbook's own sheet part, and a limit of 1 accepts nothing).
test("C1: a workbook inside the bound is ok, and its count is reported", () => {
  const accepted = scan(workbook("A1:B10"), "xlsx");
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  expect(accepted.scan.cells).toBe(20);
  // The same bytes under a tighter bound are refused by the same number.
  const refused = scan(workbook("A1:B10"), "xlsx", limits({ maxCells: 19 }));
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.error).toBe("too_many_cells");
});

// Catches: a document that is not a zip at all read as one (the engine would say "ZIP 形式ではない"
// a second later), and a format the job named that the file is not.
test("a .docx that is not an archive is unsupported_format", () => {
  const verdict = scan(new TextEncoder().encode("not a zip"), "docx");
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  expect(verdict.error).toBe("unsupported_format");
});

// Catches: an input over the job's own byte bound reaching the engine; the prescan refuses it
// first, and its message names the bound rather than the engine's failure.
test("an input over maxInputBytes is input_too_large", () => {
  const verdict = scan(new Uint8Array(64), "docx", limits({ maxInputBytes: 32 }));
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  expect(verdict.error).toBe("input_too_large");
  expect(verdict.message).toContain("32");
});

// Catches: a decompression bomb counted as its bytes on disk. The entry declares 700 MiB from a
// single stored byte, which is what a bomb claims, and the prescan refuses it before it is read.
test("an archive that expands past the bound is input_too_large_archive", () => {
  const declared = 700 * 1024 * 1024;
  const bomb = zipOf(new Map([["word/document.xml", "x"]]), {
    declaredBytes: new Map([["word/document.xml", declared]]),
  });
  const verdict = scan(bomb, "docx");
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  expect(verdict.error).toBe("input_too_large_archive");
  expect(verdict.message).toContain("word/document.xml");
});

// Catches: the many-tiny-parts zip bomb. More than 65,535 entries makes it a zip64 archive, whose
// count is in the zip64 record and not in the saturated 16-bit field; the prescan must read the
// record, or the fixture that exercises the entry bound at all would be read as the 65,535 the
// field says. A reader that trusts the short field lists a directory that is not there.
test("an archive with too many entries is input_too_large_archive", () => {
  const archive = buildZip64(100_001);
  const verdict = scan(archive, "docx", limits({ maxInputBytes: archive.byteLength + 1 }));
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  expect(verdict.error).toBe("input_too_large_archive");
  expect(verdict.message).toContain("100001");
});

// Catches: a PDF with more pages than a preview may hold read as a preview (the engine would
// export every one of them); and a non-PDF named as one.
test("a PDF over the page bound is too_many_pages, and a non-PDF is unsupported_format", () => {
  const pages = 400;
  const pdf = new TextEncoder().encode(
    "%PDF-1.7\n1 0 obj\n<< /Type /Pages /Count " + String(pages) + " >>\nendobj\n%%EOF\n",
  );
  const verdict = scan(pdf, "pdf");
  expect(verdict.ok).toBe(false);
  if (verdict.ok) return;
  expect(verdict.error).toBe("too_many_pages");
  const notPdf = scan(new TextEncoder().encode("hello"), "pdf");
  expect(notPdf.ok).toBe(false);
  if (notPdf.ok) return;
  expect(notPdf.error).toBe("unsupported_format");
});

// Catches: a PDF inside the page bound refused, and its pages not reported (a preview needs the
// count to know what it is presenting).
test("a PDF inside the page bound is ok, with its page count", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Pages /Count 3 >>\n");
  const verdict = scan(pdf, "pdf");
  expect(verdict.ok).toBe(true);
  if (!verdict.ok) return;
  expect(verdict.scan.pages).toBe(3);
});
