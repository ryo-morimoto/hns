import * as v from "valibot";
import { canonicalize } from "./capability/canonical.ts";
import { OperationIdSchema } from "./codecs.ts";
import type { OperationId } from "./codecs.ts";

/**
 * The Office contract: the one vocabulary the machine, the server, the web, and the agent import.
 *
 * @remarks
 * Office is four lanes (machine, server, web, agent) that must agree on words before any of them
 * runs: what one job names, what an answer carries, which failures are expected, and what the
 * cache key is. This module is the contract (0234; the decision is D102 for the engine and D103
 * for the cache and the delivery, and `docs/office.md` §2 / §9 / §10 / §11 is its meaning).
 *
 * **The types here are the source of truth**, not `types.ts`: they are the wire between two
 * packages rather than one public model. Every schema is declared as
 * `v.GenericSchema<unknown, T>`, so a schema that drifts from its type does not compile, and the
 * golden fixtures under `test/fixtures/office/` are written by hand so the two can be compared.
 *
 * **This module imports nothing from `node:` and no `@hns` package.** The Worker bundle carries it
 * (the server and the web import the vocabulary), so hashing is WebCrypto, exactly as
 * `deviceKeyFingerprint` is.
 *
 * The vocabulary version is `v: 1` (§12): a new field is optional, and a breaking change is `v2`
 * with the old `v` accepted for one release.
 */

/**
 * The formats the engine handles (§1).
 *
 * @remarks
 * `pdf` is an input: previewing a PDF is a copy, not a conversion, and no operation converts into
 * it. ODF, CSV, HTML, and the legacy formats are out of scope (D102).
 */
export const OFFICE_FORMATS = ["docx", "xlsx", "pptx", "pdf"] as const;

/** One format a job may name. */
export type OfficeFormat = (typeof OFFICE_FORMATS)[number];

/**
 * The operations one job may name (§2).
 *
 * @remarks
 * `render` is its own operation rather than a format of `preview`: a preview is the PDF a browser
 * draws, and a render is the PNG an agent looks at. U-01 in 0234 asked the question and it is
 * decided to keep them apart, so a job names exactly one of these six and its own options.
 */
export const OFFICE_OPERATIONS = [
  "preview",
  "render",
  "inspect",
  "edit",
  "convert",
  "recalc",
] as const;

/** One operation a job may name. */
export type OfficeOperation = (typeof OFFICE_OPERATIONS)[number];

/**
 * The expected failures of an office job (§9).
 *
 * @remarks
 * The code is the contract and the message is diagnostic. `unsupported_format` is the one code
 * that produces the `unsupported` state instead of `failed`: a format the pack does not handle is
 * refused at request time, while a limit is a failure with a code. Nothing here is a defect; a
 * defect is a 500 and never one of these.
 *
 * Adding a member requires updating every exhaustive `switch` over {@link OfficeErrorCode}, which
 * is what the tests over this file pin with `never`.
 */
export const OFFICE_ERROR_CODES = [
  /** The format is outside the pack's capabilities (odt and the rest). */
  "unsupported_format",
  /** An edit or recalc command outside the v1 vocabulary. */
  "unsupported_command",
  /** The input is larger than `limits.maxInputBytes`. */
  "input_too_large",
  /** The input declares more entries, or expands to more bytes, than the machine will read. */
  "input_too_large_archive",
  /** The declared PDF carries more pages than a preview may hold. */
  "too_many_pages",
  /** The workbook's cell count is larger than `limits.maxCells`. */
  "too_many_cells",
  /** The rendered image is larger than `limits.maxPixels`. */
  "too_many_pixels",
  /** The pack is missing, broken, or gone while the job runs. */
  "engine_unavailable",
  /** The engine did not finish inside the job's budget. */
  "engine_timeout",
  /** The engine ran and failed. */
  "engine_failed",
  /** Another job holds the machine's single office slot. */
  "engine_busy",
  /** The output is larger than `limits.maxOutputBytes`. */
  "output_too_large",
  /** The input's version is no longer the workspace's version (INV-O2). */
  "source_changed",
  /** The caller may not read the input or write the output. */
  "not_authorized",
  /** A person cancelled the job. */
  "cancelled",
] as const;

/** One expected failure of an office job. */
export type OfficeErrorCode = (typeof OFFICE_ERROR_CODES)[number];

/**
 * What the machine answers a refusal with, and the office code it means (§9).
 *
 * @remarks
 * The machine's refusals are its own vocabulary (`MACHINE_REFUSALS` in `machine.ts`); a job row
 * stores an {@link OfficeErrorCode}, and this table is the one place the projection is written.
 * It is keyed by every machine refusal, and a test walks `MACHINE_REFUSALS` through it, so a
 * refusal added on the machine's side lands on `engine_failed` only by a decision visible here.
 *
 * `invalid_request` is a malformed input (a `..` in a key), not a containment refusal: §9 keeps
 * the two apart.
 */
export const MACHINE_REFUSAL_TO_OFFICE_ERROR = {
  /** Another job holds the single slot; do not wait (0236). */
  busy: "engine_busy",
  /** The input is over the request's byte bound. */
  too_large: "input_too_large",
  /** The request ran out of its budget. */
  deadline_exceeded: "engine_timeout",
  /** The path is outside ROOT, or the ROOT is not the workspace's. */
  path_denied: "not_authorized",
  /** The caller may not do this. */
  forbidden: "not_authorized",
  /** The input is not what the job names. */
  invalid_request: "unsupported_command",
  /** The caller is not authenticated. */
  unauthorized: "engine_failed",
  stale_request: "engine_failed",
  replayed: "engine_failed",
  stale_connection: "engine_failed",
  not_found: "engine_failed",
  method_not_allowed: "engine_failed",
  internal: "engine_failed",
} as const satisfies Readonly<Record<string, OfficeErrorCode>>;

/**
 * The reason a machine gives when a `source` write arrives before the cache read exists (0241).
 *
 * @remarks
 * The reason travels beside the refusal code as its message; this constant is its one spelling,
 * so the machine that writes it and the server that reads it cannot drift. It is **temporary**:
 * when 0241 reads the cache, this string and the mapping exception in {@link officeErrorOfRefusal}
 * go away together.
 */
export const OFFICE_CACHE_UNAVAILABLE_REASON =
  "a source write needs the office cache, which this machine does not serve";

/** The diagnostic text a machine refusal carries beside its code. */
export type MachineRefusalReason = string;

/**
 * The preview states (§3).
 *
 * @remarks
 * Seven, and `stale` is one of them: "the machine could not be asked, so the result is unknown"
 * must not be rounded into `failed`. `unsupported` and `disabled` are produced when a request is
 * accepted, not by an alarm, and are terminal for that job.
 */
export const PREVIEW_STATUSES = [
  "unsupported",
  "disabled",
  "queued",
  "generating",
  "ready",
  "failed",
  "stale",
] as const;

/** One preview state. */
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

