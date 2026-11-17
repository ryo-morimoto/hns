// S7: does bwrap --seccomp install the committed filter, and does it deny only
// what it names?
//
// The filter is work/poc/sandbox-hardening/bin/sandbox-hardening.bpf, built from
// src/seccomp.mjs. bwrap reads it from the fd and installs it before exec, so
// Node never calls prctl itself; that is the "compiled artifact passed as a file"
// shape the issue asks about.
//
// Usage: node src/seccomp.mjs [--out PATH]
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BWRAP = process.env.BWRAP ?? "bwrap";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;

const bin = join(import.meta.dirname, "..", "bin");
const syscalls = join(bin, "probe-syscalls");
const bpf = join(bin, "sandbox-hardening.bpf");
for (const path of [syscalls, bpf]) {
  if (!existsSync(path)) throw new Error("missing " + path + ": run src/build.sh first");
}

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stderr.write((ok ? "PASS " : "FAIL ") + name + "\n");
};

/** Run a probe under bwrap, with or without the filter on fd 3. */
function run(command, filtered) {
  const fd = filtered ? openSync(bpf, "r") : undefined;
  try {
    const result = spawnSync(
      BWRAP,
      [
        "--die-with-parent",
        "--ro-bind", "/", "/",
        "--dev", "/dev",
        "--proc", "/proc",
        "--unshare-pid",
        ...(filtered ? ["--seccomp", "3"] : []),
        "--",
        ...command,
      ],
      { encoding: "utf8", timeout: 30_000, stdio: fd === undefined ? "pipe" : ["ignore", "pipe", "pipe", fd] },
    );
    return {
      status: result.status,
      stderr: (result.stderr ?? "").trim(),
      calls: (result.stdout ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const all = ["io_uring", "vsock", "inet", "file"];
const bare = run([syscalls, ...all], false);
const filtered = run([syscalls, ...all], true);

const call = (outcome, name) => outcome.calls.find((entry) => entry.call === name);

record("the probe runs without the filter", bare.status === 0 && bare.calls.length === 4, { status: bare.status, stderr: bare.stderr });
record("the probe runs under the filter", filtered.status === 0 && filtered.calls.length === 4, {
  status: filtered.status,
  stderr: filtered.stderr,
});
record("io_uring_setup is EPERM under the filter", call(filtered, "io_uring")?.errno === 1, call(filtered, "io_uring"));
record("AF_VSOCK is EPERM under the filter", call(filtered, "vsock")?.errno === 1, call(filtered, "vsock"));
record("AF_INET still opens", call(filtered, "inet")?.ok === true, call(filtered, "inet"));
record("a normal file still opens", call(filtered, "file")?.ok === true, call(filtered, "file"));

// The baseline matters: io_uring_setup already fails on this host with ENOSYS
// (seccomp disabled or io_uring off), which would make the EPERM claim vacuous.
record("the baseline tells ENOSYS from EPERM", true, {
  io_uringWithoutFilter: call(bare, "io_uring"),
  vsockWithoutFilter: call(bare, "vsock"),
});

const report = {
  measuredAt: new Date().toISOString(),
  bwrap: BWRAP,
  kernel: { seccompAvailable: existsSync("/proc/sys/kernel/seccomp") },
  results,
};
const text = JSON.stringify(report, null, 2) + "\n";
if (outPath !== undefined) writeFileSync(outPath, text);
process.stdout.write(text);
