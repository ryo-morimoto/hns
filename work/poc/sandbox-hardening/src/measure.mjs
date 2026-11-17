// Measure what each extra fence costs a single bash invocation.
//
// Every sample is one full `bwrap ... -- <shell> -c ':'` from the host process:
// process spawn, namespace setup, the extra policy, shell exit. The baseline is
// the argv the product's createSandboxEnv builds today; each S1/S7 variant adds
// exactly one argument group, so a difference is attributable to that group.
//
// p50/p95 are reported per configuration, measured in three interleaved rounds
// (round 1: every configuration, round 2: the same order again, ...). Interleaving
// keeps drift from another lane in all configurations instead of in one. A run
// that spawns but exits non-zero is an error, not a slow sample: the numbers are
// only claimed when every process did the same work.
//
// Usage: node src/measure.mjs [--n N] [--warmup W] [--out PATH] [--config NAME]
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildS7Filter, encodeSockFprog, verifyFilter } from "./seccomp.mjs";

const BWRAP = process.env.BWRAP ?? "bwrap";
const SHELL = process.env.SHELL_PROBE ?? "/run/current-system/sw/bin/sh";
const PATH = "/run/current-system/sw/bin:/usr/bin:/bin";

/** Parse --flag value pairs; anything else is a usage error. */
function parseArgs(argv) {
  const parsed = { n: 200, warmup: 20, out: undefined, config: undefined, rounds: 3 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error("missing value for " + flag);
    index += 1;
    if (flag === "--n") parsed.n = Number(value);
    else if (flag === "--warmup") parsed.warmup = Number(value);
    else if (flag === "--out") parsed.out = value;
    else if (flag === "--config") parsed.config = value;
    else if (flag === "--rounds") parsed.rounds = Number(value);
    else throw new Error("unknown flag " + flag);
  }
  for (const [name, value] of [["n", parsed.n], ["warmup", parsed.warmup], ["rounds", parsed.rounds]]) {
    if (!Number.isInteger(value) || value < 0) throw new Error("--" + name + " must be a non-negative integer");
  }
  if (parsed.n < 1 || parsed.rounds < 1) throw new Error("--n and --rounds must be at least 1");
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

const workdir = await mkdtemp(join(tmpdir(), "hns-perf-"));
const root = join(workdir, "root");
const outside = join(workdir, "outside");
await mkdir(root);
await mkdir(outside);
await writeFile(join(root, "inside.txt"), "inside\n");
await writeFile(join(outside, "secret.txt"), "secret\n");
const bpfPath = join(workdir, "s7.bpf");
// The committed artifact has no header; bwrap rejects a length it does not expect.
verifyFilter(buildS7Filter());
await writeFile(bpfPath, encodeSockFprog(buildS7Filter()).subarray(2));

const landlockProbe = join(import.meta.dirname, "..", "bin", "probe-landlock");
const syscallsProbe = join(import.meta.dirname, "..", "bin", "probe-syscalls");

/** The argv shape createSandboxEnv produces (packages/workspace/src/sandbox.ts), plus extras. */
const baseArgs = (extras) => [
  "--die-with-parent",
  "--ro-bind", "/", "/",
  "--bind", root, root,
  "--dev", "/dev",
  "--proc", "/proc",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  ...extras,
  "--clearenv",
  "--setenv", "PATH", PATH,
  "--setenv", "HOME", root,
  "--chdir", root,
  "--",
];

/**
 * One timed spawn. Resolves with the elapsed milliseconds.
 *
 * @remarks
 * spawnSync cannot hand bwrap a readable fd, so every sample goes through
 * spawn and the promise's settle. The timer covers spawn -> exit, exactly the
 * work the product does per exec.
 */
function oneRun(argv, stdio) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(BWRAP, argv, { stdio, timeout: 30_000 });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      if (code !== 0) {
        reject(new Error("bwrap exited " + code + " (" + signal + "): " + stderr));
        return;
      }
      resolve(elapsed);
    });
  });
}

/** Nearest-rank percentile over an ascending array. */
function percentile(sorted, fraction) {
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, rank)];
}

