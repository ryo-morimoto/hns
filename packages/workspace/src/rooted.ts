import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { parseReply } from "./protocol.ts";
import type { HelperBase, HelperOutcome, HelperRequest } from "./protocol.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));

/** The helper that sits next to this module: .ts in the source tree, .js in dist. */
function helperPath(): string | undefined {
  for (const name of ["rooted-helper.ts", "rooted-helper.js"]) {
    const found = join(HERE, name);
    if (existsSync(found)) return found;
  }
  return undefined;
}

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

  /** Hold the root for the life of the workspace, or nothing when the probe fails. */
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

  hash(path: readonly string[]): Promise<HelperOutcome> {
    return this.#call({ ...this.#base(), op: "hash", path });
  }

  read(path: readonly string[]): Promise<HelperOutcome> {
    return this.#call({ ...this.#base(), op: "read", path });
  }

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
