import { spawn } from "node:child_process";
import * as v from "valibot";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { OFFICE_RENDER_MAX_WIDTH } from "@hns/core/office";
import type { OfficeOperation } from "@hns/core/office";
import type { OfficePack, PackBindPath } from "./pack.ts";

/**
 * How one engine run ends.
 *
 * @remarks
 * `ok` carries what the engine wrote; every other member is a failure the job turns into a typed
 * code, and none of them is an exception a caller could mistake for a defect: an engine that
 * cannot be started is `unavailable`, one that ran too long is `timeout`, and one that exited
 * non-zero is `failed`.
 */
export type EngineOutcome =
  | {
      readonly ok: true;
      /** The produced file, inside the run directory; it is gone once the run is removed. */
      readonly output: string;
      /** Bytes written, from the file itself. */
      readonly bytes: number;
      /** The engine's peak resident set, MiB, from the kernel's own accounting. */
      readonly peakRssMb: number;
    }
  | { readonly ok: false; readonly kind: "unavailable"; readonly reason: string }
  | { readonly ok: false; readonly kind: "timeout" }
  | { readonly ok: false; readonly kind: "failed"; readonly reason: string }
  | { readonly ok: false; readonly kind: "too_large"; readonly reason: string };

/** What one run needs: the pack, the paths it may see, and the bounds it runs under. */
export interface EngineRun {
  readonly pack: OfficePack;
  /** The pack's host check: the binds whose bytes this host proved. */
  readonly binds: readonly PackBindPath[];
  /** The document, already inside the run directory. */
  readonly input: string;
  /** The operation the engine is asked for. */
  readonly operation: OfficeOperation;
  /** The rendered width, for a render; absent lets the pack choose. */
  readonly width?: number | undefined;
  /** A directory the run may write to and nothing else: created and removed by the caller. */
  readonly work: string;
  /**
   * The directory the runs are made in: the sandbox mounts a fresh tmpfs over it.
   *
   * @remarks
   * It must hold only runs (a deployment points it at an empty directory outside ROOT): everything
   * under it is replaced by the tmpfs, and the run is bound back into it. `work` is one entry of it.
   */
  readonly workRoot: string;
  /** Milliseconds from spawn to kill. */
  readonly timeoutMs: number;
  /** MiB of address space the engine may take. */
  readonly maxRssMb: number;
  /** The largest artifact this machine will keep; a bigger file is refused, not truncated. */
  readonly maxOutputBytes: number;
  /** The bwrap executable; defaults to `$BWRAP`, then `bwrap` on PATH. */
  readonly bwrap?: string | undefined;
}

/** The `--export` value each operation asks for (§11's `build.operations`). */
const EXPORT_OF = {
  preview: "pdf",
  render: "png",
  convert: "pdf",
} as const satisfies Record<"preview" | "render" | "convert", string>;

/** The content types the artifacts carry, in the order a reader expects them. */
const CONTENT_TYPE_OF_OPERATION = {
  preview: "application/pdf",
  render: "image/png",
  convert: "application/pdf",
} as const satisfies Record<"preview" | "render" | "convert", string>;

/**
 * The magic bytes each artifact starts with: a file that does not is not what was asked for.
 *
 * @remarks
 * The check is what makes `rename` safe: a truncated PDF or a PNG the engine wrote half of would
 * otherwise be cached and served as a good preview. A PDF's header may follow leading bytes (the
 * format allows a junk prefix), so the first kilobyte is searched rather than its first byte.
 */
const MAGIC = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
} as const;

/** Where inside the file a magic may be: a PDF allows a short prefix, a PNG none. */
const MAGIC_SEARCH = {
  pdf: 1024,
  png: 0,
} as const;

