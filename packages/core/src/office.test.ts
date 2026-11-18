/* oxlint-disable anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion,
   anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening,
   anti-slop/no-chained-type-assertions --
   This file's subject is the boundary itself: it reads hand-written JSON (whose types are the point
   of the test, so they are `unknown` until a schema parses them) and asserts about keys the schema
   is supposed to reject. The casts below narrow a fixture to look at one field and put it back, so
   a value that must be refused can be built; the schemas, not the casts, are what decides. */
import { readFileSync } from "node:fs";
import { versionOf } from "@hns/workspace";
import * as v from "valibot";
import { describe, expect, expectTypeOf, test } from "vitest";
import { OperationIdSchema } from "./codecs.ts";
import { MACHINE_REFUSALS, MachineWriteRequestSchema } from "./machine.ts";
import type { MachineWriteRequest, MachineWriteResult } from "./machine.ts";
import {
  DEFAULT_OFFICE_LIMITS,
  MACHINE_ARTIFACT_PATH,
  MACHINE_REFUSAL_TO_OFFICE_ERROR,
  MAX_ARTIFACT_BYTES,
  OFFICE_CACHE_UNAVAILABLE_REASON,
  OFFICE_ERROR_CODES,
  OFFICE_PARAMS_HASH_PATTERN,
  OFFICE_PATH_HASH_PATTERN,
  OFFICE_SHA256_PATTERN,
  OfficeArtifactSchema,
  OfficeCacheKeySchema,
  OfficeCommandSchema,
  OfficeEngineReportSchema,
  OfficeEngineRequestSchema,
  OfficeInputSchema,
  OfficeJobSchema,
  OfficeLimitsSchema,
  OfficeRequestSchema,
  OfficeResultSchema,
  PREVIEW_STATUSES,
  artifactQuery,
  artifactTarget,
  assertNever,
  officeArtifactContentType,
  officeArtifactDirectory,
  officeArtifactFile,
  officeCachePath,
  officeCanonicalize,
  officeErrorOfRefusal,
  isPreviewTerminal,
  officeAuditDetail,
  officeFormatOfPath,
  officeParamsHash,
  officePathHash,
  parseArtifactQuery,
  parsePreviewQuery,
  PREVIEW_TERMINAL_STATUSES,
  previewStatusOfError,
  requestPreviewStatus,
  sha256Hex,
} from "./office.ts";
import type {
  ArtifactTargetParams,
  CellEdit,
  OfficeArtifactFileOperation,
  OfficeCacheKey,
  OfficeArtifact,
  OfficeCommand,
  OfficeErrorCode,
  OfficeJob,
  OfficeLimits,
  OfficeOperation,
  OfficeResult,
  PreviewStatus,
} from "./office.ts";

/**
 * The fixtures are **hand-written JSON**, not values TypeScript built from the types: a fixture
 * written from a type can only agree with the type, so it would catch nothing. These files hold
 * what a lane sends and what another lane must read back; the schemas are the check between them.
 */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL("../test/fixtures/office/" + name, import.meta.url), "utf8"));

/** The fixture names, spelled here so a missing or renamed file is a failure, not a skip. */
const GOLDEN_JOBS = ["job-preview.json", "job-render.json", "job-convert.json"] as const;
const GOLDEN_RESULTS = [
  "result-preview.json",
  "result-render.json",
  "result-convert.json",
  "result-office-engine.json",
] as const;
const GOLDEN_ERRORS = [
  "error-unsupported-format.json",
  "error-engine-timeout.json",
  "error-source-changed.json",
] as const;
/** The six refusals the issue fixes: five jobs and one result, each refused by its own schema. */
const GOLDEN_JOB_REJECTIONS = [
  "reject-job-unknown-operation.json",
  "reject-job-mixed-preview-commands.json",
  "reject-input-bad-version.json",
  "reject-job-zero-limit.json",
  "reject-input-no-workspace.json",
] as const;
const GOLDEN_RESULT_REJECTIONS = ["reject-result-unknown-error.json"] as const;
const GOLDEN_COMMANDS = [
  "command-set-text.json",
  "command-set-cells.json",
  "command-set-shape-text.json",
  "cell-edit.json",
] as const;
const GOLDEN_WRITES = ["write-source.json", "write-content.json"] as const;
const GOLDEN_WRITE_REJECTIONS = ["reject-write-both.json"] as const;
/** The two keys B1 fixes: the same job at another path, and the same path with other options. */
const GOLDEN_KEYS = ["key-convert-other-path.json", "key-convert-other-params.json"] as const;

/** Every fixture this file reads, so the count the issue fixes is asserted once. */
const GOLDEN_FILES = [
  ...GOLDEN_JOBS,
  ...GOLDEN_RESULTS,
  ...GOLDEN_ERRORS,
  ...GOLDEN_JOB_REJECTIONS,
  ...GOLDEN_RESULT_REJECTIONS,
  ...GOLDEN_COMMANDS,
  ...GOLDEN_WRITES,
  ...GOLDEN_WRITE_REJECTIONS,
  ...GOLDEN_KEYS,
] as const;

