// An ExecutionEnv whose exec() runs inside bubblewrap with only the root
// writable. Whether exec is offered at all is decided by detectSandbox()
// before startup; see docs/workspace.md and docs/safety.md.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, ExecutionError } from "@earendil-works/pi-durable/env";
import type {
  ExecutionEnv,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { ForwardingEnv } from "./env.ts";

/** A probe that hangs is a failure, not something to wait on: detection has a budget. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Every code a failed detection can report, in the order the checks run.
 *
 * @remarks
 * The list is closed so a consumer can switch on it. Only the first failing
 * check is reported; the later ones are not attempted.
 */
export const SANDBOX_CODES = [
  "unsupported-platform",
  "not-found",
  "not-executable",
  "version-failed",
  "userns-unavailable",
  "shell-missing",
  "smoke-test-failed",
] as const;
/** The first check that failed, as a code a consumer can branch on. */
export type SandboxCode = (typeof SANDBOX_CODES)[number];

/**
 * What the probe learned about unprivileged user namespaces.
 *
 * @remarks
 * "ok" means the namespaces actually worked in the probe, not just that the
 * sysctls looked right. "blocked" means the wrapper reported a namespace or
 * uid-map failure. "unknown" covers every other failure, including checks that
 * never reached the probe.
 */
export type UserNamespaces = "ok" | "blocked" | "unknown";

/**
 * Kernel switches that commonly turn unprivileged user namespaces off.
 *
 * @remarks
 * Values are read from /proc/sys and are `undefined` when the file is absent or
 * unreadable, which is normal on kernels without that switch. They are reported
 * for diagnosis; the probe, not these values, decides availability.
 */
export interface UsernsSysctls {
  /** Maximum number of user namespaces, from /proc/sys/user/max_user_namespaces. */
  readonly maxUserNamespaces: number | undefined;
  /** 1 when unprivileged user namespaces are enabled (Debian/Ubuntu sysctl). */
  readonly unprivilegedUsernsClone: number | undefined;
  /** 1 when AppArmor restricts unprivileged user namespaces (Ubuntu sysctl). */
  readonly apparmorRestrictUnprivilegedUserns: number | undefined;
}

/** The fields every report carries, whether or not exec is offered. */
interface SandboxBase {
  readonly backend: "bubblewrap";
  readonly platform: string;
  /** The host shell, so it also exists after the wrapper's read-only bind of /. */
  readonly shell: string;
  /** ISO 8601 (UTC). */
  readonly checkedAt: string;
}

/**
 * Exec can be offered: the probe ran the wrapper against a temporary root.
 *
 * @remarks
 * `userNamespaces` is "ok" because the probe succeeded, not because a sysctl
 * looked right. `version` is reported for diagnosis; no minimum is enforced,
 * since the probe is what proves the wrapper works.
 */
export interface SandboxReady extends SandboxBase {
  readonly available: true;
  readonly exec: "enabled";
  readonly bwrap: string;
  readonly version: string;
  readonly userNamespaces: "ok";
  readonly sysctls: UsernsSysctls;
}

/**
 * Exec cannot be offered. The first check that failed is named by code and reason.
 *
 * @remarks
 * `version` and `sysctls` are present only when detection reached that check, so
 * their absence means "not learned", not "the host lacks bwrap".
 */
export interface SandboxUnavailable extends SandboxBase {
  readonly available: false;
  readonly exec: "disabled";
  readonly bwrap: string;
  readonly version?: string | undefined;
  readonly userNamespaces: UserNamespaces;
  readonly sysctls?: UsernsSysctls | undefined;
  readonly code: SandboxCode;
  readonly reason: string;
}

/** The health probe's sandbox field: branch on `available`, not on a message. */
export type SandboxReport = SandboxReady | SandboxUnavailable;

/**
 * A shell that exists on the host, so it also exists after --ro-bind /.
 *
 * @returns An absolute shell path, or "sh" when none of the candidates exists.
 *
 * @remarks
 * The probe and the wrapper must agree on the shell, or detection would pass
 * where exec later fails; both call this. An environment with none of those
 * absolute paths falls back to "sh", which resolves on PATH; the failure then
 * surfaces as a typed exec error instead of making detection throw.
 */
export function resolveShell(): string {
  const candidates = ["/bin/sh", "/usr/bin/sh", process.env.SHELL];
  for (const shell of candidates) {
    if (shell !== undefined && shell.startsWith("/") && existsSync(shell)) return shell;
  }
  return "sh";
}

/**
 * Resolve bwrap from an explicit path or PATH without shelling out to which(1).
 *
 * @param candidate - An explicit path, or a name to look up on PATH; an empty
 * string means "bwrap".
 * @returns The first executable path found, or undefined when none is.
 * @throws {Error} When an access check fails for an errno other than ENOENT or
 * EACCES, so an unexplained failure is not reported as "not found".
 *
 * @remarks
 * The PATH lookup is done here rather than through a shell, because detection
 * must not depend on the shell it is trying to verify.
 */
export function findBwrap(candidate: string = process.env.BWRAP ?? "bwrap"): string | undefined {
  const target = candidate === "" ? "bwrap" : candidate;
  const paths = target.includes("/")
    ? [target]
    : (process.env.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((directory) => resolve(directory, target));
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const errno = errnoOf(error);
      if (errno !== "ENOENT" && errno !== "EACCES") throw error;
    }
  }
  return undefined;
}

