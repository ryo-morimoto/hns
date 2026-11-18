import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { EngineManifestSchema, OFFICE_SHA256_PATTERN } from "@hns/core/office";
import type {
  EngineManifest,
  OfficeEngineReport,
  OfficeFormat,
  OfficeOperation,
} from "@hns/core/office";

/**
 * One path the pack names as "outside the pack, bind it read-only when the engine runs" (§11).
 *
 * @remarks
 * `kind` and `sha256` are required by docs/office.md §11: a bind without a well-formed digest is
 * not a bind this machine may set up, and a path that is already here must be the file the
 * manifest names. `build` is outside {@link EngineManifestSchema}, so its shape is validated here.
 */
export interface PackBindPath {
  /** What the path is for, for a message: the Vulkan driver, a library directory. */
  readonly kind: string;
  /** An absolute path, resolved by the build; the machine does not search for it. */
  readonly path: string;
  /** The digest of the bytes at that path, `sha256:<hex>`. */
  readonly sha256: string;
}

/** The part of a manifest `build` this machine reads: the environment and the binds (§11). */
interface PackBuild {
  /** Environment values, each relative to the pack root unless it is `<pack root>`. */
  readonly environment: Readonly<Record<string, string>>;
  /** Paths outside the pack the engine needs, bound read-only. */
  readonly runtime: { readonly bindPaths: readonly PackBindPath[] };
}

/** An installed pack: its manifest, its root, and what it declares. */
export interface OfficePack {
  readonly root: string;
  readonly manifest: EngineManifest;
  readonly build: PackBuild;
}

/** What reading a pack answered: the pack, or why there is none. */
export type PackLoad =
  | { readonly ok: true; readonly pack: OfficePack }
  | { readonly ok: false; readonly reason: string };

/** One `runtime.bindPaths` entry: an absolute path and the digest of the bytes there. */
const BindPathSchema: v.GenericSchema<unknown, PackBindPath> = v.object({
  kind: v.pipe(v.string(), v.minLength(1)),
  path: v.pipe(v.string(), v.startsWith("/")),
  sha256: v.pipe(v.string(), v.regex(OFFICE_SHA256_PATTERN, "a bind digest is sha256:<64 hex>")),
});

/**
 * The `build` part of a manifest, as this machine reads it.
 *
 * @remarks
 * `build` is outside {@link EngineManifestSchema} (0235): the contract has no shape for it, and
 * this is the machine's. Both halves are optional because a pack that needs nothing from the host
 * writes neither; a manifest without them is still a pack, and it binds nothing.
 */
const BuildSchema: v.GenericSchema<unknown, PackBuild> = v.object({
  // `environment` is required: a manifest without it names no library path, no font configuration,
  // and no driver, and a pack is conveyed with the exact settings it needs (docs/office.md §11,
  // 0235's `build.environment`). A pack that needs none writes `{}`, which is a decision; a pack
  // that forgot it is refused rather than run with an inherited environment nobody reviewed.
  environment: v.record(v.string(), v.string()),
  runtime: v.optional(v.object({ bindPaths: v.optional(v.array(BindPathSchema), () => []) }), {
    bindPaths: [],
  }),
});

/**
 * Read one pack's manifest, without checking the files against it.
 *
 * @param root - The pack's directory.
 * @returns The manifest and the `build` part, or the reason there is none.
 *
 * @remarks
 * The read is cheap and answers the probe: whether a manifest is there and whether the contract
 * accepts it. **It runs no engine and takes no slot**, so `officeEngine` answers while a job is
 * generating (C15). What the probe does not do is prove the bytes: {@link checkPackHost} is that,
 * and only a job needs it.
 */
export async function loadPack(root: string | undefined): Promise<PackLoad> {
  if (root === undefined) {
    return { ok: false, reason: "no office pack is installed on this machine" };
  }
  let text: string;
  try {
    text = await readFile(join(root, "manifest.json"), "utf8");
  } catch {
    return { ok: false, reason: "the office pack at " + root + " has no manifest.json" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the office pack's manifest.json is not JSON" };
  }
  const parsed = v.safeParse(EngineManifestSchema, raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason:
        "the office pack's manifest.json is not a pack manifest (" +
        parsed.issues.map((issue) => issue.message).join("; ") +
        ")",
    };
  }
  // SAFETY: `raw` is whatever JSON.parse produced and valibot's object parser accepted above; reading
  // one optional key off a value the schema just proved is an object is what the parser would do
  // next, and `BuildSchema` parses the value itself (absent or not) below.
  const build = v.safeParse(BuildSchema, (raw as { readonly build?: unknown }).build);
  if (!build.success) {
    return {
      ok: false,
      reason:
        "the office pack's build section is not one this machine can bind (" +
        build.issues.map((issue) => issue.message).join("; ") +
        ")",
    };
  }
  return {
    ok: true,
    pack: { root, manifest: parsed.output, build: build.output },
  };
}