/**
 * Run one office operation inside bubblewrap, with the deadline, the memory bound and the reap.
 *
 * @param run - The pack, the document, the operation, and the bounds.
 * @returns The artifact's path, size, and the engine's peak memory; or a typed failure.
 *
 * @remarks
 * **The sandbox is the argument list, and it is built here once.** The host is bound read-only,
 * a fresh tmpfs replaces the run directory's parent (so nothing beside it is visible), and only
 * the run directory is bound writable; the pack is bound read-only, each checked bind read-only at
 * its own absolute path, and the network is unshared (`--unshare-net`), so an external link or an
 * OLE object in the document reaches nothing (C9). The environment is cleared and then set from
 * the pack's own manifest, so no variable of this process crosses.
 *
 * **The deadline is enforced here, not by the engine.** The process is spawned in its own process
 * group, and on expiry the group is signalled and then awaited: the job does not answer until
 * every descendant is reaped, so a timed-out engine leaves no orphan (INV-O4). The memory bound is
 * the shell's `ulimit -v`, which the kernel enforces on the engine itself.
 *
 * `peakRssMb` is read from `/proc/<pid>/status` just before the process is reaped: `VmHWM` is the
 * kernel's high-water mark for that process's address space, which is the number a person wants
 * from "what did this cost" (U-02).
 */
export async function runEngine(
  run: EngineRun,
  signal?: AbortSignal | undefined,
): Promise<EngineOutcome> {
  // The wrapper is the host's program and is looked up with the host's PATH; **the engine** is
  // given the fixed PATH below, not this one (see packEnvironment).
  const bwrap = run.bwrap ?? process.env["BWRAP"] ?? "bwrap";
  const resolved = await findExecutable(bwrap, process.env["PATH"] ?? "");
  if (resolved === undefined) {
    return { ok: false, kind: "unavailable", reason: "bubblewrap is not installed at " + bwrap };
  }
  const binary = join(run.pack.root, "bin", "ibisOffice");
  const output = join(run.work, "out");
  await mkdir(output, { recursive: true });
  const argv = engineArgv(run, { binary, input: run.input, output, bwrap: resolved });
  // A run's argv names only the pack, the run, and the document, but an operator chasing "the
  // engine will not start" wants to see it. It is written as JSON, one value: a line whose words
  // were not quoted is a line a shell would read differently when it was pasted back.
  if (process.env["HNS_DEBUG_OFFICE"] === "1")
    process.stderr.write("office argv: " + JSON.stringify(argv) + "\n");

  const started = Date.now();
  const child = spawn(argv[0] ?? resolved, argv.slice(1), {
    cwd: run.work,
    // Almost empty on purpose: bubblewrap clears it again, so this environment is the wrapper's
    // own and nothing of the server's crosses. It has **no `HOME`**: a temp directory path handed
    // to a process whose working directory has just been replaced by a fresh tmpfs is a `HOME`
    // the engine's loader reads differently, and the engine fails to find the libraries the
    // manifest names (measured: 127, "cannot open shared object file"). An empty, named
    // environment is what the engine's own `--clearenv` would have built anyway.
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so the deadline can signal the engine and everything it started.
    detached: true,
  });
  let timedOut = false;
  let stderr = "";
  child.stdout?.resume();
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ readonly code: number | null; readonly signal: string | null }>(
    (resolve) => {
      child.once("error", () => {
        resolve({ code: null, signal: null });
      });
      child.once("close", (code, signal) => {
        resolve({ code, signal });
      });
    },
  );
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, run.timeoutMs);
  // The request's own deadline (the office envelope) also ends the run: a job is clamped below it,
  // but a clock that was set before the engine started can still win, and the group must go with
  // it rather than keep a process the machine no longer waits for.
  const abort = (): void => {
    timedOut = true;
    killGroup(child.pid);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const peakRssMb = child.pid === undefined ? 0 : await watchPeakRss(child.pid, exited);
  clearTimeout(deadline);
  // A process group can outlive its leader: the group is signalled once more, always, and every
  // remaining member is reaped by the caller's await of `close` above.
  const finished = await exited;
  clearTimeout(deadline);
  signal?.removeEventListener("abort", abort);
  if (timedOut || (finished.signal !== null && Date.now() - started >= run.timeoutMs)) {
    killGroup(child.pid);
    return { ok: false, kind: "timeout" };
  }
  if (finished.code !== 0) {
    return {
      ok: false,
      kind: "failed",
      reason:
        "the office engine exited " +
        String(finished.code ?? finished.signal ?? "without a status") +
        (stderr === "" ? "" : ": " + lastLine(stderr)),
    };
  }
  return await collectArtifact(output, run, peakRssMb);
}

