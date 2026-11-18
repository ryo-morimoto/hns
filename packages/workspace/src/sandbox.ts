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

/** What a project's exec may reach on the network. */
export type SandboxEgress = "deny" | "inherit" | "allowlist";

/**
 * How the wrapper's mount list and network are built.
 *
 * @remarks
 * The defaults are the shape the workspace's own agent has always used: the root bound over a
 * read-only /, and the host's network. The machine passes `project` and `egress` so the tree
 * is reached through a fresh ROOT and only that project is bound (D095).
 */
export interface SandboxMountOptions {
  /**
   * The tree to keep out of the sandbox, and the project to bind back into it.
   *
   * @remarks
   * A tmpfs hides what is below a path, never the path itself, so the wrapper masks the outermost
   * of `root` and the project's parent and rebuilds the chain below it with empty directories.
   * That is what keeps the siblings of every level out, not just the ones beside `root`.
   * Absolute paths other than "/". Omit for the older shape, where only the root is bound.
   */
  readonly project?: { readonly root: string; readonly projectRoot: string } | undefined;
  /** A directory to bind read-only inside the root, such as `.git`; absolute. */
  readonly readOnlyInside?: readonly string[] | undefined;
  /** `deny` and `allowlist` add `--unshare-net`; `inherit` keeps the host's network. */
  readonly egress?: SandboxEgress | undefined;
  /**
   * The file descriptor numbers bubblewrap should load seccomp filters from.
   *
   * @remarks
   * `--seccomp` takes an **open fd number** and reads it before exec; a path is rejected with
   * "Invalid fd". The descriptor must already be inherited by the process the wrapper spawns, so
   * the caller has to be able to pass one. An environment whose exec only gives the child
   * stdio (the pi-durable/pi-env `exec`) cannot, and must not set this: bwrap would start and
   * every command would fail with "Can't read seccomp data".
   */
  readonly seccomp?: readonly string[] | undefined;
  /** `HOME` inside the sandbox; defaults to the root. Absolute. */
  readonly home?: string | undefined;
}

/** How to wrap exec: which directory is writable, and what to hide. */
export interface SandboxOptions extends SandboxMountOptions {
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
  /**
   * Environment variables passed back after `--clearenv`, read from this process.
   *
   * @remarks
   * `PATH`, `LANG`, and `TERM` are always passed when set; anything else is passed only when
   * it is listed here, and `HOME` and `TMPDIR` are never taken from here. A variable that is
   * listed but unset is simply not passed. Use {@link SandboxOptions.envValues} for values the
   * sandbox itself should fix rather than copy from the server.
   */
  readonly env?: readonly string[] | undefined;
  /**
   * Environment values the sandbox sets, whatever this process has.
   *
   * @remarks
   * These are the sandbox's own settings (`TMPDIR=/tmp`, git switches pointing at /dev/null), so
   * they are written out rather than read from the server's environment: a server that happened
   * to carry `GIT_CONFIG_GLOBAL` must not be able to redirect them. `HOME` is refused here
   * because the wrapper sets it to the sandbox home.
   */
  readonly envValues?: Readonly<Record<string, string>> | undefined;
}

/**
 * The variable names a sandboxed shell gets besides `HOME` / `TMPDIR`.
 *
 * @remarks
 * These are read from the server's environment and passed only when set, so a host without
 * `TERM` does not grow an empty one. The list is the allowlist: no key, token, or URL crosses.
 */
const PASSED_ENV = ["PATH", "LANG", "TERM"] as const;

/** Whether a name is already passed by the fixed part of the allowlist. */
const isPassed = (name: string): boolean => PASSED_ENV.some((passed) => passed === name);

/**
 * A directory to mask with tmpfs.
 *
 * @remarks
 * Every requested path is kept so the /tmp decision can see what must stay visible; the wrapper
 * mounts only the ones the host has (a missing path cannot be a tmpfs over a read-only parent).
 */
interface Hide {
  readonly path: string;
}

