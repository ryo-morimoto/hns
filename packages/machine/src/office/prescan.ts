import { inflateRawSync } from "node:zlib";
import {
  MAX_OFFICE_ENTRIES,
  MAX_OFFICE_EXPANDED_BYTES,
  OFFICE_MAX_PDF_PAGES,
} from "@hns/core/office";
import type { OfficeErrorCode, OfficeFormat, OfficeLimits } from "@hns/core/office";

/**
 * What the prescan learned about one input, before the engine runs (§10).
 *
 * @remarks
 * The engine defends nothing: it reads a zip, unpacks it, lays the document out and exits when it
 * is done, so an input that is too big for the machine is a process that runs until the machine is
 * out of memory. The prescan is what turns that into an answer: the archive is read here, without
 * the engine, and a document over a bound is refused before a process is spawned (INV-O5).
 */
export interface OfficeScan {
  /** The sum of every entry's declared uncompressed size, in bytes. */
  readonly declaredBytes: number;
  /** Bytes the prescan actually inflated while checking the declared sizes. */
  readonly inflatedBytes: number;
  /** Entries in the archive (a zip directory entry per file). */
  readonly entries: number;
  /** Cells in a workbook, or 0 for a format where cells mean nothing. */
  readonly cells: number;
  /** The page count a declared PDF carries, or 0 where layout decides it. */
  readonly pages: number;
}

/** The prescan's verdict: the document may run, or the office code that refuses it. */
export type OfficeScanVerdict =
  | { readonly ok: true; readonly scan: OfficeScan }
  | { readonly ok: false; readonly error: OfficeErrorCode; readonly message: string };

/** The bytes a caller scans, with what the messages need to name them. */
export interface OfficeScanInput {
  readonly format: OfficeFormat;
  readonly limits: OfficeLimits;
  readonly bytes: Uint8Array;
  /** What the file is on disk, for the message; absent means the request's path. */
  readonly name: string;
}

/** A zip's central directory entry, as the prescan reads it. */
interface ZipEntry {
  readonly name: string;
  /** 0 stores, 8 deflates; anything else is a method this prescan does not inflate. */
  readonly method: number;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  /** Where the entry's local header starts. */
  readonly localOffset: number;
}

/** What counting a workbook's cells found. */
interface CellCount {
  readonly cells: number;
  readonly inflatedBytes: number;
}

/** A zip's directory: its entries and the total they declare. */
interface ZipListing {
  readonly entries: readonly ZipEntry[];
  readonly declaredBytes: number;
}

/**
 * Bytes the prescan may inflate while counting, across every entry it reads.
 *
 * @remarks
 * A declared size is a claim by the archive, and a decompression bomb is exactly an archive whose
 * claims are true. The prescan inflates at most this much, of the entries that decide the cell
 * count (a workbook's shared strings and sheets), which is enough to count and far too little to
 * be the bomb.
 */
const INFLATE_BUDGET_BYTES = 64 * 1024 * 1024;

/** The most one entry may expand to, as a share of the job's input bound. */
const ENTRY_EXPANSION_SHARE = 16;

/** A cell reference: column letters, then a 1-based row (`B12`). */
const CELL_REFERENCE = /^([A-Z]{1,3})([0-9]{1,7})$/u;

/** A worksheet part: `xl/worksheets/sheet1.xml` and its siblings. */
const WORKSHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/u;

/** How much of a PDF's stream the prescan reads when it looks for a page object. */
const PAGE_HEADER_BYTES = 64 * 1024;

/** The signature a PDF starts with. */
const PDF_SIGNATURE = "%PDF-";

/**
 * Decide whether one input may run, from the file alone.
 *
 * @param input - The format, the job's bounds, and the bytes.
 * @returns The scan and `ok: true`, or the office code and a message that names the bound.
 *
 * @remarks
 * The order is cheapest first and follows docs/office.md §9: the input's own size, then the
 * archive's entries and their expansion, then a workbook's cells, then a PDF's pages. Nothing here
 * runs the engine, writes a file, or reads outside `bytes`.
 *
 * A `.docx`, `.xlsx` or `.pptx` that is not a zip is `unsupported_format`: the format the job
 * named is not what the file is, and the engine would refuse it a second later with a worse
 * message. Cells are counted from a workbook's own `<dimension>` reference, which the engine reads
 * too; pages are read from a PDF's page tree.
 */