/**
 * The smallest page count a preview may report as success (§10).
 *
 * @remarks
 * A zero-page PDF is a failed conversion wearing a success, so the result schema refuses it.
 */
export const OFFICE_MIN_PAGES = 1;

/** The most pages a preview PDF may have (§10). */
export const OFFICE_MAX_PDF_PAGES = 300;

/**
 * The default office limits (§10).
 *
 * @remarks
 * **The defaults are in exactly one place: here.** A server and a machine that each resolved their
 * own would change a cache key when one of them was edited, so the resolved limits travel in the
 * job ({@link OfficeJob.limits}) and nobody defaults them again.
 *
 * The input bound is 50 MiB (the heaviest spike input is 13.7 MB); 300,000 cells (RSS of about
 * 60 MB plus 5 KB per cell); 24 million pixels (RSS of about 4 bytes per pixel); 60 s (the
 * heaviest conversion took 17 s, and the machine's own office budget is 90 s, so a job is clamped
 * below it); 100 MiB out (the write path to ROOT; the 31 MB spike PDF is inside it).
 *
 * **No value here is 0.** Every bound is a bound: 0 would mean "no limit", and a job that disables
 * its own limits is refused at the boundary.
 */
export const DEFAULT_OFFICE_LIMITS = {
  maxInputBytes: 50 * 1024 * 1024,
  maxCells: 300_000,
  maxPixels: 24_000_000,
  timeoutMs: 60_000,
  maxOutputBytes: 100 * 1024 * 1024,
} as const satisfies OfficeLimits;

/** The smallest machine-side office budget, in milliseconds (§5). */
export const MIN_OFFICE_TIMEOUT_MS = 60_000;

/**
 * The margin a job leaves below the machine's office budget (§5).
 *
 * @remarks
 * A job is clamped to `min(job.timeoutMs, office.timeoutMs - OFFICE_DEADLINE_MARGIN_MS)`, so the
 * machine answers `engine_timeout` itself instead of being cut off mid-answer.
 */
export const OFFICE_DEADLINE_MARGIN_MS = 5_000;

/**
 * The page and width bounds of a PNG render (§10).
 *
 * @remarks
 * A render is for an agent's visual QA, so it is a few pages at a readable width, not the whole
 * document.
 */
export const OFFICE_RENDER_MAX_PAGES = 10;
export const OFFICE_RENDER_MAX_WIDTH = 1600;

/**
 * One bound on an office job (§10).
 *
 * @remarks
 * Every field is a positive integer in bytes, cells, pixels, or milliseconds, and the schema
 * refuses any other value: a bound of 0 or below would disable the check it names (INV-O5).
 */
export interface OfficeLimits {
  /** Bytes in the input file. */
  readonly maxInputBytes: number;
  /** Cells in one workbook. */
  readonly maxCells: number;
  /** Pixels in one rendered image. */
  readonly maxPixels: number;
  /** The job's wall clock, clamped below the machine's office budget. */
  readonly timeoutMs: number;
  /** Bytes in the produced artifact. */
  readonly maxOutputBytes: number;
}

/**
 * The input one job names (§2).
 *
 * @remarks
 * `version` is the workspace's version, whose body is the content hash: `sha256:` and 64 lowercase
 * hex. Two inputs with the same body therefore share a cache key (§4), and a job whose `version`
 * no longer matches is refused `source_changed` before anything runs (INV-O2).
 *
 * `workspaceId` is the workspace's identity, one to one with the machine's ROOT: a path alone
 * would let a job that names one workspace be resolved against another.
 *
 * The path stays a string: it is workspace-relative, and resolving it (and refusing `..`) is the
 * machine's job behind the single containment function, not this schema's.
 */
export interface OfficeInput {
  /** The workspace's identity, one to one with the machine's ROOT. */
  readonly workspaceId: string;
  /** The file, relative to the workspace. */
  readonly path: string;
  /** The workspace's version of the file: `sha256:` and 64 lowercase hex. */
  readonly version: string;
  /** The format the file is in; it must agree with the pack's capabilities. */
  readonly format: OfficeFormat;
}

/**
 * One page selection, either a contiguous range or a single page.
 *
 * @remarks
 * A range whose `to` is below its `from` is not a selection, so the schema refuses it rather than
 * reading it backwards.
 */
export interface OfficePageRange {
  /** The first page, 1-based. */
  readonly from: number;
  /** The last page, 1-based, not below `from`. */
  readonly to: number;
}

/**
 * The options a page-selecting operation carries (§2).
 *
 * @remarks
 * An absent `pages` means "every page". The shape is shared by `preview` and `render`, so one
 * schema describes both to {@link officeParamsHash}; the bounds differ and live with each
 * operation ({@link OFFICE_MAX_PDF_PAGES}, {@link OFFICE_RENDER_MAX_PAGES}).
 */
export interface OfficePageOptions {
  /** The pages to produce; absent means every page. */
  readonly pages?: readonly (number | OfficePageRange)[] | undefined;
}

/**
 * A paragraph target an edit names (§2).
 *
 * @remarks
 * A paragraph is addressed by the id `inspect` reported, never by matching its text, which is
 * ambiguous the moment two paragraphs read alike.
 */
export interface ParagraphTarget {
  /** The 1-based paragraph id `inspect` reported. */
  readonly paragraphId: number;
}

/**
 * One cell's new value (§2).
 *
 * @remarks
 * A formula is stored as text (`=SUM(B2:B9)`); the engine computes it. These are the three value
 * kinds v1 edits, and no other.
 */
export type CellValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "formula"; readonly formula: string };

/** One cell edit: a cell reference such as `B12`, and the value it takes. */
export interface CellEdit {
  /** The cell's reference, as a spreadsheet names it: `B12`. */
  readonly ref: string;
  /** The new value. */
  readonly value: CellValue;
}

/**
 * One edit of a document, a workbook, or a presentation (§2).
 *
 * @remarks
 * The v1 vocabulary is three commands, chosen so a model cannot break a document: change a
 * paragraph's text, set cells in a sheet, or set a shape's text on a slide. A job that names
 * another command does not parse, and the machine answers `unsupported_command` for one it
 * accepted from a newer server; neither is a silent no-op.
 */
export type OfficeCommand =
  | { readonly op: "setText"; readonly paragraphId: number; readonly text: string }
  | { readonly op: "setCells"; readonly sheet: string; readonly cells: readonly CellEdit[] }
  | {
      readonly op: "setShapeText";
      readonly slide: number;
      // The pack's own name for the shape on the slide (§2 spells it `shape`; D102's engine names
      // it), so the wire keeps that name and this local tells the linter why.
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names
      readonly shape: number;
      readonly text: string;
    };

/** One edit command's name: the discriminator a `switch` over {@link OfficeCommand} narrows on. */
export type OfficeCommandName = OfficeCommand["op"];

/**
 * The three edit commands, as the one place their names are listed.
 *
 * @remarks
 * A test walks this list and a `switch` over the union, so a command added to one without the
 * other fails to compile.
 */