/**
 * Parse "bubblewrap 0.12.0" (or a bare "0.12.0") into a tuple.
 *
 * @param text - The output of `bwrap --version`, or any text naming a version.
 * @returns `[major, minor, patch]`, or undefined when the text has no three-part
 * version. Numbers are not range-checked; detection uses the value for reporting
 * and relies on the probe for proof.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(parseVersion("bubblewrap 0.12.0")).toEqual([0, 12, 0]);
 * expect(parseVersion("bubblewrap")).toBeUndefined();
 * ```
 */
export function parseVersion(text: string): readonly [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return [Number(major), Number(minor), Number(patch)];
}

/** The first check that failed, and what it saw. */
interface SandboxFailure {
  readonly code: SandboxCode;
  readonly reason: string;
}

/** One finished child process, with its error rendered as text. */
interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** The spawn or exit error message; empty when `ok`. */
  readonly failure: string;
}

/**
 * Run a probe command and collect its output, never rejecting.
 *
 * @param command - The executable to run.
 * @param args - Its arguments.
 * @returns The outcome; a timeout, a missing binary, and a non-zero exit all
 * arrive as `ok: false` so the caller can classify them.
 */
function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((settle) => {
    execFile(
      command,
      [...args],
      { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout, stderr) => {
        settle({
          ok: error === null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          failure: error === null ? "" : error.message,
        });
      },
    );
  });
}

/**
 * The errno a Node error carries, or "" when it is not one.
 *
 * @remarks
 * File system errors reach here as `Error` with an untyped `code`, so the value
 * is read defensively rather than asserted.
 */
function errnoOf(error: Error): string {
  return "code" in error ? String(error.code) : "";
}

/** The first non-blank line, for a reason that fits on one line. */
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * Read one integer sysctl.
 *
 * @returns The value, or undefined when the file is absent or unreadable.
 * @throws {Error} For any other errno, because an unexpected read failure must
 * not be reported as "the switch is absent".
 */
async function readNumber(path: string): Promise<number | undefined> {
  try {
    return Number((await readFile(path, "utf8")).trim());
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const errno = errnoOf(error);
    if (errno === "ENOENT" || errno === "EACCES") return undefined;
    throw error;
  }
}

/** Read the three sysctls that commonly disable user namespaces; all are best effort. */
async function readUsernsSysctls(): Promise<UsernsSysctls> {
  return {
    maxUserNamespaces: await readNumber("/proc/sys/user/max_user_namespaces"),
    unprivilegedUsernsClone: await readNumber("/proc/sys/kernel/unprivileged_userns_clone"),
    apparmorRestrictUnprivilegedUserns: await readNumber(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    ),
  };
}

