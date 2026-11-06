// SandboxEnv: an ExecutionEnv whose exec() runs inside bubblewrap with only the root writable.
// Whether exec is offered at all is decided by detectSandbox() before startup; see docs/workspace.md.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROBE_TIMEOUT_MS = 5000;

/** A shell that exists on the host, so it also exists after --ro-bind /. NixOS has /bin/sh but no /bin/true. */
export function resolveShell() {
  const candidates = ["/bin/sh", "/usr/bin/sh", process.env.SHELL];
  for (const shell of candidates) {
    if (shell && shell.startsWith("/") && existsSync(shell)) return shell;
  }
  return "sh";
}

/** Resolve bwrap from an explicit path or PATH without shelling out to which(1). */
export function findBwrap(candidate = process.env.BWRAP || "bwrap") {
  const target = candidate || "bwrap";
  const paths = target.includes("/")
    ? [target]
    : (process.env.PATH ?? "").split(":").filter(Boolean).map((directory) => resolve(directory, target));
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "EACCES") continue;
      throw error;
    }
  }
  return undefined;
}

/** Parse "bubblewrap 0.12.0" (or a bare "0.12.0") into [0, 12, 0]. */
export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function run(command, args) {
  return new Promise((settle) => {
    execFile(command, args, { timeout: PROBE_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
      settle({ ok: !error, error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function firstLine(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

async function readNumber(path) {
  const text = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT" || error?.code === "EACCES") return undefined;
    throw error;
  });
  return text === undefined ? undefined : Number(text.trim());
}

/** Report the kernel switches that commonly turn unprivileged user namespaces off. */
async function readUsernsSysctls() {
  return {
    maxUserNamespaces: await readNumber("/proc/sys/user/max_user_namespaces"),
    unprivilegedUsernsClone: await readNumber("/proc/sys/kernel/unprivileged_userns_clone"),
    apparmorRestrictUnprivilegedUserns: await readNumber("/proc/sys/kernel/apparmor_restrict_unprivileged_userns"),
  };
}

function classifyFailure(result) {
  const text = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n");
  const line = firstLine(result.stderr) || firstLine(result.stdout) || firstLine(result.error?.message) || "bubblewrap failed";
  if (/No permissions to create new namespace|Creating new namespace failed|setting up uid map|setting up gid map/i.test(text)) {
    return { code: "userns-unavailable", reason: `unprivileged user namespaces are unavailable (${line})` };
  }
  if (/execvp/i.test(text)) {
    return { code: "shell-missing", reason: `the sandbox could not run its shell (${line})` };
  }
  return { code: "smoke-test-failed", reason: `the sandbox probe failed (${line})` };
}

/** Run the exact wrapper once against a temp root; a version check alone cannot prove user namespaces work. */
async function probeSandbox(bwrap, shell) {
  const root = await mkdtemp(join(tmpdir(), "hns-bwrap-probe-"));
  try {
    const args = ["--die-with-parent", "--ro-bind", "/", "/", "--bind", root, root, "--dev", "/dev", "--proc", "/proc"];
    // A tmpfs at /tmp would hide a root that lives there, so leave /tmp read-only in that case.
    if (!root.startsWith("/tmp/")) args.push("--tmpfs", "/tmp");
    args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--chdir", root, "--", shell, "-c", "printf ok > probe.txt");
    const result = await run(bwrap, args);
    if (!result.ok) return { ok: false, failure: classifyFailure(result) };
    const body = await readFile(join(root, "probe.txt"), "utf8").catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (body !== "ok") return { ok: false, failure: { code: "smoke-test-failed", reason: "the sandbox did not write a file under its root" } };
    return { ok: true };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Decide whether exec can be offered on this host. Anything but a clean probe is "unavailable":
 * a check that cannot run is a denial (docs/safety.md). See D032 for the platform policy.
 */
export async function detectSandbox(candidate = process.env.BWRAP || "bwrap") {
  const checkedAt = new Date().toISOString();
  const platform = process.platform;
  const shell = resolveShell();
  const unavailable = (fields) => ({ backend: "bubblewrap", platform, shell, checkedAt, available: false, exec: "disabled", ...fields });

  if (platform !== "linux") {
    return unavailable({ bwrap: candidate, userNamespaces: "unknown", code: "unsupported-platform", reason: `bubblewrap is Linux only (this host is ${platform})` });
  }

  const bwrap = findBwrap(candidate);
  if (!bwrap) {
    const pathLike = String(candidate).includes("/");
    const exists = pathLike && existsSync(candidate);
    return unavailable({
      bwrap: candidate,
      userNamespaces: "unknown",
      code: exists ? "not-executable" : "not-found",
      reason: exists ? `${candidate} is not executable` : pathLike ? `bwrap was not found at ${candidate}` : "bwrap was not found on PATH",
    });
  }

  const versionResult = await run(bwrap, ["--version"]);
  if (!versionResult.ok) {
    return unavailable({
      bwrap,
      userNamespaces: "unknown",
      code: "version-failed",
      reason: `bubblewrap --version failed (${firstLine(versionResult.stderr) || firstLine(versionResult.error?.message)})`,
    });
  }
  const version = parseVersion(versionResult.stdout);
  if (!version) {
    return unavailable({ bwrap, userNamespaces: "unknown", code: "version-failed", reason: `cannot read the bubblewrap version (${firstLine(versionResult.stdout)})` });
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

  return { backend: "bubblewrap", platform, shell, checkedAt, available: true, exec: "enabled", bwrap, version: version.join("."), userNamespaces: "ok", sysctls };
}

/** Thrown when a caller tries to exec although detection refused it. */
export class SandboxUnavailableError extends Error {
  constructor(status) {
    super(`exec is unavailable: ${status.reason ?? "the sandbox is not ready"}`);
    this.name = "SandboxUnavailableError";
    this.code = "sandbox_unavailable";
  }
}

/** Keep the file API, but make every exec fail instead of running outside bubblewrap. */
export function createNoExecEnv(env, status) {
  return new Proxy(env, {
    get(target, property) {
      if (property === "exec") {
        return async () => {
          throw new SandboxUnavailableError(status);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createSandboxEnv(env, { root, bwrap = process.env.BWRAP || "bwrap", shell = resolveShell() }) {
  if (!root?.startsWith("/") || root === "/") throw new Error("the sandbox root must be an absolute path other than /");
  const prefix = root.endsWith("/") ? root : root + "/";
  const under = (path) => path === root || path.startsWith(prefix);

  const wrap = (command, options) => {
    const cwd = under(options?.cwd ?? env.cwd) ? (options?.cwd ?? env.cwd) : root;
    const args = ["--die-with-parent", "--ro-bind", "/", "/", "--bind", root, root, "--dev", "/dev", "--proc", "/proc"];
    if (!root.startsWith("/tmp/")) args.push("--tmpfs", "/tmp");
    args.push("--unshare-pid", "--unshare-ipc", "--unshare-uts", "--chdir", cwd, "--");
    const argv = typeof command === "string" ? [shell, "-c", command] : command;
    return [bwrap, ...args, ...argv];
  };

  return new Proxy(env, {
    get(target, property) {
      if (property === "exec") {
        return (command, options, context) => target.exec(wrap(command, options), options, context);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