// Catches: a fixture that drifted from the schema, or a schema that drifted from a fixture.
// Table-driven over every file, so the twelve names the issue fixes are all read.
test("the golden fixtures parse exactly what the schemas produce", () => {
  for (const name of GOLDEN_JOBS) {
    const raw = fixture(name);
    expect(v.parse(OfficeJobSchema, raw), name).toStrictEqual(raw);
  }
  for (const name of GOLDEN_RESULTS.slice(0, 3)) {
    const raw = fixture(name);
    expect(v.parse(OfficeResultSchema, raw), name).toStrictEqual(raw);
  }
  const engine = fixture("result-office-engine.json");
  expect(v.parse(OfficeEngineReportSchema, engine)).toStrictEqual(engine);
  for (const name of GOLDEN_ERRORS) {
    const raw = fixture(name);
    expect(v.parse(OfficeResultSchema, raw), name).toStrictEqual(raw);
  }
  for (const name of GOLDEN_COMMANDS.slice(0, 3)) {
    const raw = fixture(name);
    expect(v.parse(OfficeCommandSchema, raw), name).toStrictEqual(raw);
  }
  const edit = fixture("cell-edit.json");
  expect(
    v.parse(OfficeCommandSchema, { op: "setCells", sheet: "売上", cells: [edit] }),
  ).toStrictEqual({
    op: "setCells",
    sheet: "売上",
    cells: [edit],
  });
  for (const name of GOLDEN_WRITES) {
    const raw = fixture(name);
    expect(v.parse(MachineWriteRequestSchema, raw), name).toStrictEqual(raw);
  }
});

// Catches: a schema that accepts a job nobody may send, which would store a row the machine
// cannot run. C4's rejection half: every refusal fixture is refused, and by its own schema.
test("the refusal fixtures are refused by the schema that reads them", () => {
  for (const name of GOLDEN_JOB_REJECTIONS) {
    expect(v.safeParse(OfficeJobSchema, fixture(name)).success, name).toBe(false);
  }
  for (const name of GOLDEN_RESULT_REJECTIONS) {
    expect(v.safeParse(OfficeResultSchema, fixture(name)).success, name).toBe(false);
  }
  for (const name of GOLDEN_WRITE_REJECTIONS) {
    expect(v.safeParse(MachineWriteRequestSchema, fixture(name)).success, name).toBe(false);
  }
});

// Catches: a fixture silently disappearing with a passing suite. The issue names 12 golden files
// (6 that parse and 6 that are refused) plus the command, cell-edit, and write fixtures; this is
// the one place that count is written down.
test("the golden fixtures are the files this issue fixed, and every one is read", () => {
  // 25 files: 16 that a schema accepts (job 3, result 3, error 3, command/cell 4, write 2), 7 that
  // it refuses, and B1's 2 keys (the key tests' own fixtures).
  expect(GOLDEN_FILES).toHaveLength(25);
  expect(GOLDEN_JOBS.length + GOLDEN_RESULTS.length + GOLDEN_ERRORS.length).toBe(10);
  expect(GOLDEN_JOB_REJECTIONS.length + GOLDEN_RESULT_REJECTIONS.length).toBe(6);
  for (const name of GOLDEN_FILES) expect(fixture(name), name).toBeDefined();
});

// Catches: C1 — a job that names an operation the vocabulary does not carry being read as some
// other operation (a typo turned into a preview), or a result whose code the row cannot hold.
test("C1: an unknown operation or an unknown error code is refused", () => {
  const job = fixture("job-preview.json");
  expect(v.safeParse(OfficeJobSchema, job).success).toBe(true);
  expect(v.safeParse(OfficeJobSchema, { ...(job as object), operation: "transcode" }).success).toBe(
    false,
  );
  expect(v.safeParse(OfficeJobSchema, { ...(job as object), operation: "PREVIEW" }).success).toBe(
    false,
  );
  for (const code of OFFICE_ERROR_CODES) {
    expect(v.safeParse(OfficeResultSchema, { ok: false, error: code, message: "m" }).success).toBe(
      true,
    );
  }
  for (const bogus of ["engine_exploded", "ENGINE_FAILED", "unsupported"]) {
    expect(v.safeParse(OfficeResultSchema, { ok: false, error: bogus, message: "m" }).success).toBe(
      false,
    );
  }
});

// Catches: C2 — a mixed request read as a preview with the commands dropped, so the server
// believes a preview was queued while the edit the caller asked for was never named.
test("C2: an option on an operation that does not take it is refused", () => {
  // SAFETY: the fixture has been parsed by OfficeJobSchema above; this only re-reads one key to
  // change it, and the changed value is what the schema must refuse.
  const job = fixture("job-preview.json") as Record<string, unknown>;
  const commands = [{ op: "setText", paragraphId: 1, text: "hello" }];
  expect(v.safeParse(OfficeJobSchema, { ...job, commands }).success).toBe(false);
  expect(v.safeParse(OfficeJobSchema, { ...job, to: "pdf" }).success).toBe(false);
  expect(v.safeParse(OfficeJobSchema, { ...job, width: 800 }).success).toBe(false);
  // The operation that takes them still does, without the preview's own pages.
  const preview = { ...job };
  delete preview.pages;
  expect(v.safeParse(OfficeJobSchema, { ...preview, operation: "edit", commands }).success).toBe(
    true,
  );
  expect(
    v.safeParse(OfficeJobSchema, { ...preview, operation: "convert", to: "pdf" }).success,
  ).toBe(true);
  // An edit with no command is not an edit.
  expect(v.safeParse(OfficeJobSchema, { ...job, operation: "edit", commands: [] }).success).toBe(
    false,
  );
});