export function scanOfficeInput(input: OfficeScanInput): OfficeScanVerdict {
  const { bytes, limits, name } = input;
  if (bytes.byteLength > limits.maxInputBytes) {
    return refuse(
      "input_too_large",
      name +
        ": " +
        String(bytes.byteLength) +
        " bytes is over the " +
        String(limits.maxInputBytes) +
        " byte input limit",
    );
  }
  if (input.format === "pdf") return scanPdf(bytes, name);
  const listing = readZipDirectory(bytes);
  if (listing === undefined) {
    return refuse("unsupported_format", name + ": the file is not an " + input.format + " archive");
  }
  const refused = archiveOverBound(listing, limits, name);
  if (refused !== undefined) return refused;
  const counted =
    input.format === "xlsx" ? countCells(listing, bytes) : { cells: 0, inflatedBytes: 0 };
  if (counted.cells > limits.maxCells) {
    return refuse(
      "too_many_cells",
      name +
        ": the workbook holds " +
        String(counted.cells) +
        " cells, over the " +
        String(limits.maxCells) +
        " cell limit",
    );
  }
  return {
    ok: true,
    scan: {
      declaredBytes: listing.declaredBytes,
      inflatedBytes: counted.inflatedBytes,
      entries: listing.entries.length,
      cells: counted.cells,
      pages: 0,
    },
  };
}

/** Refuse a listing whose entries are over the count or size bounds; undefined inside them. */
function archiveOverBound(
  listing: ZipListing,
  limits: OfficeLimits,
  name: string,
): OfficeScanVerdict | undefined {
  const entries = listing.entries.length;
  if (entries > MAX_OFFICE_ENTRIES) {
    return refuse(
      "input_too_large_archive",
      name +
        ": the archive holds " +
        String(entries) +
        " entries, over the " +
        String(MAX_OFFICE_ENTRIES) +
        " entry limit",
    );
  }
  // A single entry is the unit the engine reads whole, so it has its own bound beside the
  // archive's: many medium entries and one huge one are the same bytes and different failures.
  const entryBound = Math.min(
    MAX_OFFICE_EXPANDED_BYTES,
    limits.maxInputBytes * ENTRY_EXPANSION_SHARE,
  );
  for (const entry of listing.entries) {
    if (entry.uncompressedBytes > entryBound) {
      return refuse(
        "input_too_large_archive",
        name +
          ": " +
          entry.name +
          " expands to " +
          String(entry.uncompressedBytes) +
          " bytes, over the " +
          String(entryBound) +
          " byte entry limit",
      );
    }
  }
  if (listing.declaredBytes > MAX_OFFICE_EXPANDED_BYTES) {
    return refuse(
      "input_too_large_archive",
      name +
        ": the archive expands to " +
        String(listing.declaredBytes) +
        " bytes, over the " +
        String(MAX_OFFICE_EXPANDED_BYTES) +
        " byte limit",
    );
  }
  return undefined;
}

/** A refusal with the office code §9 gives the bound. */
function refuse(error: OfficeErrorCode, message: string): OfficeScanVerdict {
  return { ok: false, error, message };
}

/** Read a little-endian 16-bit value. */
function uint16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

/** Read a little-endian 32-bit value, unsigned. */
function uint32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16)) +
    (bytes[at + 3] ?? 0) * 0x1000000
  );
}

/** Read a little-endian 64-bit value as a safe integer, or undefined when it does not fit. */
function uint64(bytes: Uint8Array, at: number): number | undefined {
  const low = uint32(bytes, at);
  const high = uint32(bytes, at + 4);
  return high > 0x1fffff ? undefined : high * 0x100000000 + low;
}

/** The fixed part of a central directory entry, before the name. */
const CENTRAL_ENTRY_BYTES = 46;

/**
 * Read a zip's central directory, or answer undefined when the bytes are not a zip.
 *
 * @param bytes - The file.
 * @returns The entries and their total declared size.
 *
 * @remarks
 * The central directory is what a zip reader trusts for names and sizes; the local headers repeat
 * them, but a truncated archive can disagree, so the sizes come from the directory and the data
 * offset from the local header, which is where the compressed bytes begin. A directory whose
 * records do not all parse is not a zip this prescan can vouch for, so the whole listing is
 * undefined rather than a partial one.
 */
