import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  officeArtifactFile,
  officeErrorOfRefusal,
  officeParamsHash,
  officePathHash,
} from "@hns/core/office";
import type {
  OfficeArtifact,
  OfficeCacheKey,
  OfficeEngineReport,
  OfficeErrorCode,
  OfficeJob,
  OfficeOptionValue,
  OfficeResult,
} from "@hns/core/office";
import { containInRoot } from "../containment.ts";
import { officeJobTimeoutMs } from "../limits.ts";
import { MachineRefusal } from "../refusal.ts";
import type { CacheEntryFacts, CacheEntryMetadata, OfficeCache } from "./cache.ts";
import { runEngine } from "./engine.ts";
import type { EngineOutcome } from "./engine.ts";
import { checkPackHost, loadPack, packReport, problemMessage } from "./pack.ts";
import type { OfficePack, PackHost } from "./pack.ts";
import { scanOfficeInput } from "./prescan.ts";

/**
 * Everything an office job needs from the machine: the cache, the pack, and the run's paths.
 *
 * @remarks
 * The executor is built once at start and handed to every request, so the single slot it checks
 * is the machine's: one engine runs here, and a second job is answered `engine_busy` instead of
 * queueing (docs/office.md §5). `workRoot` is a directory outside ROOT that runs are made in;
 * `packRoot` is where the pack is installed, and may be absent.
 */
export interface OfficeEngine {
  readonly cache: OfficeCache;
  /** The pack's directory; undefined when no pack is installed on this machine. */
  readonly packRoot: string | undefined;
  /** Where a run's temporary directory is made (outside ROOT). */
  readonly workRoot: string;
  /** The bwrap executable, for a test that presents another one; defaults to the host's. */
  readonly bwrap?: string | undefined;
  /** The clock stats' milliseconds are measured with; defaults to `Date.now`. */
  readonly now?: (() => number) | undefined;
}

/** The slot's owner while a job runs; undefined when the engine is free. */
let running: string | undefined;

/** Whether an office job holds the machine's single slot now. */
export function officeBusy(): boolean {
  return running !== undefined;
}

/** The machine's own office bounds, which the job's are enforced under. */
export interface OfficeEnvelope {
  readonly timeoutMs: number;
  readonly maxRssMb: number;
}

/**
 * Run one office job: prescan, cache, engine, cache, answer.
 *
 * @param engine - The cache, the pack, and the run's paths.
 * @param job - The job the server resolved.
 * @param root - The machine's canonical ROOT; the input is resolved inside it, and nothing is written there.
 * @param workspaceId - The workspace this machine serves; the job must name it.
 * @param envelope - The machine's own `office` bounds.
 * @param signal - The request's deadline.
 * @returns `OfficeResult`: the artifact with its stats, or the typed failure.
 * @throws {MachineRefusal} `busy` when another job holds the slot. Every other failure of a job
 * is the job's own answer, never a refusal: the contract has a code for each of them.
 *
 * @remarks
 * The job's own bounds travel in the job, and the machine enforces exactly them (0234: the server
 * resolved them). What the machine adds is its envelope: the job's `timeoutMs` is clamped below
 * `office.timeoutMs` so the machine answers `engine_timeout` itself, the artifact's range and the
 * engine's memory have the machine's own bounds, and one job runs at a time.
 *
 * **Nothing is written to ROOT**: a preview, a render, and a conversion all end in the cache, and
 * a conversion's PDF is the cache's file named by `artifact.key` (0241 assets it into the
 * workspace; this op does not).
 */
export async function runOfficeJob(
  engine: OfficeEngine,
  job: OfficeJob,
  root: string,
  workspaceId: string,
  envelope: OfficeEnvelope,
  signal: AbortSignal,
): Promise<OfficeResult> {
  signal.throwIfAborted();
  const now = engine.now ?? Date.now;
  const started = now();
  // The slot is taken and returned around the job, in one `finally`: a prescan that throws, a
  // cancelled request, and a finished engine all leave the machine free for the next job.
  if (!takeOfficeSlot(job.id)) {
    throw new MachineRefusal("busy", "another office job holds the machine's single slot");
  }
  try {
    return await runJob(engine, job, root, workspaceId, envelope, signal, started);
  } finally {
    releaseOfficeSlot();
  }
}

/** Take the machine's single office slot; false when another job holds it. */
function takeOfficeSlot(jobId: string): boolean {
  if (running !== undefined) return false;
  running = jobId;
  return true;
}

/** Give the slot back. */
function releaseOfficeSlot(): void {
  running = undefined;
}

