// S1: does a Landlock ruleset inside bwrap deny reads outside the root?
//
// Two shapes, both run through bwrap with the product's mount arguments:
//
//   C1  probe-landlock ROOT tries to read a file inside and a file outside.
//   C2  probe-escape tries the ways out of ROOT: .., a symlink planted under
//       ROOT, a bind mount of an outside file under ROOT (bwrap makes it), and
//       an fd opened before the ruleset was applied.
//
// The ruleset is applied *inside* the sandbox by a helper process, which is the
// only place it can be applied: Landlock restricts the calling process and its
// children. The output is JSON per path, so the caller decides what each shape
// must mean; this script only reports.
//
// Usage: node src/landlock.mjs [--out PATH] [--skip-mount]
import { spawnSync } from "node:child_process";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

const BWRAP = process.env.BWRAP ?? "bwrap";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;

const bin = join(import.meta.dirname, "..", "bin");
const landlock = join(bin, "probe-landlock");
const escape = join(bin, "probe-escape");
for (const path of [landlock, escape]) {
  if (!existsSync(path)) throw new Error("missing " + path + ": run src/build.sh first");
}

// /tmp is itself a symlink on NixOS; a denied EACCES must not be confused with
// ENOENT through an unresolved path, so every path handed to the probe is real.
const base = realpathSync(await mkdtemp(join(tmpdir(), "hns-landlock-")));
const root = join(base, "root");
const outside = join(base, "outside");
await mkdir(root);
await mkdir(outside);
writeFileSync(join(root, "inside.txt"), "inside\n");
await mkdir(join(root, "sub"));
writeFileSync(join(root, "sub", "deep.txt"), "deep\n");
writeFileSync(join(outside, "secret.txt"), "secret\n");
writeFileSync(join(outside, "link-target.txt"), "link-target\n");
writeFileSync(join(outside, "dotdot-target.txt"), "dotdot-target\n");
writeFileSync(join(outside, "bind-target.txt"), "bind-target\n");
writeFileSync(join(base, "dotdot-target.txt"), "parent\n");
writeFileSync(join(base, "secret.txt"), "parent\n");
symlinkSync(join(outside, "link-target.txt"), join(root, "link-link-target.txt"));
symlinkSync("../dotdot-target.txt", join(root, "link-dotdot-via-link.txt"));

/** The product's mount shape: host read-only, root writable, /dev and /proc. */
const mountArgs = () => [
  "--die-with-parent",
  "--ro-bind", "/", "/",
  "--bind", root, root,
  "--dev", "/dev",
  "--proc", "/proc",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
];

const run = (extra, command) =>
  spawnSync(BWRAP, [...mountArgs(), ...extra, "--", ...command], {
    encoding: "utf8",
    timeout: 30_000,
  });

/** Parse the JSON lines a probe prints; a line that is not JSON is a hard failure. */
const parse = (label, result) => {
  if (result.error !== undefined) throw new Error(label + ": " + result.error.message);
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return {
    status: result.status,
    stderr: result.stderr.trim(),
    entries: lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(label + ": not JSON: " + line);
      }
    }),
  };
};

// C1: inside read passes, outside read is EACCES.
const c1 = parse("C1", run([], [landlock, root, join(root, "inside.txt"), join(outside, "secret.txt")]));
const byPath = new Map(c1.entries.map((entry) => [entry.path, entry]));
const inside = byPath.get(join(root, "inside.txt"));
const denied = byPath.get(join(outside, "secret.txt"));
const c1Result = {
  abi: c1.entries.find((entry) => entry.abi !== undefined)?.abi ?? null,
  insideAllowed: inside?.ok === true,
  outsideDenied: denied?.ok === false && denied?.errno === 13,
  entries: c1.entries,
  stderr: c1.stderr,
};

// C2: the escape shapes. "bound.txt" under ROOT is a bind of an outside file,
// made by bwrap before the ruleset exists; the symlink and .. targets are named
// differently so a missing file can never be mistaken for a denied one.
const c2 = parse(
  "C2",
  run(
    ["--ro-bind", join(outside, "bind-target.txt"), join(root, "bound.txt")],
    [escape, root, "dotdot-target.txt", "link-target.txt", "bound.txt"],
  ),
);
const route = (name) => c2.entries.find((entry) => entry.route === name);
const escapes = ["dotdot", "symlink", "bindmount"].filter((name) => route(name)?.ok === true);
const fdBefore = route("openbefore");
const c2Result = {
  // "direct" is the bind mount itself: it is *under* the root, so Landlock
  // allows it by rule. That is the finding, not a bug in the probe.
  directBindPasses: route("direct")?.ok === true,
  escaped: escapes,
  escapedNothing: escapes.length === 0,
  openBeforeRestriction: fdBefore?.ok === true,
  entries: c2.entries,
  stderr: c2.stderr,
};

await rm(base, { recursive: true, force: true });

const report = {
  measuredAt: new Date().toISOString(),
  bwrap: BWRAP,
  c1: c1Result,
  c2: c2Result,
};
const text = JSON.stringify(report, null, 2) + "\n";
if (outPath !== undefined) writeFileSync(outPath, text);
process.stdout.write(text);