function readZipDirectory(bytes: Uint8Array): ZipListing | undefined {
  const end = findEndOfCentralDirectory(bytes);
  if (end === undefined) return undefined;
  let count = uint16(bytes, end + 10);
  let offset = uint32(bytes, end + 16);
  // Zip64: when a field is 0xffffffff / 0xffff, the real one is in the zip64 record the locator
  // points at. Only the fields the prescan reads are followed.
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = findSignatureBackwards(bytes, end, [0x50, 0x4b, 0x06, 0x07]);
    if (locator === undefined) return undefined;
    const recordAt = uint64(bytes, locator + 8);
    if (recordAt === undefined || recordAt + 56 > bytes.length) return undefined;
    count = Number(uint64(bytes, recordAt + 32) ?? Number.NaN);
    offset = uint64(bytes, recordAt + 48) ?? Number.NaN;
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(offset)) return undefined;
  }
  if (offset + count * CENTRAL_ENTRY_BYTES > bytes.length) return undefined;
  const entries: ZipEntry[] = [];
  let declaredBytes = 0;
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (
      bytes[at] !== 0x50 ||
      bytes[at + 1] !== 0x4b ||
      bytes[at + 2] !== 0x01 ||
      bytes[at + 3] !== 0x02
    ) {
      return undefined;
    }
    const method = uint16(bytes, at + 10);
    const compressedBytes = uint32(bytes, at + 20);
    const uncompressedBytes = uint32(bytes, at + 24);
    const nameLength = uint16(bytes, at + 28);
    const extraLength = uint16(bytes, at + 30);
    const commentLength = uint16(bytes, at + 32);
    const localOffset = uint32(bytes, at + 42);
    const nameAt = at + CENTRAL_ENTRY_BYTES;
    if (nameAt + nameLength > bytes.length) return undefined;
    const name = new TextDecoder().decode(bytes.subarray(nameAt, nameAt + nameLength));
    entries.push({ name, method, compressedBytes, uncompressedBytes, localOffset });
    declaredBytes += uncompressedBytes;
    at = nameAt + nameLength + extraLength + commentLength;
  }
  return { entries, declaredBytes };
}

/** Find a 4-byte signature at or before `from`, searching backwards; undefined when absent. */
function findSignatureBackwards(
  bytes: Uint8Array,
  from: number,
  signature: readonly number[],
): number | undefined {
  for (let at = from - 4; at >= 0; at -= 1) {
    if (signature.every((byte, index) => bytes[at + index] === byte)) return at;
  }
  return undefined;
}

/** Where a zip's end-of-central-directory record starts, or undefined when there is none. */
function findEndOfCentralDirectory(bytes: Uint8Array): number | undefined {
  // The record is 22 bytes plus a comment of at most 64 KiB, so it starts no earlier than that.
  return findSignatureBackwards(bytes, bytes.length - 22 + 4, [0x50, 0x4b, 0x05, 0x06]);
}

/**
 * The bytes of one entry, inflated when it is deflated.
 *
 * @param bytes - The file.
 * @param entry - The entry, as the central directory lists it.
 * @param budget - The bytes this call may inflate; the stream is cut to it.
 * @returns The head of the entry, at most `budget` bytes, or undefined when it cannot be read.
 *
 * @remarks
 * The data begins after the local header, whose name and extra field may differ in length from
 * the directory's: reading the offsets from the directory would decode the header as content.
 * A deflated stream is cut down to `budget` before it is inflated, so the work is bounded by the
 * budget and not by what the archive claims.
 */
function entryBytes(bytes: Uint8Array, entry: ZipEntry, budget: number): Uint8Array | undefined {
  if (budget <= 0) return undefined;
  const at = entry.localOffset;
  if (at + 30 > bytes.length) return undefined;
  const nameLength = uint16(bytes, at + 26);
  const extraLength = uint16(bytes, at + 28);
  const start = at + 30 + nameLength + extraLength;
  const end = Math.min(start + entry.compressedBytes, bytes.length);
  if (end <= start) return undefined;
  const data = bytes.subarray(start, end);
  if (entry.method === 0) return data.slice(0, budget);
  if (entry.method !== 8) return undefined;
  // zlib's `maxOutputLength` is a hard stop: a stream whose output would cross it throws rather
  // than returning a short buffer. The head of the entry is what is wanted, so the bound is the
  // budget; the input is left whole, and zlib stops reading it once the output crosses the bound.
  try {
    return inflateRawSync(data, { maxOutputLength: budget });
  } catch {
    return undefined;
  }
}