/** The job, with the slot already taken. */
async function runJob(
  engine: OfficeEngine,
  job: OfficeJob,
  root: string,
  workspaceId: string,
  envelope: OfficeEnvelope,
  signal: AbortSignal,
  started: number,
): Promise<OfficeResult> {
  const loaded = await loadPack(engine.packRoot);
  if (!loaded.ok) return failure("engine_unavailable", loaded.reason);
  const pack = loaded.pack;
  const host = await checkPackHost(pack);
  if (!host.ok) return failure("engine_unavailable", problemMessage(host.problem));
  const unsupported = unsupportedReason(job, pack);
  if (unsupported !== undefined) return failure("unsupported_command", unsupported);

  const input = await resolveInput(root, workspaceId, job);
  if (!input.ok) return input.result;
  const bytes = await readFile(input.path).catch(() => undefined);
  if (bytes === undefined) return failure("engine_failed", "the input could not be read");
  const verdict = scanOfficeInput({
    format: job.input.format,
    limits: job.limits,
    bytes,
    name: job.input.path,
  });
  if (!verdict.ok) return failure(verdict.error, verdict.message);

  const key = await cacheKeyOf(job);
  const hit = key === undefined ? undefined : await engine.cache.lookup(key);
  if (key !== undefined && hit !== undefined) {
    return {
      ok: true,
      artifact: artifactOf(key, hit.metadata),
      stats: { ms: 0, peakRssMb: 0, cached: true },
    };
  }

  signal.throwIfAborted();
  const timeoutMs = officeJobTimeoutMs(job.limits.timeoutMs, envelope.timeoutMs);
  const outcome = await runInSandbox(engine, pack, job, input.path, timeoutMs, envelope, host);
  const ms = (engine.now ?? Date.now)() - started;
  if (!outcome.ok) return engineFailure(outcome);
  // The bytes are read here, before the run is collected: the file is the only copy the cache can
  // keep, and a path into a directory that is about to be removed is not an artifact.
  const produced = outcome.produced;
  try {
    const sha256 = "sha256:" + createHash("sha256").update(produced).digest("hex");
    const pages = outcome.output.endsWith(".png") ? undefined : pdfPages(produced);
    const storedKey: OfficeCacheKey =
      job.operation === "render"
        ? requireKey(key, job)
        : { ...requireKey(key, job), operation: "preview" };
    const missingFonts: readonly string[] = [];
    const producer = { id: pack.manifest.id, version: pack.manifest.version };
    const facts: CacheEntryFacts =
      pages === undefined
        ? { sha256, missingFonts, engine: producer }
        : { sha256, missingFonts, engine: producer, pages };
    const stored = await engine.cache.store(storedKey, produced, facts);
    const storedBytes = (await stat(stored)).size;
    await engine.cache.sweep().catch(() => undefined);
    const answered: CacheEntryMetadata = {
      usedAt: 0,
      bytes: storedBytes,
      sha256,
      missingFonts,
      engine: producer,
    };
    const metadata: CacheEntryMetadata = pages === undefined ? answered : { ...answered, pages };
    return {
      ok: true,
      artifact: artifactOf(storedKey, metadata),
      stats: { ms, peakRssMb: outcome.peakRssMb, cached: false },
    };
  } catch (error) {
    return failure(
      "engine_failed",
      "the artifact could not be kept in the cache: " +
        (error instanceof Error ? error.message : "unknown error"),
    );
  }
}

/** The key a job must have by the time an engine ran; unreachable otherwise. */
function requireKey(key: OfficeCacheKey | undefined, job: OfficeJob): OfficeCacheKey {
  if (key !== undefined) return key;
  throw new Error("the office job " + job.id + " ran without a cache key");
}

/**
 * Ask the pack what it is, without running it and without taking the slot.
 *
 * @param packRoot - The pack's directory, or undefined when none is installed.
 * @returns The pack's capabilities, or the reason it has none.
 *
 * @remarks
 * This is what makes the probe answer while a job runs (C15): it reads `manifest.json` and nothing
 * else, so it neither waits for nor disturbs the engine. It is also the one place an operator asks
 * "is Office set up here", which is why the reason names the missing path rather than saying
 * "unavailable".
 */
export async function probeOfficeEngine(packRoot: string | undefined): Promise<OfficeEngineReport> {
  return packReport(await loadPack(packRoot));
}

/** The job's answer as a failure. */
function failure(error: OfficeErrorCode, message: string): OfficeFailure {
  return { ok: false, error, message };
}

/** The refusal's office code, through the contract's one table (docs/office.md §9). */
export function officeCodeOfRefusal(refusal: MachineRefusal): OfficeErrorCode {
  return officeErrorOfRefusal(refusal.code, refusal.message);
}