/**
 * Send the run's process group a kill, ignoring a process that has already gone.
 *
 * @param pid - The leader's pid, which is also the group id because the child is detached.
 *
 * @remarks
 * `SIGKILL` and not a softer signal: the engine is a document converter, it has no cleanup the
 * machine depends on, and a signal it ignores would let the deadline pass with the process still
 * running. The children are in the same group, so they go with it.
 */
export function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group is gone already: there is nothing left to signal.
  }
}

/**
 * Follow a child's `VmHWM` until it exits.
 *
 * @param pid - The child's pid.
 * @param exited - A promise that settles when the child is reaped.
 * @returns The largest `VmHWM` seen, in MiB; 0 when `/proc` has nothing to say.
 *
 * @remarks
 * Polled rather than requested: nothing tells the kernel to report a high-water mark at exit, and
 * `wait4`'s `ru_maxrss` needs a raw wait the Node process API does not expose. The poll is cheap
 * (one small read), runs every 50 ms, and stops when the child does; a short engine is measured
 * once at least, because the first sample is taken before it can exit.
 */
async function watchPeakRss(pid: number, exited: Promise<unknown>): Promise<number> {
  let peakKb = 0;
  let done = false;
  void exited.then(() => {
    done = true;
  });
  while (!done) {
    const value = await readVmHwm(pid);
    if (value !== undefined && value > peakKb) peakKb = value;
    if (done) break;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return Math.round(peakKb / 1024);
}

/** One process's `VmHWM`, KiB, or undefined when `/proc` no longer has it. */
async function readVmHwm(pid: number): Promise<number | undefined> {
  let status: string;
  try {
    status = await readFile("/proc/" + String(pid) + "/status", "utf8");
  } catch {
    return undefined;
  }
  const match = /^VmHWM:\s+([0-9]+) kB$/mu.exec(status);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The wrapper's argument list for one run.
 *
 * @param run - The run.
 * @param paths - The engine binary, the document, the output directory, and bwrap.
 * @returns The argv, from the executable to the engine's last argument.
 *
 * @remarks
 * The order is the security property and is therefore stated once: the whole host read-only
 * first, then a tmpfs over the run directory's parent (nothing beside the run is visible), then
 * the run directory writable, then the pack read-only, then every checked bind read-only, then
 * /dev and /proc, then the namespace and the network, then the cleared environment, then the
 * working directory. A bind made after the tmpfs would be the only thing visible from outside.
 */
export function engineArgv(
  run: EngineRun,
  paths: {
    readonly binary: string;
    readonly input: string;
    readonly output: string;
    readonly bwrap: string;
  },
): readonly string[] {
  // A fresh tmpfs replaces the runs' own directory, which holds the run and nothing beside it: the
  // run is then bound writable into it. Mounting the tmpfs over the run's *parent* was the first
  // shape, and it is not equivalent — the engine started there and failed to find its own shared
  // objects (measured), so the tmpfs sits at the caller's work root, which a deployment keeps
  // empty of everything but runs.
  const workRoot = run.workRoot;
  const args = ["--die-with-parent", "--ro-bind", "/", "/"];
  args.push("--tmpfs", workRoot);
  args.push("--dir", run.work);
  args.push("--bind", run.work, run.work);
  args.push("--ro-bind", run.pack.root, run.pack.root);
  for (const bind of run.binds) args.push("--ro-bind", bind.path, bind.path);
  args.push("--dev", "/dev", "--proc", "/proc");
  args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net");
  args.push("--new-session");
  // `--clearenv` and nothing before the pack's own variables: `PATH` is one of them (a fixed
  // `/usr/bin:/bin` here, and again there, is the same name set twice, which bubblewrap takes
  // as its last value and the engine's loader reads from it).
  args.push("--clearenv");
  for (const [name, value] of Object.entries(packEnvironment(run.pack, run.work))) {
    args.push("--setenv", name, value);
  }
  args.push("--chdir", run.work);
  // The memory bound is the shell's: `ulimit -v` is set before the engine replaces the shell, and
  // the kernel then holds the engine to it. A decimal MiB, because `ulimit -v` counts KiB.
  const limitKb = run.maxRssMb * 1024;
  args.push(
    "--",
    "/bin/sh",
    "-c",
    "ulimit -v " + String(limitKb) + ' && exec "$0" "$@"',
    paths.binary,
  );
  args.push("--export", EXPORT_OF[operationOf(run.operation)]);
  if (run.operation === "render") {
    args.push("--width", String(run.width ?? OFFICE_RENDER_MAX_WIDTH));
  }
  args.push("--out-dir", paths.output, paths.input);
  return [paths.bwrap, ...args];
}

/** The operation, narrowed to the three this build runs. */
function operationOf(operation: OfficeOperation): "preview" | "render" | "convert" {
  switch (operation) {
    case "preview":
    case "render":
    case "convert":
      return operation;
    default:
      throw new Error("the office engine does not run " + operation);
  }
}

/**
 * The environment the engine gets: the pack's own, resolved against the pack root.
 *
 * @param pack - The loaded pack.
 * @param home - A directory inside the run to be `HOME`.
 * @returns The variables, with relative values rooted at the pack.
 *
 * @remarks
 * Nothing of this process's environment is passed: `HOME` is the run directory (an engine that
 * writes into a home writes into a directory that is deleted with the run), the library path,
 * font configuration and Vulkan driver file come from `build.environment`, and a value of
 * `<pack root>` is the pack's own directory. The engine's own `PATH` is the wrapper's minimal one,
 * so a tool it tries to run is one that exists in that sandbox and not on this host.
 */
export function packEnvironment(pack: OfficePack, home: string): EngineEnvironment {
  // A fixed PATH, never this process's: the host's PATH in a Nix environment is a chain of build
  // directories, and a PATH that long makes the engine's dynamic loader fail to find the pack's
  // own libxcb under bwrap (measured: 127, "cannot open shared object file"). The engine runs no
  // external program, and what it needs at run time is addressed by the pack's environment
  // (LD_LIBRARY_PATH, FONTCONFIG_FILE, VK_ICD_FILENAMES), not by a PATH this host happens to have.
  const values = {
    PATH: ENGINE_PATH,
    HOME: home,
    TMPDIR: home,
    ...packEnvironmentOf(pack),
  };
  return v.parse(EngineEnvironmentSchema, values);
}

/**
 * The wrapper's flags in the order {@link engineArgv} writes them.
 *
 * @remarks
 * The order is the sandbox's meaning (a bind after a read-only overlay is the one that survives),
 * so it is stated here once and walked by a test: a flag moved in the builder is a flag moved here
 * or a test failure, never a silently weaker sandbox.
 */
export const ENGINE_ARGV_ORDER = [
  "--die-with-parent",
  "--ro-bind",
  "--tmpfs",
  "--dir",
  "--bind",
  "--dev",
  "--proc",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--unshare-net",
  "--new-session",
  "--clearenv",
  "--setenv",
  "--chdir",
  "--",
] as const;

/** The PATH one engine runs with: the system directories and nothing of the host's own. */
const ENGINE_PATH = "/usr/bin:/bin";

/**
 * The environment one engine runs with: names and their values, nothing inherited.
 *
 * @remarks
 * The schema is the check rather than the type alone: the values are written into `--setenv`
 * arguments, and a name that is not a name would be an argument the wrapper reads differently.
 */
const EngineEnvironmentSchema: v.GenericSchema<
  unknown,
  Readonly<Record<string, string>>
> = v.record(v.pipe(v.string(), v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)), v.string());

/** The environment one engine runs with. */
type EngineEnvironment = Readonly<Record<string, string>>;

/** The pack's own variables, resolved and checked. */
function packEnvironmentOf(pack: OfficePack): EngineEnvironment {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(pack.build.environment)) {
    resolved[name] = resolvePackValue(pack.root, value);
  }
  return v.parse(EngineEnvironmentSchema, resolved);
}