/**
 * Count a workbook's cells from its own dimension references.
 *
 * @param listing - The archive's entries.
 * @param bytes - The file.
 * @returns The cells, and the bytes the prescan inflated to read them.
 *
 * @remarks
 * A sheet declares `<dimension ref="A1:AE500"/>` in its first bytes; the engine reads that same
 * reference to size the sheet, so the count here is the count the engine will allocate. A sheet
 * whose head cannot be inflated is skipped rather than guessed at: the engine then refuses the
 * workbook itself, which is a typed failure rather than a prescan that invented a number.
 */
function countCells(listing: ZipListing, bytes: Uint8Array): CellCount {
  let left = INFLATE_BUDGET_BYTES;
  let cells = 0;
  let used = 0;
  for (const entry of listing.entries) {
    if (!WORKSHEET_PART.test(entry.name)) continue;
    const head = entryBytes(bytes, entry, left);
    if (head === undefined) continue;
    left -= head.byteLength;
    used += head.byteLength;
    cells += cellsInSheet(new TextDecoder().decode(head));
  }
  return { cells, inflatedBytes: used };
}

/** The cell count a sheet's dimension reference names, or 0 when it names none. */
function cellsInSheet(xml: string): number {
  const match = /<dimension[^>]*\bref="([^"]+)"/u.exec(xml);
  if (match === null) return 0;
  const range = match[1];
  if (range === undefined) return 0;
  const [from, to = from] = range.split(":");
  if (from === undefined || to === undefined) return 0;
  const start = parseCellRef(from);
  const end = parseCellRef(to);
  if (start === undefined || end === undefined) return 0;
  const columns = Math.abs(end.column - start.column) + 1;
  const rows = Math.abs(end.row - start.row) + 1;
  return columns * rows;
}

/** A cell reference as its 0-based column and 1-based row; undefined when it is not one. */
function parseCellRef(text: string): { readonly column: number; readonly row: number } | undefined {
  const match = CELL_REFERENCE.exec(text);
  if (match === null) return undefined;
  const letters = match[1];
  const row = Number(match[2]);
  if (letters === undefined || !Number.isSafeInteger(row) || row < 1) return undefined;
  let column = 0;
  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64);
  return { column, row };
}

/**
 * Count the pages a PDF declares, and refuse one over the preview bound.
 *
 * @param bytes - The file.
 * @param name - The file's name, for the message.
 * @returns The scan, or the office code that refuses the file.
 *
 * @remarks
 * A PDF is an input to preview and convert only (no operation converts into it), and a job naming
 * pages is refused before this runs: the engine exports every page and has no `--pages`. The page
 * count is read from the catalogue (`/Count` in the page tree); a PDF whose catalogue this prescan
 * cannot read is not refused here, because the engine is the one that decides whether it can open
 * it, and a preview would fail with a typed code rather than run away.
 */
function scanPdf(bytes: Uint8Array, name: string): OfficeScanVerdict {
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, PAGE_HEADER_BYTES * 64));
  if (!text.startsWith(PDF_SIGNATURE)) {
    return refuse("unsupported_format", name + ": the file is not a PDF");
  }
  const pages = pdfPageCount(text);
  if (pages !== 0 && pages > OFFICE_MAX_PDF_PAGES) {
    return refuse(
      "too_many_pages",
      name +
        ": the PDF has " +
        String(pages) +
        " pages, over the " +
        String(OFFICE_MAX_PDF_PAGES) +
        " page limit",
    );
  }
  return {
    ok: true,
    scan: { declaredBytes: bytes.byteLength, inflatedBytes: 0, entries: 0, cells: 0, pages },
  };
}

/**
 * The largest `/Count` a page tree declares.
 *
 * @param text - As much of the PDF as the prescan read.
 * @returns The count, or 0 when the text names none.
 */
function pdfPageCount(text: string): number {
  let pages = 0;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,512}?\/Count\s+([0-9]{1,7})/gu)) {
    const count = Number(match[1]);
    if (Number.isSafeInteger(count) && count > pages) pages = count;
  }
  return pages;
}
