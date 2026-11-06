// An ExecutionEnv whose exec() runs inside bubblewrap with only the root
// writable. Whether exec is offered at all is decided by detectSandbox()
// before startup; see docs/workspace.md and docs/safety.md.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import type {
  ExecutionEnv,
  ExecutionError,
  Result,
  ShellExecOptions,
  ShellExecResult,
} from "@earendil-works/pi-durable/env";
import { ForwardingEnv } from "./env.ts";

const PROBE_TIMEOUT_MS = 5000;

export const SANDBOX_CODES = [
  "unsupported-platform",
  "not-found",
  "not-executable",
  "version-failed",
  "userns-unavailable",
  "shell-missing",
  "smoke-test-failed",
] as const;
export type SandboxCode = (typeof SANDBOX_CODES)[number];

export type UserNamespaces = "ok" | "blocked" | "unknown";

/** Kernel switches that commonly turn unprivileged user namespaces off. */
export interface UsernsSysctls {
  readonly maxUserNamespaces: number | undefined;
  readonly unprivilegedUsernsClone: number | undefined;
  readonly apparmorRestrictUnprivilegedUserns: number | undefined;
}

interface SandboxBase {
  readonly backend: "bubblewrap";
  readonly platform: string;
  readonly shell: string;
  /** ISO 8601 (UTC). */
  readonly checkedAt: string;
}

/** Exec can be offered: the probe ran the wrapper against a temporary root. */
export interface SandboxReady extends SandboxBase {
  readonly available: true;
  readonly exec: "enabled";
  readonly bwrap: string;
  readonly version: string;
  readonly userNamespaces: "ok";
  readonly sysctls: UsernsSysctls;
}

/** Exec cannot be offered. The first check that failed is named by code and reason. */
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

export type SandboxReport = SandboxReady | SandboxUnavailable;

/** A shell that exists on the host, so it also exists after --ro-bind /. */
export function resolveShell(): string {
  const candidates = ["/bin/sh", "/usr/bin/sh", process.env.SHELL];
  for (const shell of candidates) {
    if (shell !== undefined && shell.startsWith("/") && existsSync(shell)) return shell;
  }
  return "sh";
}

/** Resolve bwrap from an explicit path or PATH without shelling out to which(1). */
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

/** Parse "bubblewrap 0.12.0" (or a bare "0.12.0") into a tuple. */
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

interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure: string;
}

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

/** The errno a Node error carries, or "" when it is not one. */
function errnoOf(error: Error): string {
  return "code" in error ? String(error.code) : "";
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

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

async function readUsernsSysctls(): Promise<UsernsSysctls> {
  return {
    maxUserNamespaces: await readNumber("/proc/sys/user/max_user_namespaces"),
    unprivilegedUsernsClone: await readNumber("/proc/sys/kernel/unprivileged_userns_clone"),
    apparmorRestrictUnprivilegedUserns: await readNumber(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
    ),
  };
}

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

/** Run the exact wrapper once against a temp root; a version check alone cannot prove user namespaces work. */
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

/** Thrown when a caller tries to exec although detection refused it. */
export class SandboxUnavailableError extends Error {
  readonly code = "sandbox_unavailable";

  constructor(status: SandboxUnavailable) {
    super("exec is unavailable: " + status.reason);
    this.name = "SandboxUnavailableError";
  }
}

class NoExecEnv extends ForwardingEnv {
  readonly #status: SandboxUnavailable;

  constructor(env: ExecutionEnv, status: SandboxUnavailable) {
    super(env);
    this.#status = status;
  }

  override exec(): Promise<Result<ShellExecResult, ExecutionError>> {
    return Promise.reject(new SandboxUnavailableError(this.#status));
  }
}

/** Keep the file API, but make every exec fail instead of running outside bubblewrap. */
export function createNoExecEnv(env: ExecutionEnv, status: SandboxUnavailable): ExecutionEnv {
  return new NoExecEnv(env, status);
}

export interface SandboxOptions {
  readonly root: string;
  readonly bwrap?: string | undefined;
  readonly shell?: string | undefined;
}

/** An environment whose exec runs under bubblewrap, with only the root writable. */
export function createSandboxEnv(env: ExecutionEnv, options: SandboxOptions): ExecutionEnv {
  const root = options.root;
  if (!root.startsWith("/") || root === "/") {
    throw new Error("the sandbox root must be an absolute path other than /");
  }
  const bwrap = options.bwrap ?? process.env.BWRAP ?? "bwrap";
  const shell = options.shell ?? resolveShell();
  const prefix = root.endsWith("/") ? root : root + "/";
  const under = (path: string): boolean => path === root || path.startsWith(prefix);

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
    args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--chdir", cwd, "--");
    const argv = Array.isArray(command) ? [...command] : [shell, "-c", command];
    return [bwrap, ...args, ...argv];
  };

  return new SandboxEnv(env, wrap);
}

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
