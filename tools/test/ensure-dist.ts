/**
 * Build the workspace packages an integration suite bundles from dist/, unless dist/ is current.
 *
 * @remarks
 * The gate builds every package before its test stage, so `npm run check` finds a fresh dist/ and
 * this helper builds nothing. A standalone `npm test -w @hns/server` has no gate, so the package
 * is built here. Suites run as separate workers and start together, so a lock makes them share
 * one build per package instead of each running its own.
 *
 * dist/ is current when every file its exports name is a file there and no older than the sources
 * the build compiles. A stale dist/ is rebuilt, so a standalone run after a source edit bundles the
 * edit instead of the previous output. The unit tests under src/ are not inputs, because the
 * build leaves them out.
 *
 * Only the packages whose suites call this are read. `packages/web` has no `exports` map (it is
 * bundled by Vite, not published), so it is never named here and the manifest parse never sees it.
 *
 * `HNS_ENSURE_DIST_LOG` names a file that records every build this helper starts, so a check can
 * prove the in-test builds stayed at zero.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as v from "valibot";

/** The repository root: the npm workspace whose packages are built. */
const REPO_ROOT = resolve(import.meta.dirname, "../..");
/** One package build, from tsdown to the declaration files. */
const BUILD_TIMEOUT_MS = 120_000;
/**
 * How long a held build lock is trusted before it is taken over.
 *
 * @remarks
 * Twice one build's own timeout: a holder that is slow but alive keeps its lock, and one killed
 * between the mkdir and its release cannot block the suite behind it for long.
 */
const LOCK_STALE_MS = 2 * BUILD_TIMEOUT_MS;
/** How long a lock with no readable record is trusted, before its writer can have finished. */
const LOCK_TORN_MS = 2_000;
const LOCK_POLL_MS = 100;
/** Unit tests live under src/ and a build does not compile them. */
const SOURCE_TEST = /\.test\.tsx?$/u;
/**
 * Build inputs outside src/ that a change to also invalidates dist/.
 *
 * @remarks
 * The two tsconfig files set `noEmit`, so tsdown emits from its own defaults and never reads
 * them; they are listed because changing one is meant to force a rebuild.
 */
const BUILD_INPUTS = ["package.json", "tsdown.config.ts", "tsconfig.build.json"];
/** The scope this helper knows how to read. */
const PACKAGE_NAME = /^@hns\/[a-z0-9-]+$/u;

/** The part of a workspace manifest this helper reads: the dist file each export names. */
export interface Manifest {
  readonly exports: Readonly<Record<string, { readonly import: string }>>;
}

const MANIFEST: v.GenericSchema<unknown, Manifest> = v.object({
  exports: v.record(v.string(), v.object({ import: v.pipe(v.string(), v.minLength(1)) })),
});

/** Whether `dist` was built from sources no newer than it. */
export type DistState = "current" | "missing" | "stale" | "unbuilt";

/**
 * Parse the text of a package.json into the export map it declares.
 *
 * @param path - Where the text came from; it names the error.
 * @returns Each export's `import` path, which is its file under dist/.
 * @throws {Error} When the manifest has no `exports` map, or an export has no import path; the
 * helper could not then tell a built package from an unbuilt one.
 */
export function parseManifest(path: string, text: string): Manifest {
  try {
    return v.parse(MANIFEST, JSON.parse(text));
  } catch (error) {
    throw new Error(path + ": expected an exports map with an import path per export", {
      cause: error,
    });
  }
}

/**
 * Decide whether a package directory needs a build.
 *
 * @remarks
 * An export whose import path leaves the package is refused: it would otherwise be a file that
 * happens to exist elsewhere, and the build never writes it.
 *
 * @param directory - The package directory: `package.json`, `src/`, and `dist/` under it.
 * @returns `unbuilt` when dist/ or a build input is absent (a fresh checkout), `missing` when an
 * export has no file in an existing dist/, `stale` when a source or build input is newer than an
 * export's dist file, and `current` otherwise.
 * @throws {Error} When `package.json` cannot be read, an export points outside the package, or
 * `src/` is missing; a package that lost its sources is broken, not unbuilt.
 */
export function inspectDist(directory: string): DistState {
  const root = resolve(directory);
  const path = join(root, "package.json");
  const manifest = parseManifest(path, readFileSync(path, "utf8"));
  if (!existsSync(join(root, "dist"))) return "unbuilt";
  if (!existsSync(join(root, "src"))) {
    throw new Error(path + ": no src/ to build from; the package lost its sources");
  }
  if (!BUILD_INPUTS.every((name) => existsSync(join(root, name)))) return "unbuilt";
  const newestInput = Math.max(
    newestSourceMtime(join(root, "src")),
    ...BUILD_INPUTS.map((name) => statSync(join(root, name)).mtimeMs),
  );
  let state: DistState = "current";
  for (const { import: dist } of Object.values(manifest.exports)) {
    const file = join(root, dist);
    const inside = relative(root, file);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(path + ": export " + dist + " points outside the package");
    }
    if (!existsSync(file) || !statSync(file).isFile()) return "missing";
    // Equal mtimes count as current: a build that wrote at the same instant as a save is the
    // newer of the two in practice, and treating a tie as built keeps a check from rebuilding.
    if (statSync(file).mtimeMs < newestInput) state = "stale";
  }
  return state;
}