/** Run N samples after W warmups; returns sorted samples and p50/p95. */
async function measure(argv, n, warmup, withSeccompFd) {
  const run = () => {
    // bwrap reads the BPF from the fd at once, so the offset stays at 0 for the
    // next sample only if the fd is reopened each time. It is: each spawn gets a
    // fresh read handle, which is also what a product spawn would do.
    const bpfFd = withSeccompFd ? openSync(bpfPath, "r") : undefined;
    const stdio = withSeccompFd ? ["ignore", "ignore", "pipe", bpfFd] : ["ignore", "ignore", "pipe"];
    return oneRun(argv, stdio).finally(() => {
      if (bpfFd !== undefined) closeSync(bpfFd);
    });
  };
  for (let index = 0; index < warmup; index += 1) await run();
  const samples = [];
  for (let index = 0; index < n; index += 1) samples.push(await run());
  samples.sort((left, right) => left - right);
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), min: samples[0], max: samples[samples.length - 1], samples };
}

/**
 * The configurations measured here.
 *
 * The landlock row runs a helper instead of a shell, because Landlock restricts
 * the calling process and a shell cannot install it for itself before exec.
 * That changes what the sample contains; the report says so instead of
 * subtracting a number that would compare different work.
 */
const configurations = [
  // "bash" is the number the S1/S7 targets name ("bash 1 回"): spawn + namespaces + shell.
  { name: "bash", argv: [...baseArgs([]), SHELL, "-c", ":"] },
  { name: "bash-seccomp", argv: [...baseArgs(["--seccomp", "3"]), SHELL, "-c", ":"], seccompFd: true },
  // Landlock needs a helper process, so its baseline is the same helper without
  // a ruleset: the difference is the ruleset installation and its checks, not the
  // helper's own startup.
  { name: "helper-nolandlock", argv: [...baseArgs([]), landlockProbe, "/", join(root, "inside.txt")] },
  { name: "helper-landlock", argv: [...baseArgs([]), landlockProbe, root, join(root, "inside.txt")] },
  { name: "helper-landlock-seccomp", argv: [...baseArgs(["--seccomp", "3"]), landlockProbe, root, join(root, "inside.txt")], seccompFd: true },
  // The syscall probe does identical work in both rows, so the pair isolates seccomp.
  { name: "syscalls", argv: [...baseArgs([]), syscallsProbe, "io_uring", "vsock", "inet", "file"] },
  { name: "syscalls-seccomp", argv: [...baseArgs(["--seccomp", "3"]), syscallsProbe, "io_uring", "vsock", "inet", "file"], seccompFd: true },
];

const wanted = args.config === undefined ? configurations : configurations.filter((c) => c.name === args.config);
if (wanted.length === 0) throw new Error("unknown --config " + String(args.config));

const results = new Map(wanted.map((configuration) => [configuration.name, []]));
for (let round = 0; round < args.rounds; round += 1) {
  for (const configuration of wanted) {
    const measured = await measure(configuration.argv, args.n, args.warmup, configuration.seccompFd === true);
    results.get(configuration.name).push(measured);
  }
}

const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
const report = {
  measuredAt: new Date().toISOString(),
  bwrap: BWRAP,
  shell: SHELL,
  n: args.n,
  warmupPerRound: args.warmup,
  rounds: args.rounds,
  unit: "ms, wall clock around one bwrap spawn through exit",
  configurations: Object.fromEntries(
    [...results].map(([name, rounds]) => [
      name,
      {
        p50: mean(rounds.map((round) => round.p50)),
        p95: mean(rounds.map((round) => round.p95)),
        min: Math.min(...rounds.map((round) => round.min)),
        max: Math.max(...rounds.map((round) => round.max)),
        rounds: rounds.map((round) => ({ p50: round.p50, p95: round.p95 })),
      },
    ]),
  ),
};

await rm(workdir, { recursive: true, force: true });
const text = JSON.stringify(report, null, 2) + "\n";
if (args.out !== undefined) await writeFile(args.out, text);
process.stdout.write(text);