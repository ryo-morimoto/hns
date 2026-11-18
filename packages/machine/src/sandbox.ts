// What a machine's agent may run, and what its shell may reach (D095).
//
// The wrapper itself is @hns/workspace's createSandboxEnv: this module only decides the machine's
// fixed shape -- the hide list, the environment allowlist, the mount of the project, and the
// seccomp filter -- so there is one bwrap implementation in the product, not two.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createSandboxEnv } from "@hns/workspace/sandbox";
import type { SandboxEgress } from "@hns/workspace/sandbox";

/**
 * The machine's fixed hide list: what a sandboxed shell must never reach.
 *
 * @param home - The account the machine runs as; defaults to `os.homedir()`.
 * @returns Absolute paths, in a fixed order. The caller cannot add to them: a machine that needs
 * another path hidden gets it here, in a release, not from a request.
 *
 * @remarks
 * `~/.config/hns` holds the device key and the cloudflared token (docs/auth.md), so a shell must
 * not read it at all, not merely be refused writing to it. The rest are the other places a shell
 * can pick up a credential without being asked. Paths are passed whether or not they exist:
 * a directory created after the agent starts is still masked.
 */
export function machineHideList(home: string = homedir()): readonly string[] {
  return [
    join(home, ".config", "hns"),
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".config", "gh"),
    join(home, ".git-credentials"),
    join(home, ".netrc"),
  ];
}

/**
 * The environment a sandboxed shell gets, besides what the wrapper always sets.
 *
 * @returns `TMPDIR` (the sandbox's own /tmp) and the two git switches.
 *
 * @remarks
 * `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` point at /dev/null, so the shell's git never reads the
 * account's `~/.gitconfig` or the system one: HOME is the project root (0045 H-1), and a git
 * config found there would come from the repository rather than from the operator.
 * `GIT_OPTIONAL_LOCKS=0` is what keeps a reading git (`git status`) from writing an index.
 */
export function machineShellEnv() {
  return {
    TMPDIR: "/tmp",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  } satisfies Record<string, string>;
}

/**
 * The seccomp filter bubblewrap loads before exec, as 8-byte `struct sock_filter` records.
 *
 * @returns The program: io_uring_setup / io_uring_enter / io_uring_register and `socket(AF_VSOCK)`
 * answer EPERM, every other call is allowed, and a call on an architecture the filter was not
 * built for kills the process.
 *
 * @remarks
 * io_uring is refused because a ring can complete file I/O without the descriptors its opener
 * holds, and AF_VSOCK reaches a host service that is not on the network namespace. EPERM, not a
 * kill: a program that probes io_uring and falls back must keep its fallback. The bytes are built
 * here rather than shipped as a binary so the policy is reviewable next to its test, and the
 * filter is only used on an architecture it names ({@link SECCOMP_ARCHES}).
 *
 * **The product does not apply this filter yet.** `bwrap --seccomp` reads an inherited fd, and
 * the exec the agent runs on hands the child stdio only, so wiring it as is would make every
 * command fail instead of filtering it. The program and its tests are kept so the follow-up
 * (an exec that can pass a descriptor) has nothing left to design.
 */
export function machineSeccompFilter(arch: string = process.arch): Uint8Array {
  // Every jump is "target - (this + 1)", and the target index is named on each line.
  const program = [
    /* 0 */ ld(ARCH_OFFSET),
    /* 1 */ jump(JEQ, auditArch(arch), 1, 0), // true: 3, false: 2
    /* 2 */ ret(RET_KILL_PROCESS),
    /* 3 */ ld(SYSCALL_OFFSET),
    /* 4 */ jump(JEQ, IO_URING_SETUP, 2, 0), // true: 7, false: 5
    /* 5 */ jump(JEQ, IO_URING_ENTER, 1, 0), // true: 7, false: 6
    /* 6 */ jump(JEQ, IO_URING_REGISTER, 0, 1), // true: 7, false: 8
    /* 7 */ ret(ERRNO_EPERM),
    /* 8 */ jump(JEQ, SYS_SOCKET, 0, 3), // true: 9, false: 12
    /* 9 */ ld(ARGS_OFFSET),
    /* 10 */ jump(JEQ, AF_VSOCK, 0, 1), // true: 11, false: 12
    /* 11 */ ret(ERRNO_EPERM),
    /* 12 */ ret(ALLOW),
  ];
  const bytes = new Uint8Array(program.length * 8);
  program.forEach((instruction, index) => {
    bytes.set(instruction, index * 8);
  });
  return bytes;
}

/** The architectures {@link machineSeccompFilter} names; on any other one bwrap kills the process. */
export const SECCOMP_ARCHES = ["x64", "arm64"] as const;

/**
 * The `AUDIT_ARCH` a seccomp filter compares against for a Node architecture.
 *
 * @param platform - `process.arch`.
 * @returns The audit arch constant. An architecture the product does not name answers x86-64, so
 * the filter refuses everything there rather than opening up; {@link seccompSupported} is what
 * keeps it from being used at all.
 */
function auditArch(platform: string): number {
  return platform === "arm64" ? AUDIT_ARCH_AARCH64 : AUDIT_ARCH_X86_64;
}