export const OFFICE_COMMAND_NAMES = [
  "setText",
  "setCells",
  "setShapeText",
] as const satisfies readonly OfficeCommandName[];

/**
 * The options an operation with none carries.
 *
 * @remarks
 * `inspect` and `recalc` take no option, and this is what says so: the only value is `{}`, so a
 * job that names `commands` on an inspect does not compile here and does not parse at the
 * boundary. An index signature of `never` cannot express that (it would collide with the job's own
 * fields), which is why this is a named empty type.
 */
export type NoOfficeOptions = Record<never, never>;

/**
 * The options each operation carries, keyed by the operation (§2).
 *
 * @remarks
 * `preview` and `render` carry pages; `render` also carries a width; `edit` carries commands;
 * `convert` names `pdf`; `inspect` and `recalc` carry nothing, and they carry no empty object: a
 * job that names an option its operation does not take is not that operation.
 */
export interface OfficeOperationOptions {
  readonly preview: OfficePageOptions;
  readonly render: OfficePageOptions & {
    /** The rendered width in pixels; absent means the pack's default. */
    readonly width?: number | undefined;
  };
  readonly inspect: NoOfficeOptions;
  readonly edit: { readonly commands: readonly OfficeCommand[] };
  readonly convert: { readonly to: "pdf" };
  readonly recalc: NoOfficeOptions;
}

/**
 * One office job, as the server asks the machine to run it (§2).
 *
 * @remarks
 * `operation` is the discriminator, and the options sit beside it on the same object rather than
 * under a second discriminated union: one job shape, one cache key, and one place to refuse a
 * mixed request (`{ operation: "preview", commands: [...] }` has no member that accepts both).
 *
 * `limits` is resolved by the server from its policy and carried here, because the machine must
 * not invent bounds the server did not state; `v: 1` is the contract version (§12), and `id` is an
 * {@link OperationId}, so the audit row (`office.job`) and an idempotent retry name the same
 * string.
 */
export type OfficeJob = {
  /** The contract version; a breaking change is 2 (§12). */
  readonly v: 1;
  /** The job's id: what the audit row records and a retry repeats. */
  readonly id: OperationId;
  /** The workspace file the job reads. */
  readonly input: OfficeInput;
  /** The bounds the server resolved; the machine enforces exactly these. */
  readonly limits: OfficeLimits;
} & {
  readonly [K in OfficeOperation]: { readonly operation: K } & OfficeOperationOptions[K];
}[OfficeOperation];

/**
 * The engine a pack provides, as `op: "officeEngine"` reports it (§5, §11).
 *
 * @remarks
 * `available: false` carries a reason a person can act on; `available: true` carries what the pack
 * declared. `operations` names only what the pack can actually produce: the v0.8.7 release is
 * `preview` / `render` / `convert`, and `inspect` / `edit` / `recalc` are declared once the
 * sidecar (0242) exists.
 */
export type OfficeEngineReport =
  | {
      readonly available: true;
      /** The pack's id, `ibisoffice`. */
      readonly id: string;
      /** The engine version, `0.8.7`. */
      readonly version: string;
      /** The formats the engine handles. */
      readonly formats: readonly OfficeFormat[];
      /** The operations the engine can actually produce. */
      readonly operations: readonly OfficeOperation[];
    }
  | {
      readonly available: false;
      /** Why the engine is not there: a missing manifest, a broken binary, an absent pack. */
      readonly reason: string;
    };

/**
 * One pack's manifest (§11).
 *
 * @remarks
 * `capabilities.operations` lists only the operations the pack can actually produce, so a caller
 * answers `unsupported_command` instead of running and failing. `license` carries the
 * AGPL-3.0-only notice the distribution must include (D102), and `files` maps each shipped file,
 * relative to the pack root, to its `sha256:<hex>`.
 *
 * The manifest is read by the machine (0235 / 0236); this type is what both sides agree a manifest
 * *is*, so a malformed one is refused at the boundary instead of halfway through a job.
 */
