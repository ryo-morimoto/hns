import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { parseReply } from "./protocol.ts";
import type { HelperBase, HelperOutcome, HelperRequest } from "./protocol.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/**
 * The helper that sits next to this module: .ts in the source tree, .js in dist.
 *
 * @returns The path to the helper, or undefined when neither name exists.
 *
 * @internal
 */
function helperPath(): string | undefined {
  for (const name of ["rooted-helper.ts", "rooted-helper.js"]) {
    const found = join(HERE, name);
    if (existsSync(found)) return found;
  }
  return undefined;
}

/**
 * What the helper needs to hold one root: the environment that runs it, the
 * canonical root, and the journal identity its marker must name.
 *
 * @internal
 */
export interface RootedInput {
  readonly env: ExecutionEnv;
  readonly root: string;
  readonly id: string;
  readonly context: Context;
}

/**
 * Opens and renames from a directory fd, in a process started through exec, so
 * a swapped parent cannot redirect the operation. Optional by design: where it
 * cannot run, the workspace keeps the path-based checks (docs/workspace.md).
 *
 * @remarks
 * The probe records the root's device and inode; every later call hands them
 * back and the helper refuses a root that is no longer the same directory. A
 * failure is reported as a `failed` outcome, never thrown, so the workspace
 * decides between Denied and FileFailure. The hash-then-rename window remains:
 * Linux has no compare-and-rename, so a same-name swap between the two steps
 * can still lose an update.
 *
 * @internal
 */
export class Rooted {
  readonly #input: RootedInput;
  readonly #helper: string;
  readonly #dev: number;
  readonly #ino: number;

  private constructor(input: RootedInput, helper: string, dev: number, ino: number) {
    this.#input = input;
    this.#helper = helper;
    this.#dev = dev;
    this.#ino = ino;
  }

  /**
   * Hold the root for the life of the workspace, or nothing when the probe fails.
   *
   * @param input - The environment, the canonical root, and the journal id.
   * @returns A Rooted that has pinned `dev`/`ino`, or undefined when the
   * platform is not Linux, the helper is not beside this module, or the probe
   * did not answer. A probe that cannot run is not an error: the caller keeps
   * `mode: "checks"` and its wider race window.
   */
  static async probe(input: RootedInput): Promise<Rooted | undefined> {
    if (process.platform !== "linux") return undefined;
    const helper = helperPath();
    if (helper === undefined) return undefined;
    const outcome = await invoke(input, helper, { op: "probe", root: input.root, id: input.id });
    if (outcome.kind !== "probe") return undefined;
    return new Rooted(input, helper, outcome.dev, outcome.ino);
  }

  #base(): HelperBase {
    return { root: this.#input.root, id: this.#input.id, dev: this.#dev, ino: this.#ino };
  }

  /**
   * Hash the file at `path`, or report `not_found` when the name is free.
   *
   * @param path - Component names below the root, never a "/" or "..".
   * @returns A version outcome, or a failed outcome with the helper's code.
   */
  hash(path: readonly string[]): Promise<HelperOutcome> {
    return this.#call({ ...this.#base(), op: "hash", path });
  }

  /**
   * Read the file at `path` through the helper's opened descriptor.
   *
   * @param path - Component names below the root; the final component may not
   * be a symbolic link.
   * @returns Content, or a failed outcome (`too_large` above 8 MiB).
   */
  read(path: readonly string[]): Promise<HelperOutcome> {
    return this.#call({ ...this.#base(), op: "read", path });
  }

  /**
   * Replace `path` if it is still at `expectedVersion`, under one pinned parent.
   *
   * @param path - Component names below the root for the target.
   * @param temp - The temp file's name relative to the root; it must be one
   * component, because the helper renames from the root dirfd.
   * @param expectedVersion - The version the caller saw, or "absent".
   * @returns `applied`, `conflict` with the current version, or `failed`.
   *
   * @remarks
   * The helper re-hashes and renames from the same parent dirfd, so a swapped
   * parent cannot redirect the rename. The residual window is a same-name swap
   * between the hash and the rename.
   */
  commit(path: readonly string[], temp: string, expectedVersion: string): Promise<HelperOutcome> {
    return this.#call({ ...this.#base(), op: "commit", path, temp, expectedVersion });
  }

  #call(request: HelperRequest): Promise<HelperOutcome> {
    return invoke(this.#input, this.#helper, request);
  }
}

const failed = (code: string, message: string): HelperOutcome => ({
  kind: "failed",
  code,
  message,
});

/**
 * Run one helper process and turn its stdout into an outcome.
 *
 * @remarks
 * A missing helper, a refused exec, or an empty stdout all become `failed`
 * outcomes: the workspace has a fallback path, and an unexpected exception here
 * would bypass it. Only the first line of stderr is kept, because the message
 * is diagnostic, not part of the contract.
 *
 * @internal
 */
async function invoke(
  input: RootedInput,
  helper: string,
  request: HelperRequest,
): Promise<HelperOutcome> {
  let stdout = "";
  let stderr = "";
  let exec;
  try {
    exec = await input.env.exec(
      [process.execPath, helper, request.op, JSON.stringify(request)],
      {
        onOutput: (text, _context, info) => {
          if (info.stream === "stdout") stdout += text;
          else if (stderr.length < 400) stderr += text;
        },
      },
      input.context,
    );
  } catch (error) {
    return failed("exec", error instanceof Error ? error.message : "exec is unavailable");
  }
  if (!exec.ok) return failed("exec", exec.error.message);
  const outcome = parseReply(request.op, stdout);
  if (outcome.kind === "failed" && outcome.message === "the helper printed nothing usable") {
    return failed("io", stderr.trim().split(/\r?\n/)[0] ?? "the helper printed nothing usable");
  }
  return outcome;
}