// cBPF opcodes (linux/filter.h), each instruction 8 bytes: code u16, jt u8, jf u8, k u32.
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_RET_K = 0x06;
const RET_KILL_PROCESS = 0x80000000;
const RET_ERRNO = 0x00050000;
const RET_ALLOW = 0x7fff0000;
const EPERM = 1;
// struct seccomp_data offsets: nr, arch, instruction_pointer, args[0] at 16.
const SYSCALL_OFFSET = 0;
const ARCH_OFFSET = 4;
const ARGS_OFFSET = 16;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
/** socket(2) is 41 on both named architectures. */
const SYS_SOCKET = 41;
const AF_VSOCK = 40;
const IO_URING_SETUP = 425;
const IO_URING_ENTER = 426;
const IO_URING_REGISTER = 427;
const ERRNO_EPERM = RET_ERRNO | (EPERM & 0xffff);
const ALLOW = RET_ALLOW;
const JEQ = BPF_JMP_JEQ_K;

/** One cBPF instruction as its 8 on-disk bytes. */
function encode(code: number, jt: number, jf: number, k: number): Uint8Array {
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, code, true);
  view.setUint8(2, jt);
  view.setUint8(3, jf);
  view.setUint32(4, k >>> 0, true);
  return bytes;
}

const ld = (offset: number): Uint8Array => encode(BPF_LD_W_ABS, 0, 0, offset);
const jump = (code: number, k: number, jt: number, jf: number): Uint8Array =>
  encode(code, jt, jf, k);
const ret = (action: number): Uint8Array => encode(BPF_RET_K, 0, 0, action);

/**
 * Whether this host's architecture is one the seccomp filter names.
 *
 * @param platform - `process.arch`; defaults to the running one.
 * @returns True when the filter can be used without killing every exec.
 */
export function seccompSupported(platform: string = process.arch): boolean {
  return SECCOMP_ARCHES.some((arch) => arch === platform);
}

/** How to build the machine's sandbox for one project. */
export interface MachineSandboxOptions {
  /** The directory whose siblings stay invisible: the project is bound inside a fresh tmpfs here. */
  readonly root: string;
  /** The project the shell runs in: a directory bound writable under `root`. */
  readonly projectRoot: string;
  /** The bwrap executable; defaults to `$BWRAP`, then `bwrap` on PATH. */
  readonly bwrap?: string | undefined;
  /** The account whose home is hidden; defaults to `os.homedir()`. */
  readonly home?: string | undefined;
  /** The project's egress; unset means `deny` (D095: allowlist has no proxy in v1). */
  readonly egress?: SandboxEgress | undefined;
  /**
   * The fd number the seccomp filter has been inherited on, when the caller can pass one.
   *
   * @remarks
   * Left unset, the sandbox runs without the filter. That is the honest state for an exec that
   * only hands the child stdio ({@link seccompSupported} says whether the filter could be used at
   * all; this says whether this process can deliver it).
   */
  readonly seccompFd?: string | undefined;
}

/**
 * Build the environment a machine's shell runs in.
 *
 * @param env - The file system and process environment the file API keeps; only exec is wrapped.
 * @param options - The project, and how to reach bwrap.
 * @returns An environment whose exec runs in bwrap with the project writable, `.git` read-only,
 * the machine's fixed hide list masked, and only the allowlisted environment.
 * @throws {Error} When the root or project is not usable, per `createSandboxEnv`.
 *
 * @remarks
 * Mount order is what makes the read-only rules hold, so it is stated once here: the host is
 * bound read-only, a fresh tmpfs replaces `root`, the project is bound writable inside it, and
 * only then is `<project>/.git` bound read-only over that. Reversing the last two would leave
 * `.git` writable while looking protected (a test fixes the order). The seccomp filter is passed
 * only when a caller has inherited it on an fd ({@link MachineSandboxOptions.seccompFd}); the
 * agent's exec cannot, so it runs without one.
 */
export function createMachineSandboxEnv(
  env: ExecutionEnv,
  options: MachineSandboxOptions,
): ExecutionEnv {
  const home = options.home ?? homedir();
  const seccompFd = options.seccompFd;
  return createSandboxEnv(env, {
    root: options.root,
    project: { root: options.root, projectRoot: options.projectRoot },
    readOnlyInside: readOnlyGitPaths(options.projectRoot),
    hide: machineHideList(home),
    egress: options.egress ?? "deny",
    envValues: machineShellEnv(),
    bwrap: options.bwrap,
    seccomp: seccompFd !== undefined && seccompSupported() ? [seccompFd] : undefined,
  });
}

/**
 * The paths inside a project that the shell may read but not write.
 *
 * @param projectRoot - The canonical project root.
 * @returns `<project>/.git` when it exists, as a directory (ordinary repository) or a file (work
 * tree, where the real directory is elsewhere and reached through `gitdir:`).
 *
 * @remarks
 * Only the path itself is bound. A file's `gitdir:` target is not followed into the sandbox:
 * the work tree's real metadata is outside the project, so it is not in the sandbox at all, and
 * binding it read-only would be showing it.
 */
export function readOnlyGitPaths(projectRoot: string): readonly string[] {
  const git = resolve(projectRoot, ".git");
  if (!existsSync(git)) return [];
  const info = statSync(git);
  // A device or socket named .git is not a repository this wrapper should bind at all.
  return info.isFile() || info.isDirectory() ? [git] : [];
}