// Catches: C3 — a version that is not a content hash (so two different bytes could share a cache
// key), or an input with no workspace (so a path resolves against whichever ROOT answered).
test("C3: the version is sha256:<hex> and the workspace id is required", () => {
  const input = { workspaceId: "ws-1", path: "a.docx", format: "docx" };
  const version = "sha256:" + "0".repeat(64);
  expect(v.safeParse(OfficeInputSchema, { ...input, version }).success).toBe(true);
  for (const broken of [
    "sha256:" + "A".repeat(64),
    "sha256:" + "0".repeat(63),
    "sha256:" + "0".repeat(65),
    "sha1:" + "0".repeat(64),
    "0".repeat(64),
    version.slice(0, -1),
    "",
  ]) {
    expect(v.safeParse(OfficeInputSchema, { ...input, version: broken }).success, broken).toBe(
      false,
    );
  }
  expect(v.safeParse(OfficeInputSchema, { path: "a.docx", version, format: "docx" }).success).toBe(
    false,
  );
  expect(v.safeParse(OfficeInputSchema, { ...input, workspaceId: "", version }).success).toBe(
    false,
  );
  expect(v.safeParse(OfficeInputSchema, { ...input, version, format: "odt" }).success).toBe(false);
});

// Catches: C6 — a bound of 0 or below read as "no limit", so a job could be sent that disables the
// check it names (INV-O5: refuse, never truncate).
test("C6: every office limit is a positive integer", () => {
  expect(v.safeParse(OfficeLimitsSchema, DEFAULT_OFFICE_LIMITS).success).toBe(true);
  for (const key of Object.keys(DEFAULT_OFFICE_LIMITS) as (keyof OfficeLimits)[]) {
    for (const bad of [0, -1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const limits = { ...DEFAULT_OFFICE_LIMITS, [key]: bad };
      expect(v.safeParse(OfficeLimitsSchema, limits).success, key + "=" + String(bad)).toBe(false);
    }
  }
  // SAFETY: a copy of the defaults, one key removed; the schema is what must notice the gap.
  const missing = { ...DEFAULT_OFFICE_LIMITS } as Record<string, unknown>;
  delete missing.maxOutputBytes;
  expect(v.safeParse(OfficeLimitsSchema, missing).success).toBe(false);
});

// Catches: a default that drifted from §10, or one changed in one place only: the defaults are
// the contract's, and the job carries the resolved values rather than the machine defaulting.
test("the defaults are §10's numbers, and they travel in the job", () => {
  expect(DEFAULT_OFFICE_LIMITS).toStrictEqual({
    maxInputBytes: 50 * 1024 * 1024,
    maxCells: 300_000,
    maxPixels: 24_000_000,
    timeoutMs: 60_000,
    maxOutputBytes: 100 * 1024 * 1024,
  });
  const job = v.parse(OfficeJobSchema, fixture("job-preview.json"));
  expect(job.limits).toStrictEqual(DEFAULT_OFFICE_LIMITS);
});

// Catches: a page bound that lets a preview claim a zero-page PDF, or a range read backwards; a
// missing font list dropped so "every font was found" and "not reported" look the same.
test("an artifact names its bytes and its hash, and never a zero-page PDF", () => {
  // SAFETY: the file is the golden preview result; the cast only reaches the artifact's keys to
  // break them one at a time.
  const artifact = fixture("result-preview.json") as { artifact: Record<string, unknown> };
  expect(v.safeParse(OfficeArtifactSchema, artifact.artifact).success).toBe(true);
  expect(artifact.artifact.sha256).toMatch(OFFICE_SHA256_PATTERN);
  for (const broken of [
    { ...artifact.artifact, pages: 0 },
    { ...artifact.artifact, sha256: "sha256:short" },
    { ...artifact.artifact, file: "preview.pdf" },
    { ...artifact.artifact, file: "preview-" + "a".repeat(16) + ".exe" },
    { ...artifact.artifact, pathHash: ".." },
    { ...artifact.artifact, version: "v1" },
  ]) {
    expect(v.safeParse(OfficeArtifactSchema, broken).success).toBe(false);
  }
  // SAFETY: a copy of the parsed artifact, one key removed; the schema is what must notice.
  const withoutFonts = { ...artifact.artifact } as Record<string, unknown>;
  delete withoutFonts.missingFonts;
  expect(v.safeParse(OfficeArtifactSchema, withoutFonts).success).toBe(false);
});

// Catches: a page range read backwards, which would render from a later page to an earlier one.
test("a page range ends at or after it starts", () => {
  // SAFETY: the fixture has been parsed by OfficeJobSchema above; this only re-reads one key to
  // change it, and the changed value is what the schema must refuse.
  const job = fixture("job-preview.json") as Record<string, unknown>;
  expect(v.safeParse(OfficeJobSchema, { ...job, pages: [{ from: 5, to: 5 }] }).success).toBe(true);
  expect(v.safeParse(OfficeJobSchema, { ...job, pages: [{ from: 5, to: 3 }] }).success).toBe(false);
  expect(v.safeParse(OfficeJobSchema, { ...job, pages: [] }).success).toBe(false);
  expect(v.safeParse(OfficeJobSchema, { ...job, pages: [0] }).success).toBe(false);
});

// Catches: C5 — a schema and a type that drifted apart. Every schema is a
// v.GenericSchema<unknown, T>, so the assignment is the compile-time half; this test holds the
// other direction, that a value of the type is what the schema produces.
test("C5: each schema's output type is its type", () => {
  expectTypeOf<v.InferOutput<typeof OfficeJobSchema>>().toEqualTypeOf<OfficeJob>();
  expectTypeOf<v.InferOutput<typeof OfficeResultSchema>>().toEqualTypeOf<OfficeResult>();
  expectTypeOf<v.InferOutput<typeof OfficeArtifactSchema>>().toEqualTypeOf<OfficeArtifact>();
  expectTypeOf<v.InferOutput<typeof OfficeLimitsSchema>>().toEqualTypeOf<OfficeLimits>();
  expectTypeOf<v.InferOutput<typeof OfficeCommandSchema>>().toEqualTypeOf<OfficeCommand>();
  expectTypeOf<v.InferOutput<typeof OfficeCommandSchema>>().toEqualTypeOf<OfficeCommand>();
  expectTypeOf<
    v.InferOutput<typeof MachineWriteRequestSchema>
  >().toEqualTypeOf<MachineWriteRequest>();
  const job: OfficeJob = v.parse(OfficeJobSchema, fixture("job-preview.json"));
  expect(job.operation).toBe("preview");
});

// Catches: an edit command with no vocabulary (a shape the machine would guess at), or a shape
// that names both a sheet and a slide.
test("an edit command is one of the three, and a cell edit is a ref and a value", () => {
  for (const name of GOLDEN_COMMANDS.slice(0, 3)) {
    expect(v.safeParse(OfficeCommandSchema, fixture(name)).success, name).toBe(true);
  }
  const cell: CellEdit = { ref: "B12", value: { kind: "number", value: 1 } };
  expect(
    v.safeParse(OfficeCommandSchema, { op: "setCells", sheet: "s", cells: [cell] }).success,
  ).toBe(true);
  for (const broken of [
    { op: "appendParagraph", text: "x" },
    { op: "setCells", sheet: "s", cells: [] },
    { op: "setCells", sheet: "s", cells: [{ ref: "12B", value: { kind: "text", text: "x" } }] },
    { op: "setCells", sheet: "s", cells: [{ ref: "B12", value: { kind: "date", value: 1 } }] },
    { op: "setText", paragraphId: 1, text: "x", sheet: "s" },
  ]) {
    expect(v.safeParse(OfficeCommandSchema, broken).success, JSON.stringify(broken)).toBe(false);
  }
});

// Catches: T4 — a switch over a closed union that stops compiling when a member is added but
// silently falls through at run time when a stale value arrives. Both halves:
describe("a switch over a closed union ends in never", () => {
  // Catches: a switch that returns a default for a code it does not name, so a new error code
  // would be reported as "it did not work" instead of being placed on purpose.
  test("every error code has a state, and only unsupported_format is unsupported", () => {
    for (const code of OFFICE_ERROR_CODES) {
      const status: PreviewStatus = previewStatusOfError(code);
      expect(status, code).toBe(code === "unsupported_format" ? "unsupported" : "failed");
    }
    const states: readonly PreviewStatus[] = PREVIEW_STATUSES;
    expect(states).toContain(previewStatusOfError("unsupported_format"));
  });

  // Catches: C1's other half — a code from a newer server reaching the switch's default, which
  // must throw rather than be rounded to some state.
  test("a code the switch does not name throws rather than answering", () => {
    expect(() => previewStatusOfError("engine_exploded" as OfficeErrorCode)).toThrow(
      /unhandled office member/u,
    );
    expect(() => previewStatusOfError(undefined as unknown as OfficeErrorCode)).toThrow();
    expect(() => assertNever("transcode" as never)).toThrow(/unhandled office member/u);
  });

  // Catches: a cache file name built from the request rather than derived, so a preview could be
  // named .exe; and an operation that makes no artifact being given one. **The last is a type
  // obligation, not a run-time throw** (N4): `inspect` / `edit` / `convert` / `recalc` are not
  // `OfficeArtifactFileOperation`, so a key or a path built from one does not compile.
  test("the cache file name is derived from the operation, never given", () => {
    const hash = "a1b2c3d4e5f60718";
    expect(officeArtifactFile("preview")).toBe("pdf");
    expect(officeArtifactFile("render")).toBe("png");
    expect(officeArtifactDirectory("preview", hash)).toBe("preview-" + hash);
    expect(officeArtifactDirectory("render", hash)).toBe("render-" + hash);
    expect(officeArtifactContentType("preview")).toBe("application/pdf");
    expect(officeArtifactContentType("render")).toBe("image/png");
    expectTypeOf<OfficeArtifactFileOperation>().toEqualTypeOf<"preview" | "render">();
    expectTypeOf<OfficeCacheKey["operation"]>().toEqualTypeOf<OfficeArtifactFileOperation>();
    // @ts-expect-error -- a conversion makes no cache entry, so its key does not type-check.
    const fromConvert: OfficeCacheKey["operation"] = "convert";
    expect(fromConvert).toBe("convert");
    expect(() => officeArtifactDirectory("preview", "not-hex")).toThrow();
    expect(() => officeArtifactDirectory("preview", hash.toUpperCase())).toThrow();
  });

  // Catches: a refusal the machine may answer with and the table does not name, so the server's
  // row would store a code nobody decided on.
  test("every machine refusal maps to an office code", () => {
    const mapped = Object.keys(MACHINE_REFUSAL_TO_OFFICE_ERROR);
    expect(mapped.slice().sort()).toStrictEqual(MACHINE_REFUSALS.slice().sort());
    for (const refusal of MACHINE_REFUSALS) {
      const code = MACHINE_REFUSAL_TO_OFFICE_ERROR[refusal];
      expect(OFFICE_ERROR_CODES, refusal).toContain(code);
      expect(officeErrorOfRefusal(refusal)).toBe(code);
    }
    expect(officeErrorOfRefusal("busy")).toBe("engine_busy");
    expect(officeErrorOfRefusal("path_denied")).toBe("not_authorized");
    expect(officeErrorOfRefusal("invalid_request")).toBe("unsupported_command");
    // N3: the one refusal that is not "outside the vocabulary". The machine refuses a `source`
    // write until the cache and the copy exist (0241); an `unsupported_command` row would tell a
    // person the engine cannot do it, which is a different, false story.
    expect(officeErrorOfRefusal("invalid_request", OFFICE_CACHE_UNAVAILABLE_REASON)).toBe(
      "engine_unavailable",
    );
    expect(officeErrorOfRefusal("engine_exploded")).toBe("engine_failed");
  });
});

// **B1.** The key is a 5-tuple, not "operation + params": convert's options are only
// `{ to: "pdf" }`, so a shorter key would be one constant and every conversion in every
// workspace would answer with the first one's PDF. These two tests are the two ways that bug
// shows: another path and another option.
describe("the cache key is (workspaceId, pathHash, version, operation, paramsHash)", () => {
  // Catches: a key that dropped the path parts, so two files sharing a version share an entry.
  // **The two values differ in `pathHash` and nothing else**: the same 5-tuple is built from the
  // one fixture, once with each path, so a path builder that reads the other four fields and
  // ignores `pathHash` gives two equal paths and fails here (the earlier version compared two
  // whole fixture keys whose other fields could also differ, and stayed green with the hash
  // dropped).
  test("the same job, version, and operation at another path is another key", async () => {
    const other = fixture("key-convert-other-path.json");
    const key = v.parse(OfficeCacheKeySchema, (other as { key: object }).key);
    const base = v.parse(
      OfficeCacheKeySchema,
      (fixture("result-convert.json") as { artifact: { key: object } }).artifact.key,
    );
    expect(key.workspaceId).toBe(base.workspaceId);
    expect(key.version).toBe(base.version);
    expect(key.operation).toBe(base.operation);
    expect(key.paramsHash).toBe(base.paramsHash);
    expect(key.pathHash).not.toBe(base.pathHash);
    // One tuple, two paths: the path is the only difference the two cache paths can see.
    const atOtherPath = officeCachePath({ ...key, pathHash: key.pathHash });
    const atBasePath = officeCachePath({ ...key, pathHash: base.pathHash });
    expect(atOtherPath).not.toBe(atBasePath);
    expect(atOtherPath).toContain("/" + key.pathHash + "/");
    expect(atBasePath).toContain("/" + base.pathHash + "/");
    // The params hash is the same for both: the path is outside the hash by design, and inside
    // the key. A key made of the hash alone would be one entry.
    expect(await officeParamsHash("preview", { to: "pdf" })).toBe(
      await officeParamsHash("preview", { to: "pdf" }),
    );
  });

  // Catches: a key that dropped the options, so two previews of different pages share an entry.
  test("the same job at the same path with other options is another key", () => {
    const other = fixture("key-convert-other-params.json");
    const key = v.parse(OfficeCacheKeySchema, (other as { key: object }).key);
    const base = v.parse(
      OfficeCacheKeySchema,
      (fixture("result-convert.json") as { artifact: { key: object } }).artifact.key,
    );
    expect(key.pathHash).toBe(base.pathHash);
    expect(key.version).toBe(base.version);
    expect(key.paramsHash).not.toBe(base.paramsHash);
    expect(officeCachePath(key)).not.toBe(officeCachePath(base));
  });

  // Catches: convert's key being a constant. With no path parts a convert and another convert are
  // indistinguishable; this pins that the fields that make them different are required.
  test("a key without any one of the five parts does not parse", () => {
    const key = (fixture("result-convert.json") as { artifact: { key: object } }).artifact.key;
    expect(v.safeParse(OfficeCacheKeySchema, key).success).toBe(true);
    for (const part of ["workspaceId", "pathHash", "version", "operation", "paramsHash"]) {
      const without = { ...key } as Record<string, unknown>;
      delete without[part];
      expect(v.safeParse(OfficeCacheKeySchema, without).success, part).toBe(false);
    }
    expect(officeCachePath(v.parse(OfficeCacheKeySchema, key))).toContain("/preview-");
    expect(() =>
      officeCachePath(v.parse(OfficeCacheKeySchema, { ...key, paramsHash: "a1b2c3d4e5f6071" })),
    ).toThrow();
    // A workspace id is a name; a path segment would escape the cache directory.
    expect(() =>
      officeCachePath({ ...v.parse(OfficeCacheKeySchema, key), workspaceId: ".." }),
    ).toThrow();
    expect(() =>
      officeCachePath({ ...v.parse(OfficeCacheKeySchema, key), workspaceId: "a/b" }),
    ).toThrow();
  });
});

// Catches: the two sides of the cache key hashing differently — the server building a query with
// one order and the machine verifying another, which would refuse every artifact as a 401.
describe("the cache key and the artifact target are one function each", () => {
  test("the params hash is 16 hex and ignores key order", async () => {
    const first = await officeParamsHash("preview", { pages: [1, 2], width: 800 });
    const second = await officeParamsHash("preview", { width: 800, pages: [1, 2] });
    expect(first).toMatch(OFFICE_PARAMS_HASH_PATTERN);
    expect(second).toBe(first);
    expect(await officeParamsHash("render", { pages: [1, 2], width: 800 })).not.toBe(first);
    expect(await officeParamsHash("preview", { pages: [2, 1], width: 800 })).not.toBe(first);
  });

  // Catches: **the hash taking a different input than the contract says** — the path parts mixed
  // in (so one artifact gets two keys depending on which side built it), an option dropped, or a
  // second canonical form. The expected value is written by hand from the rule — JCS of
  // { operation, ...options }, SHA-256, first 16 hex — not by calling the function under test.
  test("the params hash is the sha256 of JCS { operation, ...options }, first 16 hex", async () => {
    const canonical = '{"operation":"preview","pages":[1]}';
    expect(officeCanonicalize({ operation: "preview", pages: [1] })).toBe(canonical);
    const digest = await sha256Hex(canonical);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await officeParamsHash("preview", { pages: [1] })).toBe(digest.slice(0, 16));
    // The path parts are not inputs: adding one changes nothing, and the rule never has them.
    const withPaths = await officeParamsHash("preview", { pages: [1] });
    expect(officeCanonicalize({ workspaceId: "ws-1", pathHash: "3f1a2b3c4d5e6f70" })).not.toBe(
      canonical,
    );
    expect(withPaths).toBe(digest.slice(0, 16));
    // An empty option set hashes {operation} alone; the key's other four fields make it a key.
    expect(await officeParamsHash("convert")).toBe(
      (await sha256Hex('{"operation":"convert"}')).slice(0, 16),
    );
  });

  // Catches: office growing a second canonical form, so the same options hash two ways. It reuses
  // the capability's JCS, which sorts keys the same way and refuses what it cannot represent.
  test("the canonical JSON is the capability's, and it refuses what it cannot represent", () => {
    // Two spellings of one value, hashed once: key order is not part of the key.
    expect(officeCanonicalize({ b: 1, a: "x", c: null })).toBe(
      officeCanonicalize({ c: null, a: "x", b: 1 }),
    );
    // What it cannot represent it refuses rather than writing some other text for it.
    expect(() => officeCanonicalize({ a: 1.5, b: "x" })).toThrow();
  });

  test("the path hash is 16 hex and the version hash is sha256:<hex>", async () => {
    const hash = await officePathHash("提案書.docx");
    expect(hash).toMatch(OFFICE_PATH_HASH_PATTERN);
    expect(hash).not.toBe(await officePathHash("提案書.docx "));
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  // Catches: a query whose order or encoding depends on the caller, so the server's signature and
  // the machine's verification disagree; and a range above the 8 MiB bound read as a plain answer.
  test("the artifact target is the path and the canonical query", () => {
    const params: ArtifactTargetParams = {
      workspaceId: "ws-1",
      path: "提案書 v2.docx",
      version: "sha256:" + "0".repeat(64),
      operation: "preview",
      paramsHash: "a1b2c3d4e5f60718",
    };
    const target = artifactTarget(params);
    expect(MACHINE_ARTIFACT_PATH).toBe("/artifact");
    expect(target.startsWith("/artifact?workspaceId=ws-1&path=")).toBe(true);
    expect(target).toBe(
      "/artifact?workspaceId=ws-1&path=" +
        encodeURIComponent("提案書 v2.docx") +
        "&version=" +
        encodeURIComponent("sha256:" + "0".repeat(64)) +
        "&operation=preview&paramsHash=a1b2c3d4e5f60718",
    );
    expect(artifactQuery({ ...params, offset: 0, length: 8 })).toContain(
      "&paramsHash=a1b2c3d4e5f60718&offset=0&length=8",
    );
    expect(() => artifactQuery({ ...params, length: -1 })).toThrow();
    expect(() => artifactQuery({ ...params, offset: 1.5 })).toThrow();

    const entries = target
      .slice(target.indexOf("?") + 1)
      .split("&")
      .map((pair) => {
        const at = pair.indexOf("=");
        return [
          decodeURIComponent(pair.slice(0, at)),
          decodeURIComponent(pair.slice(at + 1)),
        ] as const;
      });
    expect(artifactTarget(parseArtifactQuery(entries))).toBe(target);
    expect(parseArtifactQuery([...entries, ["length", String(MAX_ARTIFACT_BYTES)]])).toHaveProperty(
      "length",
      MAX_ARTIFACT_BYTES,
    );
    expect(() =>
      parseArtifactQuery([...entries, ["length", String(MAX_ARTIFACT_BYTES + 1)]]),
    ).toThrow();
    expect(() => parseArtifactQuery([...entries, ["extra", "1"]])).toThrow();
    expect(() => parseArtifactQuery([...entries, ["path", "other.docx"]])).toThrow();
  });
});

// Catches: the source variant of a write accepted together with content, so the machine would
// have to choose which bytes to write (or a cache write accepted with no hash to check them).
test("a write carries a content or a source and always its intent hash", () => {
  const source = fixture("write-source.json") as Record<string, unknown>;
  const content = fixture("write-content.json") as Record<string, unknown>;
  expect(v.safeParse(MachineWriteRequestSchema, source).success).toBe(true);
  expect(v.safeParse(MachineWriteRequestSchema, content).success).toBe(true);
  for (const broken of [
    { ...source, content: "aGVsbG8=" },
    { ...content, source: source.source },
    (() => {
      const copy = { ...content };
      delete copy.content;
      return copy;
    })(),
    { ...source, contentHash: "sha256:short" },
    (() => {
      const copy = { ...source };
      delete copy.contentHash;
      return copy;
    })(),
    { ...source, source: { ...(source.source as object), version: "v1" } },
    { ...source, source: { ...(source.source as object), pathHash: "../escape" } },
    { ...source, source: { ...(source.source as object), operation: "inspect" } },
  ]) {
    expect(v.safeParse(MachineWriteRequestSchema, broken).success, JSON.stringify(broken)).toBe(
      false,
    );
  }
  const parsed = v.parse(MachineWriteRequestSchema, source);
  expectTypeOf(parsed).toEqualTypeOf<MachineWriteRequest>();
  // The write answer still carries exactly one status, beside the office answer's ok.
  expectTypeOf<MachineWriteResult["status"]>().toEqualTypeOf<"applied" | "conflict" | "unknown">();
  expectTypeOf<OfficeResult["ok"]>().toEqualTypeOf<boolean>();
});

// Catches: the machine accepting an operation whose result nothing can name (a half-wired op), and
// the vocabulary losing a member the four lanes import.
test("the wire's operations are the contract's vocabulary", async () => {
  const machine = await import("./machine.ts");
  const job: OfficeJob = v.parse(OfficeJobSchema, fixture("job-preview.json"));
  expect(v.parse(machine.MachineOfficeRequestSchema, { op: "office", job })).toStrictEqual({
    op: "office",
    job,
  });
  expect(v.safeParse(machine.MachineOfficeRequestSchema, { op: "office" }).success).toBe(false);
  expect(v.parse(machine.MachineOfficeEngineRequestSchema, { op: "officeEngine" })).toStrictEqual({
    op: "officeEngine",
  });
  expect(
    v.safeParse(machine.MachineOfficeEngineRequestSchema, { op: "officeEngine", job }).success,
  ).toBe(false);
  // N2: the machine's office schemas *are* the contract's, and both are strict. A second key on
  // the body is refused, not dropped: a dropped key is a request the caller believes it sent.
  expect(machine.MachineOfficeRequestSchema).toBe(OfficeRequestSchema);
  expect(machine.MachineOfficeEngineRequestSchema).toBe(OfficeEngineRequestSchema);
  expect(
    v.safeParse(machine.MachineOfficeRequestSchema, { op: "office", job, extra: true }).success,
  ).toBe(false);
  expect(
    v.safeParse(machine.MachineOfficeRequestSchema, { op: "office", job: { ...job, extra: 1 } })
      .success,
  ).toBe(false);
  const result = v.parse(machine.MachineOfficeResultSchema, fixture("result-preview.json"));
  expect(result.ok).toBe(true);
  const report = v.parse(
    machine.MachineOfficeEngineResultSchema,
    fixture("result-office-engine.json"),
  );
  expect(report.available).toBe(true);
  const operations: readonly OfficeOperation[] = [
    "preview",
    "render",
    "inspect",
    "edit",
    "convert",
    "recalc",
  ];
  expect(operations).toHaveLength(6);
});

// **The production parts against each other**, not a copy of one of them. The office contract's
// `version` is checked by the machine with `officeParamsHash`, `officeArtifactFile` and the
// artifact target; the workspace computes a file's version with `versionOf`. If the two spellings
// drifted, the machine would refuse every real file as `source_changed` and every artifact read
// would be a 401 while both suites stayed green.
describe("@hns/core/office meets @hns/workspace", () => {
  test("the contract's version and the workspace's version are one spelling", () => {
    for (const bytes of [
      new Uint8Array(),
      new TextEncoder().encode("hello"),
      new Uint8Array([0, 255, 1, 2, 3]),
    ]) {
      const fromWorkspace = versionOf(bytes);
      // A change of prefix or alphabet on either side fails here: the office schema reads the
      // workspace's spelling, and WebCrypto's answer for the empty input is a known digest.
      expect(fromWorkspace, versionOf(bytes)).toMatch(OFFICE_SHA256_PATTERN);
      expect(
        v.safeParse(OfficeInputSchema, {
          workspaceId: "ws-1",
          path: "a.docx",
          version: fromWorkspace,
          format: "docx",
        }).success,
      ).toBe(true);
    }
    expect(versionOf(new Uint8Array())).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(versionOf(new TextEncoder().encode("hello"))).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

// Catches: a machine and a server that each build the cache key — a params hash computed one way
// for the write and another for the read, which would copy the wrong file into ROOT.
test("the artifact's own fields build the target and the path the machine verifies", async () => {
  const result = v.parse(OfficeResultSchema, fixture("result-preview.json"));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const target = artifactTarget({
    workspaceId: result.artifact.workspaceId,
    path: "提案書.docx",
    version: result.artifact.version,
    operation: "preview",
    paramsHash: result.artifact.key.paramsHash,
  });
  expect(target).toContain("&paramsHash=" + result.artifact.key.paramsHash);
  expect(result.artifact.file).toBe(officeArtifactFile("preview"));
  // The key the answer carries and the key the path is built from are the same 5-tuple.
  expect(officeCachePath(result.artifact.key)).toBe(
    [
      result.artifact.workspaceId,
      result.artifact.pathHash,
      result.artifact.version,
      "preview-" + result.artifact.key.paramsHash,
      "pdf",
    ].join("/"),
  );
  expect(result.artifact.key).toStrictEqual({
    workspaceId: result.artifact.workspaceId,
    pathHash: result.artifact.pathHash,
    version: result.artifact.version,
    operation: "preview",
    paramsHash: result.artifact.key.paramsHash,
  });
  const sameKey = await officeParamsHash("preview", { pages: [1, { from: 3, to: 5 }] });
  expect(sameKey).toMatch(OFFICE_PARAMS_HASH_PATTERN);
  // The extension is the operation's, so the entry's file cannot become a .exe.
  expect(officeCachePath({ ...result.artifact.key, paramsHash: sameKey })).toMatch(
    /^ws-1\/[0-9a-f]{16}\/sha256:[0-9a-f]{64}\/preview-[0-9a-f]{16}\/pdf$/u,
  );
});

/** The version the row helpers' tests name: a content hash, in the one spelling. */
const fixtureVersion = "sha256:" + "0".repeat(64);

// Catches: `stale` folded into a terminal state, so an alarm that still owes a retry is treated as
// finished and the row never settles (§3, C10).
test("the terminal preview states are the four the request or the alarm writes", () => {
  for (const status of PREVIEW_STATUSES) {
    const terminal =
      status === "ready" ||
      status === "failed" ||
      status === "unsupported" ||
      status === "disabled";
    expect(isPreviewTerminal(status)).toBe(terminal);
  }
  expect(PREVIEW_TERMINAL_STATUSES).toStrictEqual(["unsupported", "disabled", "ready", "failed"]);
});

// Catches: a machine that cannot be reached being recorded as `disabled` — the state that tells a
// person to install a pack that may already be installed (§3, C10).
test("an engine the machine reports absent is disabled, and a reachable one is queued", () => {
  expect(requestPreviewStatus(undefined)).toBe("queued");
  expect(requestPreviewStatus({ kind: "engine" })).toBe("disabled");
  expect(requestPreviewStatus({ kind: "format" })).toBe("unsupported");
});

test("a path's format is its last segment's extension, in the contract's vocabulary", () => {
  expect(officeFormatOfPath("提案書.docx")).toBe("docx");
  expect(officeFormatOfPath("a/b/Book.XLSX")).toBe("xlsx");
  expect(officeFormatOfPath("deck.pptx")).toBe("pptx");
  expect(officeFormatOfPath("scan.pdf")).toBe("pdf");
  expect(officeFormatOfPath("a.docx/notes")).toBeUndefined();
  expect(officeFormatOfPath("README")).toBeUndefined();
  expect(officeFormatOfPath("a.odt")).toBeUndefined();
  expect(officeFormatOfPath("a.")).toBeUndefined();
});

// Catches: an audit row that carries the document (a path is not the document; a value would be).
test("the audit detail carries the attempt and nothing of the document", async () => {
  const detail = officeAuditDetail({
    jobId: v.parse(OperationIdSchema, "office-1"),
    operation: "preview",
    path: "提案書.docx",
    version: fixtureVersion,
    inputHash: await sha256Hex("job"),
    engineVersion: "0.8.7",
    ms: 12,
    outcome: "ready",
  });
  expect(Object.keys(detail).sort()).toStrictEqual([
    "engineVersion",
    "inputHash",
    "jobId",
    "ms",
    "operation",
    "outcome",
    "path",
    "version",
  ]);
  // No engine version means the key is absent, not an empty string the log would record.
  expect(
    Object.hasOwn(
      officeAuditDetail({
        jobId: v.parse(OperationIdSchema, "office-2"),
        operation: "preview",
        path: "a.docx",
        version: fixtureVersion,
        inputHash: "x",
        ms: 1,
        outcome: "stale",
      }),
      "engineVersion",
    ),
  ).toBe(false);
});

test("a preview read's query is the workspace, the path, and the version, and no other key", () => {
  const query = parsePreviewQuery([
    ["workspaceId", "ws-1"],
    ["path", "提案書.docx"],
    ["v", fixtureVersion],
  ]);
  expect(query).toStrictEqual({
    workspaceId: "ws-1",
    path: "提案書.docx",
    version: fixtureVersion,
  });
  expect(() =>
    parsePreviewQuery([
      ["workspaceId", "ws-1"],
      ["path", "a.docx"],
      ["v", fixtureVersion],
      ["url", "x"],
    ]),
  ).toThrow();
  expect(() =>
    parsePreviewQuery([
      ["workspaceId", "ws-1"],
      ["path", "a.docx"],
      ["version", fixtureVersion],
    ]),
  ).toThrow();
  expect(() =>
    parsePreviewQuery([
      ["workspaceId", "ws-1"],
      ["path", "a.docx"],
      ["v", "v1"],
    ]),
  ).toThrow();
});