/**
 * Build the workspace packages whose dist/ an integration suite bundles, unless dist/ is current.
 *
 * @param packages - Workspace package names, such as `@hns/server` or `@hns/workspace`.
 * @param build - How to build one package; `npm run build -w <name>` in the repository root by
 * default. A suite passes its own to observe the calls.
 * @param options - `lock` names the lock path; the shared per-user one by default. A test passes a
 * temporary path so it can place an orphan lock without touching the queue every suite uses.
 * @returns The packages it built, in the order given; empty when every dist/ was current.
 * @throws {Error} When a name is not `@hns/<package>`, a package directory is missing, a manifest
 * cannot be read, or a build fails; a suite that cannot bundle a current dist/ must not run.
 */
export function ensureDist(
  packages: readonly string[],
  build: (name: string) => void = (name) => runBuild(name),
  options: { readonly lock?: string | undefined } = {},
): readonly string[] {
  const wanted = packages.map((name) => ({ name, directory: packageDirectory(name) }));
  if (wanted.every(({ directory }) => inspectDist(directory) === "current")) return [];
  // Suites run as separate workers and start together, so their decisions race: the lock makes
  // the ones after the first see the dist/ it built instead of building it again.
  return withBuildQueue(options.lock ?? sharedLockPath(), () => {
    const built: string[] = [];
    for (const { name, directory } of wanted) {
      if (inspectDist(directory) === "current") continue;
      build(name);
      built.push(name);
    }
    return built;
  });
}

/** The owner record inside the lock directory: a file, so the lock itself is a directory. */
const OWNER_FILE = "owner.json";

/** One build lock: who holds it, since when, so an abandoned one can be taken over. */
const lockRecord = v.object({
  /** The worker that took the lock. */
  pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** When it was taken, in ms since the epoch; the age alone can abandon it. */
  at: v.number(),
  /** Identifies one acquisition, so a late release cannot delete a later owner's lock. */
  token: v.pipe(v.string(), v.minLength(1)),
});

export type LockRecord = v.InferOutput<typeof lockRecord>;

/** What the lock says, with the age the decision needs. */
export type LockSnapshot =
  | { readonly state: "absent" }
  | { readonly state: "held"; readonly record: LockRecord; readonly ageMs: number }
  | { readonly state: "unreadable"; readonly ageMs: number };

/** What a waiter may do with a snapshot. */
export type LockJudgement = "free" | "held" | "abandoned";

/**
 * Read one lock record.
 *
 * @remarks
 * The record is external input: a torn write, an older shape, or another user's file parses to
 * `null` and the caller decides from the age alone.
 */
