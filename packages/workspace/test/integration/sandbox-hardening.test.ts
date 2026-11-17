import { spawnSync } from "node:child_process";
import { closeSync, openSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";
import { detectSandbox } from "../../src/sandbox.ts";
import { requireBwrap } from "../../../../tools/test/cf-dev.ts";

// The C1, C2, and C5 cases of the sandbox hardening spike: what Landlock and a
// seccomp filter do *inside* bubblewrap.
//
// The probes are compiled helpers under work/poc/sandbox-hardening/bin. They are
// separate processes because Landlock restricts the process that installs the
// ruleset, and a shell cannot install one for itself; the probe is that process.
// The numbers and the adoption verdicts are in work/research/sandbox-hardening.md.
// This suite is the part that must not regress once a fence is wired into the
// product wrapper.
//
// A host without a usable bubblewrap, or without Landlock, skips with the reason
// the probe gave. The skip is a fact about the host, not a permission to pass.

const POC = join(import.meta.dirname, "../../../../work/poc/sandbox-hardening");
const LANDLOCK = join(POC, "bin/probe-landlock");
const ESCAPE = join(POC, "bin/probe-escape");
const SYSCALLS = join(POC, "bin/probe-syscalls");
const S7_BPF = join(POC, "bin/sandbox-hardening.bpf");

const status = await detectSandbox();
const why = status.available ? "" : status.reason;
const skip = status.available ? false : !requireBwrap(false, why);

let base = "";
let root = "";
let outside = "";

beforeAll(async () => {
  if (skip) return;
  // /tmp is a symlink on NixOS; a path that a rule denies must not be confused
  // with a path that does not exist, so every path handed to a probe is real.
  base = realpathSync(await mkdtemp(join(tmpdir(), "hns-hardening-")));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, "inside.txt"), "inside\n");
  await writeFile(join(outside, "outside.txt"), "secret\n");
  await writeFile(join(outside, "linktarget.txt"), "link target\n");
  await writeFile(join(outside, "dotdot-target.txt"), "dotdot target\n");
  await writeFile(join(base, "dotdot-target.txt"), "parent\n");
  await writeFile(join(outside, "bind-target.txt"), "bind target\n");
});

afterAll(async () => {
  if (base !== "") await rm(base, { recursive: true, force: true });
});

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one command inside the product's mount shape.
 *
 * @param extra - Arguments between the mounts and the command (an extra bind, --seccomp).
 * @param command - The program and its arguments inside the sandbox.
 * @param bpf - When set, bwrap reads the seccomp filter from this path as fd 3.
 * @returns Status, stdout, and stderr; a non-zero status is the caller's to read.
 *
 * @remarks
 * The mount arguments mirror createSandboxEnv (read-only /, writable root, /dev,
 * /proc, pid/ipc/uts namespaces) so a pass here is evidence about the real
 * wrapper and not about a wrapper the test invented.
 */