/**
 * Why this build cannot run one job, or undefined when it can.
 *
 * @param job - The job the server resolved.
 * @param pack - The installed pack.
 * @returns The reason, phrased for a person; the answer above it is `unsupported_command`.
 *
 * @remarks
 * The engine's CLI is what limits the vocabulary: v0.8.7 exports every page (there is no
 * `--pages`), so a preview or a render that names pages is refused rather than answered with the
 * whole document, and `inspect` / `edit` / `recalc` wait for the sidecar (0242).
 */
function unsupportedReason(job: OfficeJob, pack: OfficePack): string | undefined {
  if (!pack.manifest.capabilities.operations.some((operation) => operation === job.operation)) {
    return "the office pack does not declare " + job.operation;
  }
  if (!pack.manifest.capabilities.formats.some((format) => format === job.input.format)) {
    return "the office pack does not handle " + job.input.format;
  }
  switch (job.operation) {
    case "preview":
    case "render":
      if (job.pages === undefined) return undefined;
      return "this build's office engine exports every page; a page selection is not supported yet";
    case "convert":
      return undefined;
    case "inspect":
    case "edit":
    case "recalc":
      return "this build does not run " + job.operation + " yet; the sidecar is 0242";
  }
  const unreachable: never = job;
  return unreachable;
}

/** The input file, resolved inside ROOT and proved to be the version the job names. */
type ResolvedInput =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly result: OfficeFailure };

/** One job's typed failure; the member of `OfficeResult` a failed job answers with. */
type OfficeFailure = Extract<OfficeResult, { ok: false }>;

/**
 * Resolve the job's input inside ROOT and compare its content with the version.
 *
 * @param root - The canonical ROOT.
 * @param workspaceId - The workspace this machine serves.
 * @param job - The job.
 * @returns The file's path, or the result that refuses it.
 *
 * @remarks
 * The version is the workspace's, whose body is the content hash, so the check is the file's own
 * digest (INV-O2): a job that names a version the file no longer has is refused `source_changed`
 * before anything runs, and nothing is generated for a document nobody asked about. A path that
 * leaves ROOT is `not_authorized` (the machine cannot read it); a file that is absent is
 * `engine_failed` (the job was well formed; the machine's view of the workspace disagrees).
 */
async function resolveInput(
  root: string,
  workspaceId: string,
  job: OfficeJob,
): Promise<ResolvedInput> {
  if (job.input.workspaceId !== workspaceId) {
    return { ok: false, result: failure("not_authorized", "the job names another workspace") };
  }
  let absolute: string;
  try {
    absolute = (await containInRoot(root, job.input.path)).absolute;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (!(error instanceof MachineRefusal)) throw error;
    return { ok: false, result: failure(officeCodeOfRefusal(error), error.message) };
  }
  const info = await stat(absolute).catch(() => undefined);
  if (info === undefined || !info.isFile()) {
    return {
      ok: false,
      result: failure("engine_failed", job.input.path + ": the input does not exist"),
    };
  }
  const digest =
    "sha256:" +
    createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex");
  if (digest !== job.input.version) {
    return {
      ok: false,
      result: failure(
        "source_changed",
        job.input.path + " is " + digest + ", not the version the job names",
      ),
    };
  }
  return { ok: true, path: absolute };
}

/**
 * The 5-tuple one job's artifact lives under (§4).
 *
 * @param job - The job.
 * @returns The key, or undefined for an operation that makes no artifact.
 *
 * @remarks
 * `paramsHash` is the contract's `officeParamsHash` over the operation and the options that change
 * what the engine produces, and nothing else: the path parts are fields of the key rather than
 * inputs to the hash, which is what keeps one artifact at one key whichever side built it. A
 * `convert` is keyed as a `preview` for the same reason a preview is: the file it makes is a PDF,
 * and `render` is the only other operation in the vocabulary of keys.
 */
async function cacheKeyOf(job: OfficeJob): Promise<OfficeCacheKey | undefined> {
  const pathHash = await officePathHash(job.input.path);
  const base = {
    workspaceId: job.input.workspaceId,
    pathHash,
    version: job.input.version,
  };
  switch (job.operation) {
    case "preview":
      return { ...base, operation: "preview", paramsHash: await officeParamsHash("preview", {}) };
    case "render": {
      const params: Record<string, OfficeOptionValue> = {};
      if (job.width !== undefined) params["width"] = job.width;
      return { ...base, operation: "render", paramsHash: await officeParamsHash("render", params) };
    }
    case "convert":
      return {
        ...base,
        operation: "preview",
        paramsHash: await officeParamsHash("convert", { to: "pdf" }),
      };
    case "inspect":
    case "edit":
    case "recalc":
      return undefined;
  }
  const unreachable: never = job;
  return unreachable;
}