export const parseLock = (text: string): LockRecord | null => {
  try {
    const parsed = v.safeParse(lockRecord, JSON.parse(text));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
};

/**
 * What a waiter may do with a lock snapshot.
 *
 * @remarks
 * "free" is an absent lock. A readable record is "held" while its owner lives and it is younger
 * than {@link LOCK_STALE_MS}; "abandoned" when the owner has died or the record outlived every
 * build, so a worker killed between its mkdir and release cannot block the next suite. A torn
 * record is "held" for {@link LOCK_TORN_MS} and "abandoned" after it. The judgement is a snapshot,
 * so a takeover re-reads the record before removing it.
 */
export const judgeLock = (snapshot: LockSnapshot, ownerAlive: boolean): LockJudgement => {
  switch (snapshot.state) {
    case "absent":
      return "free";
    case "unreadable":
      return snapshot.ageMs >= LOCK_TORN_MS ? "abandoned" : "held";
    case "held":
      return snapshot.ageMs >= LOCK_STALE_MS || !ownerAlive ? "abandoned" : "held";
  }
};

/**
 * Take the build lock at `path`, run `work`, and release it.
 *
 * @remarks
 * The lock is a directory: `mkdir` either creates it or fails with EEXIST, which is atomic on every
 * filesystem this runs on. The owner record inside it carries a pid, so a lock left by a killed
 * worker is taken over instead of waited on.
 *
 * @throws {Error} When the lock stays held past {@link LOCK_STALE_MS} and its owner is alive; the
 * message names the lock path and its owner.
 */
export const withBuildQueue = <T>(path: string, work: () => T): T => {
  mkdirSync(dirname(path), { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + LOCK_STALE_MS;
  for (;;) {
    const snapshot = readLock(path);
    const judgement = judgeLock(snapshot, snapshotOwnerAlive(snapshot));
    if (judgement === "free" || judgement === "abandoned") {
      if (takeOver(path, snapshot, token)) break;
    } else if (Date.now() > deadline) {
      throw new Error(
        "ensure-dist: " +
          path +
          " stayed locked by " +
          describe(snapshot) +
          " for " +
          LOCK_STALE_MS +
          "ms; remove it if that worker is gone",
      );
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  }
  try {
    return work();
  } finally {
    release(path, token);
  }
};

/** The shared lock path: one per user, so every worktree this user runs shares one build queue. */
const sharedLockPath = (): string =>
  join(tmpdir(), "hns-ensure-dist-" + String(process.getuid?.() ?? "shared"), "build.lock");

const readLock = (path: string): LockSnapshot => {
  if (!existsSync(path)) return { state: "absent" };
  let text: string;
  try {
    text = readFileSync(join(path, OWNER_FILE), "utf8");
  } catch {
    // The lock or its record went away under the read; the caller sees it as free.
    return { state: "absent" };
  }
  const record = parseLock(text);
  // The record's own mtime: writing it does not move the directory's, and the age is the wait's
  // only escape when a pid was recycled by an unrelated process.
  return record === null
    ? { state: "unreadable", ageMs: ageOf(join(path, OWNER_FILE)) }
    : { state: "held", record, ageMs: ageOf(join(path, OWNER_FILE)) };
};

const ageOf = (path: string): number => {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A live process owned by another user answers EPERM, not ESRCH.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const snapshotOwnerAlive = (snapshot: LockSnapshot): boolean =>
  snapshot.state === "held" && pidAlive(snapshot.record.pid);

const describe = (snapshot: LockSnapshot): string =>
  snapshot.state === "held"
    ? "pid " + String(snapshot.record.pid) + " for " + String(Math.round(snapshot.ageMs)) + "ms"
    : "an unreadable record";

/**
 * Replace the judged lock with ours, unless it moved since.
 *
 * @remarks
 * The record is judged before the mkdir, so another waiter may have taken the lock meanwhile.
 * Only the record that was judged may be removed, and it is removed before our own mkdir, which
 * is what keeps two waiters from holding the lock at once.
 */
const takeOver = (path: string, judged: LockSnapshot, token: string): boolean => {
  if (judged.state !== "absent") {
    const current = readLock(path);
    if (!sameRecord(judged, current)) return false;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      return false;
    }
  }
  try {
    mkdirSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
  writeFileSync(
    join(path, OWNER_FILE),
    JSON.stringify({ pid: process.pid, at: Date.now(), token }),
  );
  return true;
};

/**
 * Whether a snapshot still describes the record a takeover judged abandoned.
 *
 * @remarks
 * The judged record was read before the removal, so another waiter may have released or replaced
 * it. Only the same record may be removed; a fresh one belongs to a holder that is still building.
 */
export const sameRecord = (judged: LockSnapshot, current: LockSnapshot): boolean => {
  switch (judged.state) {
    case "absent":
      return current.state === "absent";
    case "unreadable":
      return current.state === "unreadable" && current.ageMs >= LOCK_TORN_MS;
    case "held":
      return current.state === "held" && current.record.token === judged.record.token;
  }
};

/** Remove the lock, but only while it is still ours. */
const release = (path: string, token: string): void => {
  const current = readLock(path);
  if (current.state === "held" && current.record.token === token) {
    rmSync(path, { recursive: true, force: true });
  }
};

/** The newest mtime of the files under src/ that the build compiles. */
const newestSourceMtime = (directory: string): number => {
  let newest = 0;
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || SOURCE_TEST.test(entry.name)) continue;
    const at = statSync(join(entry.parentPath, entry.name)).mtimeMs;
    if (at > newest) newest = at;
  }
  return newest;
};

/** The directory of a workspace package, refusing a name that could point outside packages/. */
const packageDirectory = (name: string): string => {
  if (!PACKAGE_NAME.test(name)) {
    throw new Error("ensure-dist: expected a workspace package name like @hns/server, got " + name);
  }
  const directory = join(REPO_ROOT, "packages", name.slice("@hns/".length));
  if (!existsSync(join(directory, "package.json"))) {
    throw new Error("ensure-dist: " + name + " has no package.json in " + directory);
  }
  return directory;
};

/** Build one package, record the call, and fail with what the build said. */
const runBuild = (name: string): void => {
  const log = process.env.HNS_ENSURE_DIST_LOG;
  if (log !== undefined && log !== "") appendFileSync(log, "build " + name + "\n");
  try {
    execFileSync("npm", ["run", "build", "-w", name], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      timeout: BUILD_TIMEOUT_MS,
    });
  } catch (error) {
    const output =
      error instanceof Error && "stderr" in error && Buffer.isBuffer(error.stderr)
        ? error.stderr.toString()
        : "";
    throw new Error("ensure-dist: building " + name + " failed\n" + output, { cause: error });
  }
};