function inSandbox(extra: readonly string[], command: readonly string[], bpf?: string): Outcome {
  const fd = bpf === undefined ? undefined : openSync(bpf, "r");
  try {
    const result = spawnSync(
      status.available ? status.bwrap : "bwrap",
      [
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
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        ...extra,
        "--",
        ...command,
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        stdio: fd === undefined ? "pipe" : ["ignore", "pipe", "pipe", fd],
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * One line of a probe's output: the kernel's answer for one path or one call.
 *
 * @remarks
 * The probe prints JSON, so the fields are named by the probe, not by this suite.
 * "route" is probe-escape's label for the way it tried to leave the root.
 */
const EntrySchema = v.object({
  abi: v.optional(v.number()),
  path: v.optional(v.string()),
  call: v.optional(v.string()),
  route: v.optional(v.string()),
  ok: v.optional(v.boolean()),
  errno: v.optional(v.number()),
});

/** Parse a probe's JSON lines; a line the schema refuses fails the test, not the parse. */
function entries(outcome: Outcome): v.InferOutput<typeof EntrySchema>[] {
  return outcome.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => v.parse(EntrySchema, JSON.parse(line)));
}

// Catches: a Landlock ruleset that is created but never restricts, so every read succeeds.
test.skipIf(skip)("C1: a read outside the root is denied and a read inside it passes", async () => {
  const result = inSandbox(
    [],
    [LANDLOCK, root, join(root, "inside.txt"), join(outside, "outside.txt")],
  );
  const parsed = entries(result);

  expect(result.status, result.stderr).toBe(0);
  expect(parsed.find((entry) => entry.abi !== undefined)?.abi).toBeGreaterThanOrEqual(3);
  expect(parsed.find((entry) => entry.path === join(root, "inside.txt"))?.ok).toBe(true);
  expect(parsed.find((entry) => entry.path === join(outside, "outside.txt"))).toMatchObject({
    ok: false,
    errno: 13,
  });
});

// Catches: a path that climbs out with ".." or a symlink resolving before the rule applies.
test.skipIf(skip)("C2: dotdot and a symlink stay inside the root", async () => {
  // probe-escape reads ROOT/link-<target name>, so the symlink it will open is
  // ROOT/link-linktarget.txt and it points outside the root.
  const target = "linktarget.txt";
  await symlink(join(outside, target), join(root, "link-" + target));
  const result = inSandbox([], [ESCAPE, root, "dotdot-target.txt", target, "unused"]);
  const parsed = entries(result);

  expect(result.status, result.stderr).toBe(0);
  expect(parsed.find((entry) => entry.route === "symlink")).toMatchObject({ ok: false, errno: 13 });
  expect(parsed.find((entry) => entry.route === "dotdot")).toMatchObject({ ok: false, errno: 13 });
  // The same ruleset still lets the file inside the root through.
  expect(parsed.find((entry) => entry.route === "inside")).toMatchObject({ ok: true });
});

// Catches: a bind mount under the root, which the ruleset cannot tell from the root itself.
test.skipIf(skip)(
  "C2: a file bind-mounted under the root is readable and the climbs out are denied",
  async () => {
    const result = inSandbox(
      ["--ro-bind", join(outside, "bind-target.txt"), join(root, "bound.txt")],
      [ESCAPE, root, "dotdot-target.txt", "linktarget.txt", "bound.txt"],
    );
    const parsed = entries(result);

    expect(result.status, result.stderr).toBe(0);
    // The mount lands *under* the root, so the rule is right to allow it: this is
    // the shape that must be controlled by the wrapper's mount list, not by Landlock.
    expect(parsed.find((entry) => entry.route === "bindmount")).toMatchObject({ ok: true });
    expect(parsed.find((entry) => entry.route === "dotdot")).toMatchObject({
      ok: false,
      errno: 13,
    });
    expect(parsed.find((entry) => entry.route === "symlink")).toMatchObject({
      ok: false,
      errno: 13,
    });
  },
);

// Catches: a filter that kills the process instead of returning EPERM, or one that denies too much.
test.skipIf(skip)(
  "C5: seccomp denies io_uring and AF_VSOCK and leaves normal calls alone",
  async () => {
    const bare = inSandbox([], [SYSCALLS, "io_uring", "vsock", "inet", "file"]);
    const filtered = inSandbox(
      ["--seccomp", "3"],
      [SYSCALLS, "io_uring", "vsock", "inet", "file"],
      S7_BPF,
    );

    expect(bare.status, bare.stderr).toBe(0);
    expect(filtered.status, filtered.stderr).toBe(0);
    // The baseline is what makes the EPERM below meaningful: without the filter the
    // same call reports a different errno (ENOSYS on a kernel without io_uring).
    const bareCalls = new Map(entries(bare).map((entry) => [entry.call, entry]));
    expect(bareCalls.get("vsock")).toMatchObject({ ok: true });
    const calls = new Map(entries(filtered).map((entry) => [entry.call, entry]));
    expect(calls.get("io_uring")).toMatchObject({ ok: false, errno: 1 });
    expect(calls.get("vsock")).toMatchObject({ ok: false, errno: 1 });
    // A normal shell still runs, and sockets the filter does not name still open.
    expect(calls.get("inet")).toMatchObject({ ok: true });
    expect(calls.get("file")).toMatchObject({ ok: true });
    expect(
      inSandbox(["--seccomp", "3"], ["/run/current-system/sw/bin/sh", "-c", ":"], S7_BPF).status,
    ).toBe(0);
  },
);