/**
 * Name the failed check from what the wrapper printed.
 *
 * @returns A code and a one-line reason. Namespace and uid-map messages mean
 * user namespaces are blocked; "execvp" means the shell was missing; anything
 * else is a smoke-test failure, which is still a refusal.
 */
function classifyFailure(result: RunResult): SandboxFailure {
  const text = [result.stderr, result.stdout, result.failure].filter(Boolean).join("\n");
  const line =
    firstLine(result.stderr) ||
    firstLine(result.stdout) ||
    firstLine(result.failure) ||
    "bubblewrap failed";
  if (
    /No permissions to create new namespace|Creating new namespace failed|setting up uid map|setting up gid map/i.test(
      text,
    )
  ) {
    return {
      code: "userns-unavailable",
      reason: "unprivileged user namespaces are unavailable (" + line + ")",
    };
  }
  if (/execvp/i.test(text)) {
    return { code: "shell-missing", reason: "the sandbox could not run its shell (" + line + ")" };
  }
  return { code: "smoke-test-failed", reason: "the sandbox probe failed (" + line + ")" };
}

/**
 * Run the exact wrapper once against a temp root; a version check alone cannot
 * prove user namespaces work.
 *
 * @param bwrap - The executable found by `findBwrap`.
 * @param shell - The shell the wrapper will be given, so the probe tests the
 * same command line exec will use.
 * @returns `ok`, or the classified failure.
 * @throws {Error} When the probe file cannot be read for a reason other than
 * "not found"; the temporary root is removed either way.
 *
 * @remarks
 * The check is a real write: the wrapper must create `probe.txt` under the
 * root. A tmpfs at /tmp would hide a root that lives there, so /tmp is left
 * read-only in that case.
 */
async function probeSandbox(
  bwrap: string,
  shell: string,
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure: { readonly code: SandboxCode; readonly reason: string };
    }