/**
 * An environment whose exec runs under bubblewrap, with the root writable and the host read-only.
 *
 * @param env - The environment whose file API is kept; only exec is wrapped.
 * @param options - The root to make writable and the paths to mask.
 * @returns An environment that runs every exec through the wrapper.
 * @throws {Error} When `options.root` is not absolute or is "/", when a hidden
 * path is not absolute, is "/", or is the root itself, when `options.home` is not
 * absolute, or when a bound project or read-only path is not below the root.
 *
 * @remarks
 * The wrapper read-only binds / and then binds the root over it, so the host's
 * paths are read-only. With `options.project`, a tmpfs replaces the outermost directory covering
 * the project, so nothing beside it at any level is in the sandbox, and only the project is bound
 * back in.
 * `--clearenv` drops the server's environment (keys, tokens); only PATH, LANG, TERM, HOME
 * (the root by default), and the names in `options.env` are set. `options.hide` is mounted
 * as tmpfs after the writable bind, so it shadows the real directory. A cwd outside the
 * root is replaced by the root. `deny` and `allowlist` egress add `--unshare-net`; every
 * wrapper gets `--new-session`, so the terminal's TIOCSTI cannot type into the server.
 */
export function createSandboxEnv(env: ExecutionEnv, options: SandboxOptions): ExecutionEnv {
  const root = options.root;
  if (!root.startsWith("/") || root === "/") {
    throw new Error("the sandbox root must be an absolute path other than /");
  }
  const bwrap = options.bwrap ?? process.env.BWRAP ?? "bwrap";
  const shell = options.shell ?? resolveShell();
  const home = options.home ?? root;
  if (!home.startsWith("/")) throw new Error("the sandbox home must be an absolute path");
  const underRoot = (path: string): boolean => isUnder(root, path);
  const project = options.project;
  let masked: string | undefined;
  if (project !== undefined) {
    if (!project.root.startsWith("/") || project.root === "/") {
      throw new Error("the sandbox project root must be an absolute path other than /");
    }
    if (!project.projectRoot.startsWith("/") || project.projectRoot === "/") {
      throw new Error("the bound project must be an absolute path other than /");
    }
    // A tmpfs hides what is *below* the path it is mounted on, never the path itself, and an
    // ancestor stays readable through its own parent. Masking the project, or the project's
    // parent alone, therefore leaves a sibling of any *ancestor* visible (measured: a project at
    // ROOT/a/b/proj still read ROOT/a/other). Masking this much and rebuilding the chain below it
    // with empty directories is what closes it: the outermost path is the caller's root when the
    // project is inside it, and the parent otherwise.
    masked = isUnder(project.root, project.projectRoot)
      ? project.root
      : parentOf(project.projectRoot);
    if (!isUnder(project.root, project.projectRoot) && !isUnder(project.projectRoot, root)) {
      throw new Error("the bound project must be inside its root or contain the sandbox root");
    }
  }
  const hidden: Hide[] = [];
  for (const path of options.hide ?? []) {
    if (!path.startsWith("/") || path === "/") {
      throw new Error("a hidden path must be absolute and not /");
    }
    // Every path is recorded, so the /tmp decision below knows what must stay visible; only the
    // ones the host actually has are mounted (see the wrapper: an absent path cannot be a tmpfs
    // over a read-only parent, and an absent path holds nothing to mask).
    hidden.push({ path });
  }
  for (const path of options.readOnlyInside ?? []) {
    if (!path.startsWith("/") || !underRoot(path) || path === root) {
      throw new Error("a read-only path must be below the root");
    }
  }
  // A hide under `/tmp` needs /tmp left alone: masking /tmp detaches every mount made below it,
  // and the hide would look applied while the real directory stayed visible.
  const tmpfsTmp = !root.startsWith("/tmp/") && !hidden.some((hide) => isUnder("/tmp", hide.path));
  const extra = options.env ?? [];
  const values = options.envValues ?? {};
  for (const name of Object.keys(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
      throw new Error("an environment name is not a name");
  }
  const egress = options.egress ?? "inherit";

  const wrap = (
    command: string | readonly string[],
    execOptions: ShellExecOptions | undefined,
  ): readonly string[] => {
    const requested = execOptions?.cwd ?? env.cwd;
    const cwd = underRoot(requested) ? requested : root;
    // The read-only host first: every path starts closed, and what follows re-opens a part of it.
    const args = ["--die-with-parent", "--ro-bind", "/", "/"];
    if (project === undefined || masked === undefined) {
      args.push("--bind", root, root);
    } else {
      // The parent gets a fresh tmpfs, so nothing beside the project is in the sandbox at all;
      // the project is then bound writable back into it.
      args.push("--tmpfs", masked);
      for (const dir of ancestorsBetween(masked, project.projectRoot)) args.push("--dir", dir);
      args.push("--bind", project.projectRoot, project.projectRoot);
    }
    // `.git` is read-only inside the project (D095): overlaying it after the writable bind means
    // even a shell cannot write there, and a work tree's `.git` file is bound the same way.
    for (const path of options.readOnlyInside ?? []) args.push("--ro-bind", path, path);
    // It goes before every mount below it: mounting a parent after a child detaches the child.
    if (tmpfsTmp) args.push("--tmpfs", "/tmp");
    // Masked paths are mounted after everything they sit under, so nothing detached them since.
    // A path the host does not have is skipped: bwrap cannot create a tmpfs over a name that is
    // not there when its parent is read-only, and the whole sandbox would then fail to start.
    for (const hide of hidden) {
      if (existsSync(hide.path)) args.push("--tmpfs", hide.path);
    }
    args.push("--dev", "/dev", "--proc", "/proc");
    // Drop the server's environment (keys, tokens) and pass back only the allowlist.
    args.push("--clearenv", "--setenv", "PATH", process.env.PATH ?? "/usr/bin:/bin");
    args.push("--setenv", "HOME", home);
    for (const name of PASSED_ENV.slice(1)) {
      const value = process.env[name];
      if (value !== undefined) args.push("--setenv", name, value);
    }
    // Extra names never override the ones above: HOME is the sandbox's, and a name already passed
    // is not passed twice.
    for (const name of extra) {
      if (name === "HOME" || isPassed(name)) continue;
      const value = process.env[name];
      if (value !== undefined) args.push("--setenv", name, value);
    }
    // The sandbox's own values come last so they win over anything above with the same name.
    for (const [name, value] of Object.entries(values)) {
      if (name === "HOME")
        throw new Error("the sandbox home is set by the wrapper, not by envValues");
      args.push("--setenv", name, value);
    }
    args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session");
    // `allowlist` has no proxy in v1, so it is denied rather than pretended (D095).
    if (egress !== "inherit") args.push("--unshare-net");
    for (const fd of options.seccomp ?? []) args.push("--seccomp", fd);
    args.push("--chdir", cwd, "--");
    const argv = Array.isArray(command) ? [...command] : [shell, "-c", command];
    return [bwrap, ...args, ...argv];
  };

  return new SandboxEnv(env, wrap);
}

/**
 * Whether a path is a directory's own path or lies below it.
 *
 * @param directory - An absolute directory path.
 * @param path - An absolute path.
 * @returns True for `directory` itself and for anything under `directory/`.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(isUnder("/tmp", "/tmp/a")).toBe(true);
 * expect(isUnder("/tmp", "/tmp")).toBe(true);
 * expect(isUnder("/tmp", "/tmpx")).toBe(false);
 * ```
 */
export function isUnder(directory: string, path: string): boolean {
  const prefix = directory.endsWith("/") ? directory : directory + "/";
  return path === directory || path.startsWith(prefix);
}

/**
 * The directory that contains a path.
 *
 * @param path - An absolute path other than "/".
 * @returns Its parent, or "/" when the path is directly under the root.
 */
export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/**
 * The directories between two nested paths that a tmpfs at the outer one does not create.
 *
 * @param outer - An ancestor directory.
 * @param inner - A path strictly below `outer`.
 * @returns Each missing ancestor from just below `outer` down to `inner`'s parent.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(ancestorsBetween("/a", "/a/b/c")).toStrictEqual(["/a/b"]);
 * expect(ancestorsBetween("/a", "/a/b")).toStrictEqual([]);
 * ```
 */
export function ancestorsBetween(outer: string, inner: string): readonly string[] {
  const parts = inner.slice(outer.length).split("/").filter(Boolean);
  const created: string[] = [];
  let current = outer;
  // The last part is the project itself, which --bind creates; its ancestors need --dir.
  for (const part of parts.slice(0, -1)) {
    current = current + "/" + part;
    created.push(current);
  }
  return created;
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