export interface EngineManifest {
  /** The pack's id, `ibisoffice`. */
  readonly id: string;
  /** The engine's version, `0.8.7`. */
  readonly version: string;
  readonly capabilities: {
    readonly formats: readonly OfficeFormat[];
    readonly operations: readonly OfficeOperation[];
  };
  readonly license: {
    /** The SPDX identifier; D102 ships `AGPL-3.0-only`. */
    readonly spdx: string;
    /** The notice file, relative to the pack root. */
    readonly notice: string;
    /** The corresponding-source file, relative to the pack root (AGPL section 7(b)). */
    readonly source: string;
  };
  /** Each shipped file relative to the pack root, and its `sha256:<hex>`. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * One produced file: the key it has in the cache, and what it is (§5).
 *
 * @remarks
 * The artifact is **described, not carried**: a JSON answer is bounded at 256 KiB, so the bytes
 * travel through the binary route (`GET /artifact`) and this value names them. `workspaceId`,
 * `pathHash`, `version`, and `file` are the cache key (§4); `sha256` is the hash of the bytes,
 * which the write path verifies before it renames a copy into ROOT (INV-O6).
 *
 * `missingFonts` is never absent: an empty list says "every font was found", which a person needs
 * to know before blaming the document for its look.
 */
export interface OfficeArtifact {
  /**
   * The 5-tuple the artifact lives under (§4).
   *
   * @remarks
   * This is what the server copies into a `source` write and what the machine builds the cache
   * path from. The three fields below repeat it for a reader; {@link key} is the one the paths
   * are made from.
   */
  readonly key: OfficeCacheKey;
  /** The workspace the artifact belongs to. */
  readonly workspaceId: string;
  /** SHA-256 of the workspace-relative path, first 16 hex (§4). */
  readonly pathHash: string;
  /** The input's version: a content hash, `sha256:<hex>`. */
  readonly version: string;
  /** The file name inside the cache's entry directory: `pdf` or `png` (§4). */
  readonly file: string;
  /** SHA-256 of the bytes, `sha256:<hex>`; the write path checks it before renaming (§5). */
  readonly sha256: string;
  /** Bytes in the file. */
  readonly bytes: number;
  /** Pages in the PDF; absent for a PNG. */
  readonly pages?: number | undefined;
  /** Fonts the engine substituted; empty means every font was found. */
  readonly missingFonts: readonly string[];
  /** The engine that produced it, and its version (§12). */
  readonly engine: { readonly id: string; readonly version: string };
}

/**
 * What one job cost (§5).
 *
 * @remarks
 * `cached: true` means the machine answered from the cache and ran nothing; 0239 asserts it to
 * prove that the second open of a document generates nothing.
 */
export interface OfficeStats {
  /** Wall-clock milliseconds the job took; 0 for a cache hit. */
  readonly ms: number;
  /** The peak resident set of the engine process, in MiB; 0 for a cache hit. */
  readonly peakRssMb: number;
  /** True when no engine ran: the artifact already existed for this key. */
  readonly cached: boolean;
}

/**
 * What a job answered (§5).
 *
 * @remarks
 * A success carries the artifact and the stats; a failure carries the code and a message. It does
 * **not** carry the document: the bytes go through `GET /artifact`, and a JSON answer stays under
 * the machine's 256 KiB response bound.
 */
export type OfficeResult =
  | {
      readonly ok: true;
      readonly artifact: OfficeArtifact;
      readonly stats: OfficeStats;
    }
  | {
      readonly ok: false;
      readonly error: OfficeErrorCode;
      readonly message: string;
    };

/**
 * The machine's office wire: one job in, one result out (§5).
 *
 * @remarks
 * The request is the job, wrapped so the machine's request union names the pair. `convert` caches
 * the PDF and answers where it is: writing it into the workspace is a second step, the `source`
 * variant of the existing `write` op (0241).
 */
export interface OfficeRequest {
  readonly op: "office";
  readonly job: OfficeJob;
}

/**
 * The machine's engine probe: no parameters, one report (§5).
 *
 * @remarks
 * Asking the pack is its own op because nothing else reads a pack's manifest, and the probe must
 * not take the single office slot: a probe during a running job answers the capability rather
 * than `engine_busy` (0236 C15).
 */
export interface OfficeEngineRequest {
  readonly op: "officeEngine";
}

/**
 * The route the machine serves an artifact's bytes on (§5).
 *
 * @remarks
 * The bytes are not JSON: a preview may be 50 MiB and a JSON answer is bounded at 256 KiB, so the
 * artifact travels here, in ranges.
 */
export const MACHINE_ARTIFACT_PATH = "/artifact" as const;

/**
 * The most bytes one `GET /artifact` range may ask for: 8 MiB (§5).
 *
 * @remarks
 * `Limits.maxResponseBytes` bounds a JSON answer, not this route; the artifact has its own bound,
 * and a longer `length` is `invalid_request`.
 */
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/**
 * The most entries one input may hold (§10).
 *
 * @remarks
 * A zip is a tree of entries as well as a size: a document of many tiny parts costs the engine far
 * more than its bytes suggest, so the prescan counts before anything runs. The number is generous
 * for a document (a real .docx, .xlsx or .pptx holds tens to thousands of entries; the spike's
 * heaviest held a few thousand) and is not a limit a legitimate file meets.
 */
export const MAX_OFFICE_ENTRIES = 100_000;

/**
 * The most bytes one input may expand to (§10).
 *
 * @remarks
 * The input bound (`maxInputBytes`) is what the workspace stores; this is what the engine
 * unpacks. A few MB zip that expands to gigabytes is a decompression bomb, and the engine reads
 * the expansion before any of its own bounds apply. The bound is ten times the input bound, which
 * every real document is far inside: a 50 MiB .docx of embedded images is already an outlier, and
 * Office files expand to a small multiple of their size.
 */
export const MAX_OFFICE_EXPANDED_BYTES = 512 * 1024 * 1024;

/**
 * The most pages a preview may hold when a job names no range, and no `--pages` exists on the
 * engine's command line.
 *
 * @remarks
 * The engine exports every page. A preview above {@link OFFICE_MAX_PDF_PAGES} is refused before it
 * runs; a job that names fewer pages is refused `unsupported_command` because the v0.8.7 CLI
 * cannot select pages (docs/office.md §2, §10).
 */

/** Hex characters in a cache path hash (§4). */
export const OFFICE_PATH_HASH_HEX_LENGTH = 16;

/** Hex characters in an office params hash (§4). */
export const OFFICE_PARAMS_HASH_HEX_LENGTH = 16;

/**
 * The content hash and cache key spelling: `sha256:` and 64 lowercase hex.
 *
 * @remarks
 * One pattern covers the input's version, an artifact's `sha256`, a write's `contentHash`, and a
 * manifest entry, so a value built for one is accepted by the other and nothing else is.
 */
export const OFFICE_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

/** The cache path hash spelling: 16 lowercase hex (§4). */
export const OFFICE_PATH_HASH_PATTERN = new RegExp(
  "^[0-9a-f]{" + OFFICE_PATH_HASH_HEX_LENGTH + "}$",
  "u",
);

/** The cache params hash spelling: 16 lowercase hex (§4). */
export const OFFICE_PARAMS_HASH_PATTERN = new RegExp(
  "^[0-9a-f]{" + OFFICE_PARAMS_HASH_HEX_LENGTH + "}$",
  "u",
);

/** A cell reference: column letters, then a 1-based row (`B12`). */
export const OFFICE_CELL_REF_PATTERN = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/u;

/**
 * One cache entry's file name: its extension only, because the key is the directory (§4).
 *
 * @remarks
 * The name is the content type's extension and nothing else. **The rest of the key is outside
 * it**: `<cache>/<workspaceId>/<pathHash>/<version>/<operation>-<paramsHash>/<pdf|png>`. A name
 * that also carried the version or the path would be a second spelling of the key, and two
 * spellings are two keys.
 */
export const OFFICE_ARTIFACT_FILE_PATTERN = /^(?:pdf|png)$/u;

/**
 * The operations that produce a file, and the only ones a cache key may name (§4).
 *
 * @remarks
 * `inspect` / `edit` / `recalc` produce no artifact, so they have no key and no path. The type
 * says so, not only the schema: a caller that built a key from an `inspect` would not compile,
 * where a run-time check in one function could be forgotten by the next. The list is the one
 * place the pair is written; `OFFICE_OPERATIONS` still carries all six for a job.
 */
export const OFFICE_ARTIFACT_FILE_OPERATIONS = ["preview", "render"] as const;

/** One operation that produces a file. */
export type OfficeArtifactFileOperation = (typeof OFFICE_ARTIFACT_FILE_OPERATIONS)[number];

/**
 * The whole key one artifact lives under, as the 5-tuple (§4).
 *
 * @remarks
 * `(workspaceId, pathHash, version, operation, paramsHash)` — **all five**, none optional. The
 * reason is convert: its options are only `{ to: "pdf" }`, so a key made of `operation` and
 * `paramsHash` alone would be **the same value for every file in every workspace**, and the
 * first conversion would answer for the second. The path parts are in the key and **not** in the
 * hash: the same bytes at two paths are two artifacts.
 */
export interface OfficeCacheKey {
  /** The workspace the artifact belongs to. */
  readonly workspaceId: string;
  /** SHA-256 of the workspace-relative path, first 16 hex. */
  readonly pathHash: string;
  /** The input's version: its content hash, `sha256:<hex>`. */
  readonly version: string;
  /** The operation that produced it: one of the two that make a file. */
  readonly operation: OfficeArtifactFileOperation;
  /** The hash of `{ operation, ...the operation's options }`, 16 hex ({@link officeParamsHash}). */
  readonly paramsHash: string;
}

/** The directory inside one cache entry: `<operation>-<paramsHash>` (§4). */
export function officeArtifactDirectory(
  operation: OfficeArtifactFileOperation,
  paramsHash: string,
): string {
  if (!OFFICE_PARAMS_HASH_PATTERN.test(paramsHash)) {
    throw new Error("an office params hash is 16 lowercase hex characters");
  }
  return artifactFileName(operation) + "-" + paramsHash;
}

/**
 * The file name inside one cache entry's directory: the extension (§4).
 *
 * @param operation - The operation the artifact was produced for.
 * @returns `pdf` for a preview, `png` for a render.
 *
 * @throws Error when the operation makes no artifact.
 *
 * @remarks
 * The extension is derived from the operation, never given: a preview is a PDF and a render is a
 * PNG, so the name cannot disagree with what the file is.
 */
export function officeArtifactFile(operation: OfficeArtifactFileOperation): string {
  switch (operation) {
    case "preview":
      return "pdf";
    case "render":
      return "png";
    default:
      return assertNever(operation);
  }
}

/**
 * The cache path one entry lives at, relative to the cache's root (§4).
 *
 * @param key - The 5-tuple.
 * @returns `<workspaceId>/<pathHash>/<version>/<operation>-<paramsHash>/<extension>`.
 *
 * @throws Error when a part is not the shape the key requires: this string is joined onto a
 * directory, so a `..` reaching it would escape the cache.
 *
 * @remarks
 * **The one place a key becomes a path.** The server computes the key to name an artifact; the
 * machine builds the same path to read one; the write path re-derives it to copy one into ROOT.
 * Nothing joins these parts by hand, so two lanes cannot disagree about a path that is safe.
 */
export function officeCachePath(key: OfficeCacheKey): string {
  if (key.workspaceId === "" || key.workspaceId.includes("/") || key.workspaceId.includes("..")) {
    throw new Error("a cache key's workspace id is a name, not a path");
  }
  if (!OFFICE_PATH_HASH_PATTERN.test(key.pathHash)) {
    throw new Error("a cache key's path hash is 16 lowercase hex characters");
  }
  if (!OFFICE_SHA256_PATTERN.test(key.version)) {
    throw new Error("a cache key's version is sha256:<64 hex>");
  }
  if (!OFFICE_PARAMS_HASH_PATTERN.test(key.paramsHash)) {
    throw new Error("a cache key's params hash is 16 lowercase hex characters");
  }
  return [
    key.workspaceId,
    key.pathHash,
    key.version,
    officeArtifactDirectory(key.operation, key.paramsHash),
    officeArtifactFile(key.operation),
  ].join("/");
}

/** The directory's operation part: `preview` or `render`, and no other (§4). */
function artifactFileName(operation: OfficeArtifactFileOperation): string {
  switch (operation) {
    case "preview":
      return "preview";
    case "render":
      return "render";
    default:
      return assertNever(operation);
  }
}

/**
 * The canonical JSON one cache key is hashed over (RFC 8785, JCS), and what {@link officeParamsHash}
 * refuses.
 *
 * @remarks
 * Office does not write a second JCS: `./capability/canonical.ts` already turns a value into JCS
 * text for a hash, and **two canonical forms would be two keys**. That one accepts safe integers
 * only, which is every office option (pages, widths, a page range); a value it cannot represent is
 * refused rather than hashed differently. The test compares objects written in different orders
 * and a non-integer, so the reuse is checked rather than assumed.
 *
 * This module has no `node:` import, and neither does the capability's canonical form, so the
 * Worker bundle keeps carrying the contract.
 */
// SAFETY: the canonical form is the capability module's own JCS (RFC 8785), which takes the value
// it is given and either returns its text or throws; office adds no rule of its own.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function officeCanonicalize(value: unknown): string {
  return canonicalize(value);
}