/**
 * The probe's answer for one pack: what it declares, or why it cannot be used.
 *
 * @param load - The result of {@link loadPack}.
 * @returns `available: true` with the pack's capabilities, or `available: false` with a reason.
 *
 * @remarks
 * `operations` names only what this build can actually run: the manifest may declare `edit` from
 * a newer engine, but the machine answers `unsupported_command` for it until the sidecar exists
 * (0242), so the probe says so too rather than promising an operation it would refuse.
 */
export function packReport(load: PackLoad): OfficeEngineReport {
  if (!load.ok) return { available: false, reason: load.reason };
  const operations = load.pack.manifest.capabilities.operations.filter(isImplemented);
  return {
    available: true,
    id: load.pack.manifest.id,
    version: load.pack.manifest.version,
    formats: load.pack.manifest.capabilities.formats,
    operations,
  };
}

/** The operations this build runs itself (preview, render, convert); the rest need the sidecar. */
const IMPLEMENTED: ReadonlySet<OfficeOperation> = new Set(["preview", "render", "convert"]);

/** Whether this build runs one operation. */
function isImplemented(operation: OfficeOperation): boolean {
  return IMPLEMENTED.has(operation);
}

/** Why a pack cannot run here: absent files, wrong bytes, or a bind with nothing at its path. */
export type PackProblem =
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "mismatch"; readonly path: string; readonly actual: string }
  | { readonly kind: "unreadable"; readonly path: string; readonly reason: string };

/** What {@link checkPackHost} learned: the binds to mount, or the problem that stops a job. */
export type PackHost =
  | { readonly ok: true; readonly binds: readonly PackBindPath[] }
  | { readonly ok: false; readonly problem: PackProblem };

/** The binary of a pack, relative to its root; docs/office.md §11 names it. */
const PACK_BINARY = "bin/ibisOffice";

/**
 * Check that this host can run one pack now: the binary is at its digest, and so is every bind.
 *
 * @param pack - The loaded pack.
 * @returns The binds to mount read-only, or the problem that refuses the job.
 *
 * @remarks
 * This is what turns "the manifest says" into "this host has": a pack whose binary changed is not
 * the pack (C2 of 0235), and a bind the manifest names is either the file it names or a missing
 * path the machine binds for itself. A mismatch is a refusal, never a fall-back to whatever is at
 * the path: the engine reads that path by its recorded absolute name, and the wrong bytes there
 * would make the picture on this host and no other.
 *
 * A bind path that is **absent from this host** is not a reason to refuse a preview: the pack
 * carries the same bytes for the driver in `lib/store/` (0235), so the engine still runs. The
 * bind is then not mounted, and the render preflight is where "no driver" is answered.
 */
export async function checkPackHost(pack: OfficePack): Promise<PackHost> {
  const binary = await digestOf(join(pack.root, PACK_BINARY));
  const expectedBinary = pack.manifest.files[PACK_BINARY];
  if (binary.kind === "missing")
    return { ok: false, problem: { kind: "missing", path: PACK_BINARY } };
  if (binary.kind === "unreadable") {
    return { ok: false, problem: { kind: "unreadable", path: PACK_BINARY, reason: binary.reason } };
  }
  if (expectedBinary !== binary.digest) {
    return {
      ok: false,
      problem: { kind: "mismatch", path: PACK_BINARY, actual: binary.digest },
    };
  }
  const binds: PackBindPath[] = [];
  for (const bind of pack.build.runtime.bindPaths) {
    const found = await digestOf(bind.path);
    if (found.kind === "missing") continue;
    if (found.kind === "unreadable") {
      return { ok: false, problem: { kind: "unreadable", path: bind.path, reason: found.reason } };
    }
    if (found.digest !== bind.sha256) {
      return { ok: false, problem: { kind: "mismatch", path: bind.path, actual: found.digest } };
    }
    binds.push(bind);
  }
  return { ok: true, binds };
}

/** A digest, or why there is none. */
type Digest =
  | { readonly kind: "digest"; readonly digest: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** The `sha256:<hex>` of one file, or why it has none. */
async function digestOf(path: string): Promise<Digest> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return "code" in error && String(error.code) === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable", reason: String(error.message) };
  }
  if (!info.isFile()) return { kind: "unreadable", reason: "it is not a regular file" };
  try {
    const bytes = await readFile(path);
    return { kind: "digest", digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : "it cannot be read",
    };
  }
}

/** The problem as one phrase that names the path, for a refusal's message. */
export function problemMessage(problem: PackProblem): string {
  switch (problem.kind) {
    case "missing":
      return "the office pack is missing " + problem.path;
    case "mismatch":
      return (
        "the office pack's " +
        problem.path +
        " is " +
        problem.actual +
        ", not the file its manifest names"
      );
    case "unreadable":
      return "the office pack's " + problem.path + " cannot be read: " + problem.reason;
  }
  const unreachable: never = problem;
  return unreachable;
}
