/**
 * Build the workspace packages an integration suite bundles from dist/, unless dist/ is current.
 *
 * @remarks
 * The gate builds every package before its test stage, so `npm run check` finds a fresh dist/ and
 * this helper builds nothing. A standalone `npm test -w @hns/server` has no gate, so the package
 * is built here. Suites run as separate workers and start together, so a lock makes them share
 * one build per package instead of each running its own.
 *
 * dist/ is current when every file its exports name is there and no older than the sources the
 * build compiles. A stale dist/ is rebuilt, so a standalone run after a source edit bundles the
 * edit instead of the previous output. The unit tests under src/ are not inputs, because the
 * build leaves them out.
 *
 * `HNS_ENSURE_DIST_LOG` names a file that records every build this helper starts, so a check can
 * prove the in-test builds stayed at zero.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as v from "valibot";

/** The repository root: the npm workspace whose packages are built. */
const REPO_ROOT = resolve(import.meta.dirname, "../..");
/** One package build, from tsdown to the declaration files. */
const BUILD_TIMEOUT_MS = 120_000;
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
/** How long a worker queues for another worker's build; a build alone takes at most a minute. */
const LOCK_TIMEOUT_MS = 300_000;
const LOCK_POLL_MS = 200;
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
 * @param directory - The package directory: `package.json`, `src/`, and `dist/` under it.
 * @returns `unbuilt` when dist/ or a build input is absent (a fresh checkout), `missing` when an
 * export has no file in an existing dist/, `stale` when a source or build input is newer than an
 * export's dist file, and `current` otherwise.
 * @throws {Error} When `package.json` cannot be read, or `src/` is missing; a package that lost
 * its sources is broken, not unbuilt.
 */
export function inspectDist(directory: string): DistState {
  const path = join(directory, "package.json");
  const manifest = parseManifest(path, readFileSync(path, "utf8"));
  if (!existsSync(join(directory, "dist"))) return "unbuilt";
  if (!existsSync(join(directory, "src"))) {
    throw new Error(path + ": no src/ to build from; the package lost its sources");
  }
  if (!BUILD_INPUTS.every((name) => existsSync(join(directory, name)))) return "unbuilt";
  const newestInput = Math.max(
    newestSourceMtime(join(directory, "src")),
    ...BUILD_INPUTS.map((name) => statSync(join(directory, name)).mtimeMs),
  );
  let state: DistState = "current";
  for (const { import: dist } of Object.values(manifest.exports)) {
    const file = join(directory, dist);
    if (!existsSync(file)) return "missing";
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
 * @returns The packages it built, in the order given; empty when every dist/ was current.
 * @throws {Error} When a name is not `@hns/<package>`, a package directory is missing, a manifest
 * cannot be read, or a build fails; a suite that cannot bundle a current dist/ must not run.
 */
export function ensureDist(
  packages: readonly string[],
  build: (name: string) => void = (name) => runBuild(name),
): readonly string[] {
  const wanted = packages.map((name) => ({ name, directory: packageDirectory(name) }));
  if (wanted.every(({ directory }) => inspectDist(directory) === "current")) return [];
  // Suites run as separate workers and start together, so their decisions race: the lock makes
  // the ones after the first see the dist/ it built instead of building it again.
  return withBuildLock(() => {
    const built: string[] = [];
    for (const { name, directory } of wanted) {
      if (inspectDist(directory) === "current") continue;
      build(name);
      built.push(name);
    }
    return built;
  });
}

/** Run work while no other worker builds, waiting at most {@link LOCK_TIMEOUT_MS}. */
const withBuildLock = <T>(work: () => T): T => {
  const lock = join(tmpdir(), "hns-ensure-dist-" + String(process.getuid?.() ?? "shared"));
  mkdirSync(lock, { recursive: true });
  const path = join(lock, "build.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (Date.now() > deadline)
        throw new Error("ensure-dist: waited " + LOCK_TIMEOUT_MS + "ms for another build");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    return work();
  } finally {
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
