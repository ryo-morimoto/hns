// Building a machine's sandbox in a test: a temporary project, a temporary home with secrets in
// it, and the exact argv the product wrapper would run.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { err, FileError, ok } from "@earendil-works/pi-durable/env";
import type {
  ExecutionEnv,
  ExecutionError,
  FileListing,
  ListFilesOptions,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { detectSandbox } from "@hns/workspace/sandbox";
import type { SandboxReport } from "@hns/workspace/sandbox";
import { createMachineSandboxEnv } from "../../src/sandbox.ts";

/** The probe's verdict for this host, computed once: it spawns bubblewrap. */
let probed: Promise<SandboxReport> | undefined;
export const sandboxReport = (): Promise<SandboxReport> => (probed ??= detectSandbox());

/** Everything one sandbox scenario needs on disk. */
export interface SandboxPaths {
  /** A directory outside the project: its siblings must stay invisible. */
  readonly base: string;
  /** The ROOT the machine serves; the project lives under it. */
  readonly root: string;
  /** The project the shell runs in. */
  readonly project: string;
  /** A home directory with a `~/.config/hns` the shell must not read. */
  readonly home: string;
  /** A file a sibling project holds; it must not be readable from the sandbox. */
  readonly sibling: string;
}

/**
 * Make a base directory whose project and home look like a machine's.
 *
 * @param base - Where to create it; defaults to a fresh directory under the system temp dir.
 * @returns The paths, with the secrets already written.
 *
 * @remarks
 * The base is under the system temp directory, which on a host with a tmpfs /tmp is a real file
 * system the sandbox can bind. The machine's own shapes are what the tests vary, not this.
 */
export async function sandboxPaths(base?: string): Promise<SandboxPaths> {
  const baseDir = base ?? (await mkdtemp(join(tmpdir(), "hns-machine-security-")));
  const root = join(baseDir, "root");
  const project = join(root, "project");
  const home = join(baseDir, "home");
  const brother = join(root, "sibling-project");
  await mkdir(join(home, ".ssh"), { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(brother, { recursive: true });
  await mkdir(join(home, ".config", "hns"), { recursive: true });
  await writeFile(join(home, ".config", "hns", "device.key"), "device-secret");
  await writeFile(join(home, ".config", "hns", "cloudflared"), "cloudflared-secret");
  await writeFile(join(home, ".ssh", "id_ed25519"), "ssh-secret");
  await writeFile(join(brother, "secret.txt"), "sibling-secret");
  await writeFile(join(project, "readme.txt"), "project\n");
  return { base: baseDir, root, project, home, sibling: join(brother, "secret.txt") };
}

/** A host environment rooted at `cwd`; exec is what the sandbox wraps. */
export const hostEnv = (cwd: string): ExecutionEnv => new NodeExecutionEnv({ cwd });

/**
 * Capture the argv the product wrapper builds, without running it.
 *
 * @param options - The same options the machine builder takes, plus the env to wrap.
 * @returns The `bwrap …` argv the wrapper would spawn, in order.
 *
 * @remarks
 * The inner environment's exec is replaced so nothing is spawned: this is how a test states the
 * mount order, which is itself a security property (a bind after the read-only overlay would
 * undo it). The command it receives is the full wrapper command line.
 */
export async function capturedArgv(
  options: Parameters<typeof createMachineSandboxEnv>[1] & { readonly env: ExecutionEnv },
): Promise<readonly string[]> {
  const { env, ...rest } = options;
  const recorder = new CommandRecorder(env);
  const sandbox = createMachineSandboxEnv(recorder, rest);
  // Only the wrapper's own command line is read, so the program never runs; /bin/sh is the one
  // path every Unix host this product targets has.
  await sandbox.exec(["/bin/sh", "-c", ":"], undefined, BACKGROUND_CONTEXT);
  return recorder.command;
}

/**
 * An environment whose exec only records the command it was given.
 *
 * @remarks
 * Every file method is the real one's, so a wrapper that used the file API would still work; only
 * exec is replaced, which is where the wrapper's argv is built. Written as a class because the
 * ExecutionEnv surface is wide and a class makes a forgotten member a compile error.
 */
class CommandRecorder implements ExecutionEnv {
  readonly #inner: ExecutionEnv;
  command: readonly string[] = [];

  constructor(inner: ExecutionEnv) {
    this.#inner = inner;
  }

  get id(): string {
    return this.#inner.id;
  }

  get cwd(): string {
    return this.#inner.cwd;
  }

  set cwd(value: string) {
    this.#inner.cwd = value;
  }

  exec(
    command: string | readonly string[],
    _options: ShellExecOptions | undefined,
    _context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    this.command = Array.isArray(command) ? [...command] : [command];
    return Promise.resolve(ok({ exitCode: 0 }));
  }

  absolutePath(...args: Parameters<ExecutionEnv["absolutePath"]>) {
    return this.#inner.absolutePath(...args);
  }

  joinPath(...args: Parameters<ExecutionEnv["joinPath"]>) {
    return this.#inner.joinPath(...args);
  }

  readTextFile(...args: Parameters<ExecutionEnv["readTextFile"]>) {
    return this.#inner.readTextFile(...args);
  }

  openTextLineReader(...args: Parameters<ExecutionEnv["openTextLineReader"]>) {
    return this.#inner.openTextLineReader(...args);
  }

  readTextLines(...args: Parameters<ExecutionEnv["readTextLines"]>) {
    return this.#inner.readTextLines(...args);
  }

  readBinaryFile(...args: Parameters<ExecutionEnv["readBinaryFile"]>) {
    return this.#inner.readBinaryFile(...args);
  }

  openBinaryReader(...args: Parameters<ExecutionEnv["openBinaryReader"]>) {
    return this.#inner.openBinaryReader(...args);
  }

  writeFile(...args: Parameters<ExecutionEnv["writeFile"]>) {
    return this.#inner.writeFile(...args);
  }

  appendFile(...args: Parameters<ExecutionEnv["appendFile"]>) {
    return this.#inner.appendFile(...args);
  }

  truncateFile(...args: Parameters<ExecutionEnv["truncateFile"]>) {
    return this.#inner.truncateFile(...args);
  }

  flushFile(...args: Parameters<ExecutionEnv["flushFile"]>) {
    return this.#inner.flushFile(...args);
  }

  renameFile(...args: Parameters<ExecutionEnv["renameFile"]>) {
    return this.#inner.renameFile(...args);
  }

  fileInfo(...args: Parameters<ExecutionEnv["fileInfo"]>) {
    return this.#inner.fileInfo(...args);
  }

  listDir(...args: Parameters<ExecutionEnv["listDir"]>) {
    return this.#inner.listDir(...args);
  }

  listFiles(
    path: string,
    options: ListFilesOptions | undefined,
    context: Context,
  ): Promise<Result<FileListing, FileError>> {
    const inner = this.#inner.listFiles;
    if (inner === undefined) {
      return Promise.resolve(err(new FileError("not_supported", "listFiles is unavailable")));
    }
    return inner.call(this.#inner, path, options, context);
  }

  openDirReader(...args: Parameters<ExecutionEnv["openDirReader"]>) {
    return this.#inner.openDirReader(...args);
  }

  watch(...args: Parameters<ExecutionEnv["watch"]>) {
    return this.#inner.watch(...args);
  }

  canonicalPath(...args: Parameters<ExecutionEnv["canonicalPath"]>) {
    return this.#inner.canonicalPath(...args);
  }

  exists(...args: Parameters<ExecutionEnv["exists"]>) {
    return this.#inner.exists(...args);
  }

  createDir(...args: Parameters<ExecutionEnv["createDir"]>) {
    return this.#inner.createDir(...args);
  }

  remove(...args: Parameters<ExecutionEnv["remove"]>) {
    return this.#inner.remove(...args);
  }

  createTempDir(...args: Parameters<ExecutionEnv["createTempDir"]>) {
    return this.#inner.createTempDir(...args);
  }

  createTempFile(...args: Parameters<ExecutionEnv["createTempFile"]>) {
    return this.#inner.createTempFile(...args);
  }

  cleanup(...args: Parameters<ExecutionEnv["cleanup"]>) {
    return this.#inner.cleanup(...args);
  }
}

/** What one command inside bwrap printed and how it exited. */
export interface RunOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run one argv to completion, inheriting nothing from the test's environment but PATH.
 *
 * @param argv - The program and its arguments.
 * @param options - Extra environment variables for the program itself.
 * @returns Status, stdout, and stderr; a non-zero status is the caller's to read.
 *
 * @remarks
 * GIT_* is stripped, per the repository's rule for fixtures that spawn git: a developer's
 * GIT_DIR would otherwise point the command at another repository.
 */
export function runArgv(
  argv: readonly string[],
  options: { readonly env?: Readonly<Record<string, string>> | undefined } = {},
): RunOutcome {
  const passed: Record<string, string> = {};
  for (const name of ["PATH", "LANG", "TERM"]) {
    const value = process.env[name];
    if (value !== undefined) passed[name] = value;
  }
  const env = { ...passed, ...options.env };
  const [program, ...args] = argv;
  if (program === undefined) throw new Error("an argv needs a program");
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 60_000, env });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