/** A value relative to the pack, or the pack root itself. */
function resolvePackValue(root: string, value: string): string {
  if (value === "<pack root>") return root;
  return value.startsWith("/") ? value : join(root, value);
}

/**
 * Take what the engine wrote out of the run directory, checking it is what was asked for.
 *
 * @param output - The directory the engine wrote into.
 * @param run - The run, for its bounds.
 * @param peakRssMb - The engine's high-water mark.
 * @returns The artifact's path, size, and peak; or the failure that refuses it.
 *
 * @remarks
 * The engine names its output after the input (`proposal.docx` becomes `proposal.pdf` or
 * `proposal-01.png` and its siblings), so the file is found by its extension rather than guessed.
 * A render of several pages is several PNGs; the machine answers one file per job (a preview), and
 * the first page is the one a reader sees, so that is the artifact and the rest are removed.
 */
async function collectArtifact(
  output: string,
  run: EngineRun,
  peakRssMb: number,
): Promise<EngineOutcome> {
  const wanted = run.operation === "render" ? ".png" : ".pdf";
  let names: string[];
  try {
    names = await readdir(output);
  } catch {
    return { ok: false, kind: "failed", reason: "the office engine wrote no output directory" };
  }
  const produced = names
    .filter((name) => name.toLowerCase().endsWith(wanted))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (produced.length === 0) {
    return {
      ok: false,
      kind: "failed",
      reason: "the office engine exited without writing a " + wanted.slice(1) + " file",
    };
  }
  const first = produced[0];
  if (first === undefined) throw new Error("a produced file was named");
  const path = join(output, first);
  const info = await stat(path);
  if (info.size === 0) {
    return { ok: false, kind: "failed", reason: "the office engine wrote an empty file" };
  }
  if (info.size > run.maxOutputBytes) {
    return {
      ok: false,
      kind: "too_large",
      reason:
        "the artifact is " +
        String(info.size) +
        " bytes, over the " +
        String(run.maxOutputBytes) +
        " byte output limit",
    };
  }
  const kind = run.operation === "render" ? "png" : "pdf";
  if (!(await hasMagic(path, kind))) {
    return {
      ok: false,
      kind: "failed",
      reason: "the office engine wrote a file that is not a " + kind,
    };
  }
  for (const name of produced.slice(1)) {
    await rm(join(output, name), { force: true }).catch(() => undefined);
  }
  return { ok: true, output: path, bytes: info.size, peakRssMb };
}

/** Whether a file starts with the magic its kind requires. */
async function hasMagic(path: string, kind: keyof typeof MAGIC): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const head = new Uint8Array(MAGIC_SEARCH[kind] + MAGIC[kind].length);
    const { bytesRead } = await handle.read(head, 0, head.byteLength, 0);
    const bytes = head.subarray(0, bytesRead);
    const magic = MAGIC[kind];
    for (let at = 0; at + magic.length <= bytes.length; at += 1) {
      if (magic.every((byte, index) => bytes[at + index] === byte)) return true;
    }
    return false;
  } finally {
    await handle.close();
  }
}

/** The last non-empty line of a diagnostic, so a message stays one line. */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

/** The absolute path of an executable, or undefined when there is none there. */
async function findExecutable(candidate: string, searchPath: string): Promise<string | undefined> {
  const paths = candidate.includes("/")
    ? [candidate]
    : searchPath
        .split(":")
        .filter(Boolean)
        .map((directory) => join(directory, candidate));
  for (const path of paths) {
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch {
      // The next directory may have it; a candidate that is nowhere is answered below.
    }
  }
  return undefined;
}