> {
  const root = await mkdtemp(join(tmpdir(), "hns-bwrap-probe-"));
  try {
    const args = [
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      root,
      root,
      "--dev",
      "/dev",
      "--proc",
      "/proc",
    ];
    // A tmpfs at /tmp would hide a root that lives there, so leave /tmp read-only in that case.
    if (!root.startsWith("/tmp/")) args.push("--tmpfs", "/tmp");
    args.push(
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--chdir",
      root,
      "--",
      shell,
      "-c",
      "printf ok > probe.txt",
    );
    const result = await run(bwrap, args);
    if (!result.ok) return { ok: false, failure: classifyFailure(result) };
    let body: string | undefined;
    try {
      body = await readFile(join(root, "probe.txt"), "utf8");
    } catch (error) {
      if (!(error instanceof Error) || errnoOf(error) !== "ENOENT") throw error;
    }
    if (body !== "ok") {
      return {
        ok: false,
        failure: {
          code: "smoke-test-failed",
          reason: "the sandbox did not write a file under its root",
        },
      };
    }
    return { ok: true };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Decide whether exec can be offered on this host. Anything but a clean probe
 * is "unavailable": a check that cannot run is a denial (docs/safety.md).
 *
 * @param candidate - An explicit bwrap path or a name to resolve on PATH;
 * defaults to `$BWRAP` and then `bwrap`.
 * @returns A report whose `available` field branches the caller. When false,
 * `code` names the first check that failed and `reason` says what it saw.
 * @throws {Error} When a probe or sysctl read fails with an unexpected errno.
 * An unexplained failure is never reported as "available".
 *
 * @remarks
 * The checks run in a fixed order -- platform, binary, version, then one probe
 * that covers user namespaces and a smoke test -- because only the first failure
 * is reported. The probe runs the real wrapper against a temporary root and
 * requires it to write a file there; that root is removed on every path.
 */
export async function detectSandbox(
  candidate: string = process.env.BWRAP ?? "bwrap",
): Promise<SandboxReport> {
  const checkedAt = new Date().toISOString();
  const platform = process.platform;
  const shell = resolveShell();
  const unavailable = (
    fields: Omit<SandboxUnavailable, keyof SandboxBase | "available" | "exec">,
  ): SandboxUnavailable => ({
    backend: "bubblewrap",
    platform,
    shell,
    checkedAt,
    available: false,
    exec: "disabled",
    ...fields,
  });

  if (platform !== "linux") {
    return unavailable({
      bwrap: candidate,
      userNamespaces: "unknown",
      code: "unsupported-platform",
      reason: "bubblewrap is Linux only (this host is " + platform + ")",
    });
  }

  const bwrap = findBwrap(candidate);
  if (bwrap === undefined) {
    const pathLike = candidate.includes("/");
    const exists = pathLike && existsSync(candidate);
    return unavailable({
      bwrap: candidate,
      userNamespaces: "unknown",
      code: exists ? "not-executable" : "not-found",
      reason: exists
        ? candidate + " is not executable"
        : pathLike
          ? "bwrap was not found at " + candidate
          : "bwrap was not found on PATH",
    });
  }

  const versionResult = await run(bwrap, ["--version"]);
  if (!versionResult.ok) {
    return unavailable({
      bwrap,
      userNamespaces: "unknown",
      code: "version-failed",
      reason:
        "bubblewrap --version failed (" +
        (firstLine(versionResult.stderr) || firstLine(versionResult.failure)) +
        ")",
    });
  }
  const version = parseVersion(versionResult.stdout);
  if (version === undefined) {
    return unavailable({
      bwrap,
      userNamespaces: "unknown",
      code: "version-failed",
      reason: "cannot read the bubblewrap version (" + firstLine(versionResult.stdout) + ")",
    });
  }

  const sysctls = await readUsernsSysctls();
  const probe = await probeSandbox(bwrap, shell);
  if (!probe.ok) {
    return unavailable({
      bwrap,
      version: version.join("."),
      userNamespaces: probe.failure.code === "userns-unavailable" ? "blocked" : "unknown",
      sysctls,
      ...probe.failure,
    });
  }

  return {
    backend: "bubblewrap",
    platform,
    shell,
    checkedAt,
    available: true,
    exec: "enabled",
    bwrap,
    version: version.join("."),
    userNamespaces: "ok",
    sysctls,
  };
}

/**
 * Thrown when a caller tries to exec although detection refused it.
 *
 * @remarks
 * The message carries only the report's reason; the caller already holds the
 * full report. `code` is always `"sandbox_unavailable"`, so a catch can branch
 * without reading the text.
 */
export class SandboxUnavailableError extends Error {
  readonly code = "sandbox_unavailable";

  constructor(status: SandboxUnavailable) {
    super("exec is unavailable: " + status.reason);
    this.name = "SandboxUnavailableError";
  }
}

/** An environment whose exec refuses, so a caller cannot fall back to the host shell. */
class NoExecEnv extends ForwardingEnv {
  readonly #status: SandboxUnavailable;

  constructor(env: ExecutionEnv, status: SandboxUnavailable) {
    super(env);
    this.#status = status;
  }

  override exec(): Promise<Result<ShellExecResult, ExecutionError>> {
    // A typed failure, not a rejection: callers branch on Result like every other exec.
    return Promise.resolve(
      err(new ExecutionError("shell_unavailable", "exec is unavailable: " + this.#status.reason)),
    );
  }
}

/**
 * Keep the file API, but make every exec fail instead of running outside bubblewrap.
 *
 * @param env - The environment whose file API is kept.
 * @param status - The failed report; its reason becomes the exec error message.
 * @returns An environment that resolves every exec to a typed
 * `shell_unavailable` error.
 *
 * @remarks
 * The failure is a `Result`, not a rejection, so a caller that already branches
 * on `Result` handles "no sandbox" the same way as any other exec failure.
 */
export function createNoExecEnv(env: ExecutionEnv, status: SandboxUnavailable): ExecutionEnv {
  return new NoExecEnv(env, status);
}

/** How to wrap exec: which directory is writable, and what to hide. */
export interface SandboxOptions {
  /** The directory to make writable; absolute and not "/". Other host paths stay read-only. */
  readonly root: string;
  /** The bwrap executable; defaults to `$BWRAP`, then `bwrap` on PATH. */
  readonly bwrap?: string | undefined;
  /** The shell for string commands; defaults to `resolveShell()`. */
  readonly shell?: string | undefined;
  /**
   * Directories to mask with tmpfs, such as the key config directory. Each must
   * be absolute, not "/", and not the root.
   */
  readonly hide?: readonly string[] | undefined;
}

/**
 * An environment whose exec runs under bubblewrap, with the root writable and the host read-only.
 *
 * @param env - The environment whose file API is kept; only exec is wrapped.
 * @param options - The root to make writable and the paths to mask.
 * @returns An environment that runs every exec through the wrapper.
 * @throws {Error} When `options.root` is not absolute or is "/", or when a
 * hidden path is not absolute, is "/", or is the root itself.
 *
 * @remarks
 * The wrapper read-only binds / and then binds the root over it, so the host's
 * paths are read-only. A fresh writable tmpfs is mounted at `/tmp` unless the root
 * lives under it, because masking /tmp would hide the root. `--clearenv` drops the
 * server's environment (keys, tokens); only PATH, HOME (the root), and a few
 * environment variables (locale, TERM, TZ) are passed back. `options.hide` is
 * mounted as tmpfs after the read-only bind, so it shadows the real directory. A
 * cwd outside the root is replaced by the root.
 */
export function createSandboxEnv(env: ExecutionEnv, options: SandboxOptions): ExecutionEnv {
  const root = options.root;
  if (!root.startsWith("/") || root === "/") {
    throw new Error("the sandbox root must be an absolute path other than /");
  }
  const bwrap = options.bwrap ?? process.env.BWRAP ?? "bwrap";
  const shell = options.shell ?? resolveShell();
  const prefix = root.endsWith("/") ? root : root + "/";
  const under = (path: string): boolean => path === root || path.startsWith(prefix);
  const hidden = (options.hide ?? []).map((path) => {
    if (!path.startsWith("/") || path === "/" || path === root) {
      throw new Error("a hidden path must be absolute, not /, and not the root");
    }
    return path;
  });

  const wrap = (
    command: string | readonly string[],
    execOptions: ShellExecOptions | undefined,
  ): readonly string[] => {
    const cwd = under(execOptions?.cwd ?? env.cwd) ? (execOptions?.cwd ?? env.cwd) : root;
    const args = [
      "--die-with-parent",
      "--ro-bind",
      "/",
      "/",
      "--bind",
      root,
      root,
      "--dev",
      "/dev",
      "--proc",
      "/proc",
    ];
    // A tmpfs at /tmp would hide a root that lives there, so leave /tmp read-only in that case.
    if (!root.startsWith("/tmp/")) args.push("--tmpfs", "/tmp");
    // Drop the server's environment (keys, tokens) and pass back only what a shell needs.
    args.push("--clearenv", "--setenv", "PATH", process.env.PATH ?? "/usr/bin:/bin");
    args.push("--setenv", "HOME", root);
    for (const name of ["LANG", "LC_ALL", "TERM", "TZ"]) {
      const value = process.env[name];
      if (value !== undefined) args.push("--setenv", name, value);
    }
    // Masked directories are mounted after the read-only root, so they shadow it.
    for (const path of hidden) args.push("--tmpfs", path);
    args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--chdir", cwd, "--");
    const argv = Array.isArray(command) ? [...command] : [shell, "-c", command];
    return [bwrap, ...args, ...argv];
  };

  return new SandboxEnv(env, wrap);
}

/** An environment whose string and argv execs are rewritten into one wrapper call. */
class SandboxEnv extends ForwardingEnv {
  readonly #wrap: (
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
  ) => readonly string[];

  constructor(
    env: ExecutionEnv,
    wrap: (
      command: string | readonly string[],
      options: ShellExecOptions | undefined,
    ) => readonly string[],
  ) {
    super(env);
    this.#wrap = wrap;
  }

  override exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    return super.exec(this.#wrap(command, options), options, context);
  }
}