/** The artifact one cache entry answers with. */
function artifactOf(key: OfficeCacheKey, metadata: CacheEntryMetadata): OfficeArtifact {
  const artifact: OfficeArtifact = {
    key,
    workspaceId: key.workspaceId,
    pathHash: key.pathHash,
    version: key.version,
    file: officeArtifactFile(key.operation),
    sha256: metadata.sha256,
    bytes: metadata.bytes,
    missingFonts: metadata.missingFonts,
    engine: metadata.engine,
  };
  const pages = metadata.pages;
  return pages === undefined ? artifact : { ...artifact, pages };
}

/**
 * Run one job in the sandbox, in a fresh directory outside ROOT.
 *
 * @param engine - The executor, for the run's directory and the bwrap to use.
 * @param pack - The checked pack.
 * @param job - The job.
 * @param input - The document inside ROOT.
 * @param timeoutMs - The job's clamped budget.
 * @param envelope - The machine's memory bound.
 * @param host - The pack's host check, whose binds are mounted read-only.
 * @returns The engine's outcome; the directory is removed once it is collected.
 *
 * @remarks
 * The document is copied into the run: the engine reads it from a directory that holds nothing
 * else, so a document cannot reach its siblings through a link, and the run is where its temporary
 * files live. The directory is removed whether the run succeeded or not, and the artifact has
 * already been read out of it by then.
 */
async function runInSandbox(
  engine: OfficeEngine,
  pack: OfficePack,
  job: OfficeJob,
  input: string,
  timeoutMs: number,
  envelope: OfficeEnvelope,
  host: PackHost,
): Promise<CollectedRun> {
  if (!host.ok) return { ok: false, kind: "unavailable", reason: problemMessage(host.problem) };
  // The runs' directory is created when the engine is; an agent that was started with one that
  // does not exist yet still runs, and a mkdtemp into nothing is answered as the job's failure.
  await mkdir(engine.workRoot, { recursive: true });
  const work = await mkdtemp(join(engine.workRoot, "run-"));
  try {
    const name = "input." + job.input.format;
    await writeFile(join(work, name), await readFile(input));
    // What the engine wrote is read **here**, while the run still exists: this function removes the
    // run once the engine returns, so a path handed back to the caller would already be gone.
    const outcome = await runEngine({
      pack,
      binds: host.binds,
      input: join(work, name),
      operation: job.operation,
      width: job.operation === "render" ? job.width : undefined,
      work,
      workRoot: engine.workRoot,
      timeoutMs,
      maxRssMb: envelope.maxRssMb,
      maxOutputBytes: job.limits.maxOutputBytes,
      bwrap: engine.bwrap,
    });
    if (!outcome.ok) return outcome;
    const bytes = await readFile(outcome.output).catch(() => undefined);
    return bytes === undefined
      ? { ok: false, kind: "failed", reason: "the office engine's artifact could not be read back" }
      : { ...outcome, produced: bytes };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** What one run left: the engine's outcome with the artifact's bytes, read while the run existed. */
type CollectedRun =
  | (Extract<EngineOutcome, { ok: true }> & { readonly produced: Uint8Array })
  | Extract<EngineOutcome, { ok: false }>;

/** The office code one engine failure means (§9). */
function engineFailure(outcome: Extract<EngineOutcome, { ok: false }>): OfficeFailure {
  switch (outcome.kind) {
    case "unavailable":
      return failure("engine_unavailable", outcome.reason);
    case "timeout":
      return failure("engine_timeout", "the office engine did not finish inside the job's budget");
    case "too_large":
      return failure("output_too_large", outcome.reason);
    case "failed":
      return failure("engine_failed", outcome.reason);
  }
  const unreachable: never = outcome;
  return unreachable;
}

/**
 * How many pages a PDF file holds.
 *
 * @param path - The produced file.
 * @returns The page count, at least 1.
 *
 * @remarks
 * The result schema requires at least one page, and a file the engine wrote and the magic check
 * passed is a PDF. The count is read from the catalogue, which a writer puts near the end; a PDF
 * whose count this cannot find is still a PDF, and answering 1 says "at least one page" rather
 * than inventing a number.
 */
function pdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder("latin1").decode(
    bytes.subarray(Math.max(0, bytes.length - 1024 * 1024)),
  );
  let pages = 0;
  for (const match of text.matchAll(/\/Type\s*\/Pages\b[\s\S]{0,512}?\/Count\s+([0-9]{1,7})/gu)) {
    const count = Number(match[1]);
    if (Number.isSafeInteger(count) && count > pages) pages = count;
  }
  return Math.max(1, pages);
}