/**
 * SHA-256 of text, in lowercase hex.
 *
 * @param text - The text to digest.
 * @returns 64 lowercase hex characters.
 *
 * @remarks
 * WebCrypto only: the server (workerd) and the machine (Node) both call this, so the two sides
 * cannot hash differently. `crypto.subtle.digest` exists on both.
 */
export async function sha256Hex(text: string): Promise<string> {
  const input = new TextEncoder().encode(text);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * The cache's path hash: SHA-256 of the workspace-relative path, first 16 hex (§4).
 *
 * @param path - The path exactly as the job names it.
 * @returns 16 lowercase hex characters.
 *
 * @remarks
 * The path is hashed rather than escaped so a cache directory cannot contain a `/` or a `..`
 * taken from the input; the file name that goes on the disk is never the input's.
 */
export async function officePathHash(path: string): Promise<string> {
  const hex = await sha256Hex(path);
  return hex.slice(0, OFFICE_PATH_HASH_HEX_LENGTH);
}

/**
 * A value one operation's options are made of: pages, ranges, a width, a command or a cell.
 *
 * @remarks
 * The options are `OfficeOperationOptions`; this is the shape their leaves take when they are
 * hashed. It is named so {@link officeParamsHash} does not take an untyped dictionary.
 */
export type OfficeOptionValue =
  | string
  | number
  | boolean
  | null
  | readonly OfficeOptionValue[]
  | { readonly [key: string]: OfficeOptionValue };

/**
 * One office cache key's parameter part: the hash of the operation and its options (§4).
 *
 * @param operation - The operation the artifact was produced for.
 * @param params - The operation's options, canonicalised and hashed.
 * @returns 16 lowercase hex characters; the same key for the same operation and options.
 *
 * @remarks
 * The server and the machine both call this, so a cache lookup and a cache write cannot disagree
 * about a key: the hash is JCS plus SHA-256 of `{ operation, ...params }`, first 16 hex. An
 * absent option and an option spelled differently hashed differently would be a silent miss; the
 * canonical form is what makes two spellings one key.
 *
 * **Only what changes the artifact is hashed.** The path parts — `workspaceId`, `pathHash`,
 * `version` — are deliberately **not** inputs: they are fields of the key ({@link OfficeCacheKey})
 * beside the hash, and a hash that mixed them in would give one artifact two keys depending on
 * which side assembled it. What is hashed is the operation and the options that change what the
 * engine produces (the pages, the width, the commands), so two jobs that ask for the same thing
 * share an entry and two that do not never collide.
 *
 * A `paramsHash` for a job with no options is the hash of `{operation}` alone; that is correct
 * **only because the key carries the path parts beside it** — see {@link OfficeCacheKey} for why
 * `operation` alone is never a key.
 */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters -- the
// argument is one operation's options, whose keys the caller takes from OfficeOperationOptions; the
// canonical form is the check, and it refuses anything JSON cannot carry.
export async function officeParamsHash(
  operation: OfficeOperation,
  params: Readonly<Record<string, OfficeOptionValue>> = {},
): Promise<string> {
  const hex = await sha256Hex(officeCanonicalize({ operation, ...params }));
  return hex.slice(0, OFFICE_PARAMS_HASH_HEX_LENGTH);
}

/**
 * The content type the artifact route serves an artifact as (§5).
 *
 * @param operation - The operation the artifact was produced for.
 * @returns `application/pdf` for a preview, `image/png` for a render.
 *
 * @throws Error when the operation makes no artifact.
 */
export function officeArtifactContentType(operation: OfficeArtifactFileOperation): string {
  switch (operation) {
    case "preview":
      return "application/pdf";
    case "render":
      return "image/png";
    default:
      return assertNever(operation);
  }
}

/**
 * The artifact's query, in one spelling (§5).
 *
 * @remarks
 * The signature covers the whole request target, path **and** query, so the two sides must produce
 * the same text. The fields here are the canonical order; the server builds the query with
 * {@link artifactQuery} and the machine verifies the request target it received, byte for byte. A
 * reordered or rewritten query is a different target and is refused.
 */
export interface ArtifactTargetParams {
  readonly workspaceId: string;
  readonly path: string;
  readonly version: string;
  readonly operation: OfficeOperation;
  readonly paramsHash: string;
  readonly offset?: number | undefined;
  readonly length?: number | undefined;
}

/**
 * The canonical query for one artifact read (§5).
 *
 * @param params - The artifact's key and range.
 * @returns The pairs `workspaceId`, `path`, `version`, `operation`, `paramsHash`, and, when
 * given, `offset` and `length`, in that order, every value percent-encoded, joined by `&`.
 *
 * @throws Error when a range value is not a non-negative safe integer.
 *
 * @remarks
 * The order is fixed here and not by the caller's object order. `offset` and `length` are omitted
 * when absent; a `length` without an `offset` means "from the start".
 */
export function artifactQuery(params: ArtifactTargetParams): string {
  const pairs: [string, string][] = [
    ["workspaceId", params.workspaceId],
    ["path", params.path],
    ["version", params.version],
    ["operation", params.operation],
    ["paramsHash", params.paramsHash],
  ];
  if (params.offset !== undefined) pairs.push(["offset", encodeRange(params.offset, "offset")]);
  if (params.length !== undefined) pairs.push(["length", encodeRange(params.length, "length")]);
  const encoded: string[] = [];
  for (const [key, value] of pairs) encoded.push(key + "=" + encodeURIComponent(value));
  return encoded.join("&");
}

/**
 * The signed request target for one artifact read (§5).
 *
 * @param params - The artifact's key and range.
 * @returns {@link MACHINE_ARTIFACT_PATH} and the canonical query, `?` separating them.
 *
 * @remarks
 * The machine verifies the request target it received against this function's value, so a query
 * whose parameters were swapped is not the target that was signed. The server signs the same
 * value.
 */
export function artifactTarget(params: ArtifactTargetParams): string {
  return MACHINE_ARTIFACT_PATH + "?" + artifactQuery(params);
}

/**
 * One artifact request, parsed from the query the machine received (§5).
 *
 * @remarks
 * The machine reads the query through {@link parseArtifactQuery}, never by hand: an unknown key, a
 * repeated key, a missing key, a bad spelling, or a range above {@link MAX_ARTIFACT_BYTES} is
 * `invalid_request`, and the path's containment is checked afterwards by the one path function
 * (0236 C11).
 */
export interface ArtifactQuery extends ArtifactTargetParams {}

function encodeRange(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("an artifact " + name + " is a non-negative safe integer");
  }
  return String(value);
}

