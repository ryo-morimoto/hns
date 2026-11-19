import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The office pack the machine runs (`tools/office-pack/build.sh` writes it; CI stages it). */
export interface PackLocation {
  readonly root: string;
}

/**
 * Make sure the office pack exists, building it once when asked.
 *
 * @param options.root - The repository root (the checkout this journey runs in).
 * @param options.build - Build the pack when it is missing.
 * @returns Where the pack is.
 *
 * @remarks
 * **One build per checkout, never two at once.** `build.sh` clears and recreates a shared
 * scratch tree under `.cache/office-pack`, so two concurrent builds in one checkout corrupt each
 * other (0235). A lock file beside the pack is what makes a second journey wait instead of
 * racing: the journey runs one worker by default anyway, and keeping the rule here means a
 * retrying or parallel run stays correct.
 */
export async function ensurePack(options: {
  readonly root: string;
  readonly build: boolean;
}): Promise<PackLocation> {
  const pack = join(options.root, "office-pack");
  const manifest = join(pack, "manifest.json");
  if (existsSync(manifest)) return { root: pack };
  if (!options.build) {
    throw new Error(
      "no office pack at " + pack + ": build it with tools/office-pack/build.sh, or set HNS_E2E_BUILD_PACK=1",
    );
  }
  const lock = join(options.root, ".cache/office-pack-e2e.lock");
  await mkdir(join(options.root, ".cache"), { recursive: true });
  for (;;) {
    if (existsSync(manifest)) return { root: pack };
    try {
      await writeFile(lock, String(process.pid), { flag: "wx" });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  try {
    execFileSync(join(options.root, "tools/office-pack/build.sh"), [], {
      cwd: options.root,
      env: {
        ...process.env,
        IBIS_OFFICE_PACK_DIR: pack,
        IBIS_OFFICE_CACHE_DIR: join(options.root, ".cache/office-pack"),
      },
      stdio: "pipe",
    });
  } finally {
    await rm(lock, { force: true });
  }
  return { root: pack };
}

/** What the pack's manifest says it can do (`docs/office.md` §11). */
export interface PackCapabilities {
  readonly version: string;
  readonly formats: readonly string[];
  readonly operations: readonly string[];
}

/**
 * The pack's capabilities, read from its manifest.
 *
 * @param pack - The pack's directory.
 * @returns The engine's version and what it declares.
 *
 * @remarks
 * The journey checks the formats it opens against this rather than assuming them, so a pack that
 * lost one is a failure with a name.
 */
export function packCapabilities(pack: string): PackCapabilities {
  const raw: unknown = JSON.parse(readFileSync(join(pack, "manifest.json"), "utf8"));
  if (typeof raw !== "object" || raw === null) throw new Error("the manifest is not an object");
  const value = raw as {
    version?: unknown;
    capabilities?: { formats?: unknown; operations?: unknown };
  };
  if (typeof value.version !== "string") throw new Error("the manifest names no version");
  const strings = (items: unknown): readonly string[] =>
    Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
  return {
    version: value.version,
    formats: strings(value.capabilities?.formats),
    operations: strings(value.capabilities?.operations),
  };
}

/**
 * A copy of the pack with one part left out, for the "not set up" state.
 *
 * @param pack - The real pack.
 * @param to - Where the copy goes.
 * @param without - The part to leave out: `bin` (no engine binary), or a file under `fonts/`.
 * @returns The copy's directory.
 *
 * @remarks
 * **The state is made, not simulated.** The machine is given a directory that is a pack except
 * for one part, so it fails the engine's own check the way a deployment without a usable pack
 * does. The copy hard-links the pack's files (556 MB, so bytes are shared), and the removed part
 * is the only difference.
 */
export async function packWithout(pack: string, to: string, without: string): Promise<string> {
  cpSync(pack, to, { recursive: true, verbatimSymlinks: true });
  await rm(without === "bin" ? join(to, "bin/ibisOffice") : join(to, "fonts", without));
  return to;
}

/**
 * A pack that is not a pack at all: a directory with a manifest and none of the engine.
 *
 * @param to - Where it goes.
 * @returns The directory.
 *
 * @remarks
 * The second way "no engine" looks: a path an operator pointed `HNS_OFFICE_PACK` at that has
 * nothing the machine can run. Both are `disabled` states in the contract (§3, C3).
 */
export async function emptyPack(to: string): Promise<string> {
  await mkdir(to, { recursive: true });
  return to;
}

/** The version one file has: `sha256:<hex>` of its bytes (the contract's content hash). */
export function versionOf(bytes: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}