/**
 * Exhaustiveness for a closed union, reached only from a `default` branch.
 *
 * @param value - A value the compiler narrowed to `never`.
 * @returns Never; it throws.
 *
 * @throws Error when reached at run time, which means a member was added and a `switch` was not
 * updated, or a stale bundle sent a value this build does not know.
 *
 * @remarks
 * Every `switch` over a closed office union ends in `default: return assertNever(value)`, so
 * adding a member without a branch is a compile error (the argument is no longer `never`). A test
 * reaches the run-time half by adding a member to a cast copy of a value.
 */
export function assertNever(value: never): never {
  throw new Error("unhandled office member: " + JSON.stringify(value));
}

/**
 * The state a job's error code produces (§3, §9).
 *
 * @param code - The expected failure.
 * @returns `unsupported` for a format the pack does not handle, `failed` for every other code.
 *
 * @remarks
 * A format the pack cannot handle and a failure are different states in the UI (§9): the first
 * says "not this kind of file", the second "it did not work". They are not folded together.
 */
export function previewStatusOfError(code: OfficeErrorCode): "unsupported" | "failed" {
  switch (code) {
    case "unsupported_format":
      return "unsupported";
    case "unsupported_command":
    case "input_too_large":
    case "input_too_large_archive":
    case "too_many_pages":
    case "too_many_cells":
    case "too_many_pixels":
    case "engine_unavailable":
    case "engine_timeout":
    case "engine_failed":
    case "engine_busy":
    case "output_too_large":
    case "source_changed":
    case "not_authorized":
    case "cancelled":
      return "failed";
    default:
      return assertNever(code);
  }
}

/**
 * The office code a machine refusal means (§9).
 *
 * @param refusal - A code from the machine's `MACHINE_REFUSALS`.
 * @returns The office code {@link MACHINE_REFUSAL_TO_OFFICE_ERROR} maps it to, or `engine_failed`
 * for a code the table does not know.
 */
export function officeErrorOfRefusal(
  refusal: string,
  reason?: MachineRefusalReason,
): OfficeErrorCode {
  // The one refusal that is not the table's answer. `invalid_request` means "the body is not what
  // the job names", and the table maps it to `unsupported_command` for a malformed body. The
  // contract has no "not yet" code, so a `source` write before 0241 keeps `engine_unavailable` —
  // "the machine cannot do this yet" — rather than telling a person the engine cannot convert.
  if (refusal === "invalid_request" && reason === OFFICE_CACHE_UNAVAILABLE_REASON) {
    return "engine_unavailable";
  }
  if (!Object.hasOwn(MACHINE_REFUSAL_TO_OFFICE_ERROR, refusal)) return "engine_failed";
  // SAFETY: the branch above proved the key belongs to the table, whose values are office codes;
  // an unknown code (from a newer machine) never reaches the index.
  return MACHINE_REFUSAL_TO_OFFICE_ERROR[refusal as keyof typeof MACHINE_REFUSAL_TO_OFFICE_ERROR];
}

/** The schema for {@link OfficeLimits}: every bound is a positive integer (§10, C6). */
export const OfficeLimitsSchema: v.GenericSchema<unknown, OfficeLimits> = v.object({
  maxInputBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  maxCells: v.pipe(v.number(), v.integer(), v.minValue(1)),
  maxPixels: v.pipe(v.number(), v.integer(), v.minValue(1)),
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  maxOutputBytes: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/** The schema for {@link OfficeInput}: the version is a content hash (§2, C3). */
export const OfficeInputSchema: v.GenericSchema<unknown, OfficeInput> = v.object({
  workspaceId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  version: v.pipe(v.string(), v.regex(OFFICE_SHA256_PATTERN, "a version is sha256:<64 hex>")),
  format: v.picklist(OFFICE_FORMATS),
});

/** The schema for {@link OfficePageRange}: an integer page, and a range that ends where it starts. */
const OfficePageRangeSchema: v.GenericSchema<unknown, OfficePageRange> = v.pipe(
  v.object({
    from: v.pipe(v.number(), v.integer(), v.minValue(1)),
    to: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.check((range) => range.to >= range.from, "a page range ends at or after it starts"),
);

/** The schema for one page list: positive integers or ranges, and at least one of them. */
const OfficePageListSchema: v.GenericSchema<unknown, readonly (number | OfficePageRange)[]> =
  v.pipe(
    v.array(v.union([v.pipe(v.number(), v.integer(), v.minValue(1)), OfficePageRangeSchema])),
    v.minLength(1),
  );

/** The schema for {@link ParagraphTarget}. */
export const ParagraphTargetSchema: v.GenericSchema<unknown, ParagraphTarget> = v.object({
  paragraphId: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

/** The schema for {@link CellValue}: one of the three value kinds (§2). */
export const CellValueSchema: v.GenericSchema<unknown, CellValue> = v.variant("kind", [
  v.object({ kind: v.literal("text"), text: v.string() }),
  v.object({ kind: v.literal("number"), value: v.number() }),
  v.object({ kind: v.literal("formula"), formula: v.pipe(v.string(), v.minLength(1)) }),
]);

/** The schema for {@link CellEdit}: a cell reference and its value. */
export const CellEditSchema: v.GenericSchema<unknown, CellEdit> = v.object({
  ref: v.pipe(v.string(), v.regex(OFFICE_CELL_REF_PATTERN, "a cell reference is B12")),
  value: CellValueSchema,
});

/**
 * The schema for {@link OfficeCommand}: exactly the three v1 commands (§2, C1).
 *
 * @remarks
 * The union is discriminated on `op`, so an unknown command does not parse, and a command cannot
 * carry both a sheet and a slide.
 */
export const OfficeCommandSchema: v.GenericSchema<unknown, OfficeCommand> = v.variant("op", [
  // Strict, so a command that names another command's field (`setText` with a `sheet`) does not
  // parse: a command is applied, so reading it with a key dropped would edit less than it says.
  v.strictObject({
    op: v.literal("setText"),
    paragraphId: v.pipe(v.number(), v.integer(), v.minValue(1)),
    text: v.string(),
  }),
  v.strictObject({
    op: v.literal("setCells"),
    sheet: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
    cells: v.pipe(v.array(CellEditSchema), v.minLength(1)),
  }),
  v.strictObject({
    op: v.literal("setShapeText"),
    slide: v.pipe(v.number(), v.integer(), v.minValue(1)),
    // The key is the wire's (docs/office.md §2 names the shape on the slide `shape`), not a
    // structural meaning of this build's; the schema must spell the wire to parse it.
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names
    shape: v.pipe(v.number(), v.integer(), v.minValue(0)),
    text: v.string(),
  }),
]);

/**
 * The job's common fields: the version tag, the id, the input, and the limits (§2).
 *
 * @remarks
 * Each operation's schema spreads these, so a field added to the job is added once.
 */
const OfficeJobFields = {
  v: v.literal(1),
  id: OperationIdSchema,
  input: OfficeInputSchema,
  limits: OfficeLimitsSchema,
};

/**
 * The schema for {@link OfficeJob}: one operation, its own options, and nothing else (§2, C1–C3).
 *
 * @remarks
 * Each operation is its own object schema, and **the object schemas are strict**: an option an
 * operation does not take is refused rather than dropped, so `{ operation: "preview", commands:
 * [...] }` is not read as a preview that happens to carry a key nobody uses (C2).
 */
export const OfficeJobSchema: v.GenericSchema<unknown, OfficeJob> = v.variant("operation", [
  v.strictObject({
    ...OfficeJobFields,
    operation: v.literal("preview"),
    pages: v.optional(OfficePageListSchema),
  }),
  v.strictObject({
    ...OfficeJobFields,
    operation: v.literal("render"),
    pages: v.optional(OfficePageListSchema),
    width: v.optional(
      v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(OFFICE_RENDER_MAX_WIDTH)),
    ),
  }),
  v.strictObject({
    ...OfficeJobFields,
    operation: v.literal("inspect"),
  }),
  v.strictObject({
    ...OfficeJobFields,
    operation: v.literal("edit"),
    commands: v.pipe(v.array(OfficeCommandSchema), v.minLength(1)),
  }),
  v.strictObject({
    ...OfficeJobFields,
    operation: v.literal("convert"),
    to: v.literal("pdf"),
  }),
  v.strictObject({
    ...OfficeJobFields,
    operation: v.literal("recalc"),
  }),
]);

/**
 * The schema for {@link OfficeCacheKey}: the 5-tuple, each part in its own spelling (§4).
 *
 * @remarks
 * `operation` is one of the two that make a file; `inspect`, `edit`, and `recalc` produce no
 * artifact and therefore have no key. All five fields are required, so a key that dropped the
 * path parts (the convert bug) does not parse.
 */
export const OfficeCacheKeySchema: v.GenericSchema<unknown, OfficeCacheKey> = v.object({
  workspaceId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  pathHash: v.pipe(v.string(), v.regex(OFFICE_PATH_HASH_PATTERN, "a path hash is 16 hex")),
  version: v.pipe(v.string(), v.regex(OFFICE_SHA256_PATTERN, "a version is sha256:<64 hex>")),
  operation: v.picklist(OFFICE_ARTIFACT_FILE_OPERATIONS),
  paramsHash: v.pipe(v.string(), v.regex(OFFICE_PARAMS_HASH_PATTERN, "a params hash is 16 hex")),
});

/**
 * The schema for {@link OfficeArtifact} (§5).
 *
 * @remarks
 * `missingFonts` is required, and a page count is at least {@link OFFICE_MIN_PAGES}: a zero-page
 * PDF is a failed conversion, not a success with no pages.
 */
export const OfficeArtifactSchema: v.GenericSchema<unknown, OfficeArtifact> = v.object({
  key: OfficeCacheKeySchema,
  workspaceId: v.pipe(v.string(), v.minLength(1)),
  pathHash: v.pipe(v.string(), v.regex(OFFICE_PATH_HASH_PATTERN, "a path hash is 16 hex")),
  version: v.pipe(v.string(), v.regex(OFFICE_SHA256_PATTERN, "a version is sha256:<64 hex>")),
  file: v.pipe(v.string(), v.regex(OFFICE_ARTIFACT_FILE_PATTERN, "an artifact file is pdf or png")),
  sha256: v.pipe(v.string(), v.regex(OFFICE_SHA256_PATTERN, "a sha256 is sha256:<64 hex>")),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  pages: v.optional(v.pipe(v.number(), v.integer(), v.minValue(OFFICE_MIN_PAGES))),
  missingFonts: v.array(v.string()),
  engine: v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    version: v.pipe(v.string(), v.minLength(1)),
  }),
});

/** The schema for {@link OfficeStats}. */
export const OfficeStatsSchema: v.GenericSchema<unknown, OfficeStats> = v.object({
  ms: v.pipe(v.number(), v.integer(), v.minValue(0)),
  peakRssMb: v.pipe(v.number(), v.minValue(0)),
  cached: v.boolean(),
});

/**
 * The schema for {@link OfficeResult} (§5, C1).
 *
 * @remarks
 * The failure's `error` is the closed code list, so an answer naming a code the contract does not
 * carry is refused at the boundary instead of reaching a row.
 */
export const OfficeResultSchema: v.GenericSchema<unknown, OfficeResult> = v.variant("ok", [
  v.object({ ok: v.literal(true), artifact: OfficeArtifactSchema, stats: OfficeStatsSchema }),
  v.object({
    ok: v.literal(false),
    error: v.picklist(OFFICE_ERROR_CODES),
    message: v.pipe(v.string(), v.minLength(1)),
  }),
]);

/** The schema for {@link OfficeEngineReport} (§5, §11). */
export const OfficeEngineReportSchema: v.GenericSchema<unknown, OfficeEngineReport> = v.variant(
  "available",
  [
    v.object({
      available: v.literal(true),
      id: v.pipe(v.string(), v.minLength(1)),
      version: v.pipe(v.string(), v.minLength(1)),
      formats: v.array(v.picklist(OFFICE_FORMATS)),
      operations: v.array(v.picklist(OFFICE_OPERATIONS)),
    }),
    v.object({
      available: v.literal(false),
      reason: v.pipe(v.string(), v.minLength(1)),
    }),
  ],
);

/** The schema for one manifest entry's digest: `sha256:<hex>` (§11). */
export const OfficeFileDigestSchema: v.GenericSchema<unknown, string> = v.pipe(
  v.string(),
  v.regex(OFFICE_SHA256_PATTERN, "a file digest is sha256:<64 hex>"),
);

/**
 * The schema for {@link EngineManifest} (§11).
 *
 * @remarks
 * `capabilities` and `license` are required: a manifest that names no operation or no notice is
 * not a pack this build may run. `files` must name at least the binary. The schema checks the
 * shape; whether the digests match the files on disk is the machine's check when it loads the
 * pack (0235 / 0236).
 */
export const EngineManifestSchema: v.GenericSchema<unknown, EngineManifest> = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  version: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  capabilities: v.object({
    formats: v.pipe(v.array(v.picklist(OFFICE_FORMATS)), v.minLength(1)),
    operations: v.pipe(v.array(v.picklist(OFFICE_OPERATIONS)), v.minLength(1)),
  }),
  license: v.object({
    spdx: v.pipe(v.string(), v.minLength(1)),
    notice: v.pipe(v.string(), v.minLength(1)),
    source: v.pipe(v.string(), v.minLength(1)),
  }),
  files: v.record(v.string(), OfficeFileDigestSchema),
});

/** The schema for {@link OfficeRequest}: the machine's `op: "office"` body (§5). */
export const OfficeRequestSchema: v.GenericSchema<unknown, OfficeRequest> = v.strictObject({
  op: v.literal("office"),
  job: OfficeJobSchema,
});

/**
 * One `GET /artifact` answer, as the machine gives it (§5).
 *
 * @remarks
 * The bytes are not part of the JSON surface: this is the metadata both sides agree on for the
 * range the machine answered. `contentRange` is the `Content-Range: bytes from-to/total` value, so
 * a reader that asked for a range can place the bytes without a second request.
 */
export interface ArtifactAnswer {
  /** Bytes in this answer. */
  readonly length: number;
  /** The whole artifact's size, in bytes. */
  readonly total: number;
  /** The first byte this answer carries, 0-based. */
  readonly offset: number;
  /** The artifact's own content type: `application/pdf` or `image/png`. */
  readonly contentType: string;
  /** `bytes <from>-<to>/<total>`. */
  readonly contentRange: string;
}

/** The schema for {@link OfficeEngineRequest}: the machine's `op: "officeEngine"` body (§5). */
export const OfficeEngineRequestSchema: v.GenericSchema<unknown, OfficeEngineRequest> =
  v.strictObject({
    op: v.literal("officeEngine"),
  });

/** The keys an artifact read's query may name, and no others (§5). */
const ARTIFACT_QUERY_KEYS: ReadonlySet<string> = new Set([
  "workspaceId",
  "path",
  "version",
  "operation",
  "paramsHash",
  "offset",
  "length",
]);

/**
 * Parse one artifact read's query, taken key by key (§5).
 *
 * @param entries - The decoded query pairs, as they appeared.
 * @returns The artifact's key and range.
 * @throws {v.ValiError} When a key is missing, repeated, or outside its rule.
 * @throws Error when a query key repeats, or a range is not a non-negative integer.
 *
 * @remarks
 * `artifactTarget` is the only canonical spelling; this function parses the pairs back. The machine
 * compares the received target with `artifactTarget(parseArtifactQuery(...))`, so a query that is
 * valid but spelled differently (another order, another encoding) is refused against the target
 * that was signed.
 */
export function parseArtifactQuery(entries: readonly (readonly [string, string])[]): ArtifactQuery {
  const single: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key in single) throw new Error("the artifact query repeats " + key);
    if (!ARTIFACT_QUERY_KEYS.has(key)) throw new Error("the artifact query has no key " + key);
    single[key] = value;
  }
  const required = (key: string): string => {
    const value = single[key];
    if (value === undefined) throw new Error("the artifact query has no " + key);
    return value;
  };
  const range = (key: string): number | undefined => {
    const text = single[key];
    if (text === undefined) return undefined;
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("the artifact query's " + key + " is a non-negative integer");
    }
    return value;
  };
  const offset = range("offset");
  const length = range("length");
  if (length !== undefined && length > MAX_ARTIFACT_BYTES) {
    throw new Error(
      "the artifact query asks for more than " + String(MAX_ARTIFACT_BYTES) + " bytes",
    );
  }
  // The five key parts are always present; the range is added only when the query named it, so an
  // absent `length` stays absent rather than becoming 0 (a zero-length read is not "the whole").
  const query = {
    workspaceId: required("workspaceId"),
    path: required("path"),
    version: required("version"),
    operation: required("operation"),
    paramsHash: required("paramsHash"),
    offset,
    length,
  };
  return v.parse(ArtifactQuerySchema, query);
}

/** The schema for one artifact read's query: the key's parts and an optional range (§5). */
const ArtifactQuerySchema: v.GenericSchema<unknown, ArtifactQuery> = v.object({
  workspaceId: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  version: v.pipe(v.string(), v.regex(OFFICE_SHA256_PATTERN, "a version is sha256:<64 hex>")),
  operation: v.picklist(OFFICE_OPERATIONS),
  paramsHash: v.pipe(v.string(), v.regex(OFFICE_PARAMS_HASH_PATTERN, "a params hash is 16 hex")),
  offset: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  length: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_ARTIFACT_BYTES)),
  ),
});

/** The names of the routes the office contract owns; the machine serves them, the server signs them. */
export const OFFICE_MACHINE_PATHS = [MACHINE_ARTIFACT_PATH] as const satisfies readonly string[];
