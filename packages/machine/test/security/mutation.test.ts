// Mutation probes: each one breaks a single property of the sandbox and requires the proof to
// fail. A test that passes against a broken sandbox proves nothing, so these run the same
// assertions the main suite relies on, against a deliberately wrong builder.
//
// Each probe starts from the product's own `runExec` and `createMachineExec` where it can, so it
// is the product path being observed, and swaps exactly one thing.
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createSandboxEnv } from "@hns/workspace/sandbox";
import { requireBwrap } from "../../../../tools/test/cf-dev.ts";
import { runExec } from "../../src/exec.ts";
import type { MachineExec } from "../../src/exec.ts";
import { createMachineSandboxEnv, machineHideList, machineShellEnv } from "../../src/sandbox.ts";
import { parseOperation } from "../../src/wire.ts";
import { hostEnv, sandboxPaths, sandboxReport } from "../support/sandbox.ts";
import type { SandboxPaths } from "../support/sandbox.ts";

const report = await sandboxReport();
const why = report.available ? "" : report.reason;
const skip = report.available ? false : !requireBwrap(false, why);

let paths: SandboxPaths;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const made = await sandboxPaths();
  paths = { ...made, base: await realpath(made.base) };
  for (const name of ["ANTHROPIC_API_KEY", "HOME"]) saved[name] = process.env[name];
  process.env.ANTHROPIC_API_KEY = "sk-ant-must-not-leak";
  process.env.HOME = paths.home;
});

afterAll(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (paths !== undefined) await rm(paths.base, { recursive: true, force: true });
});

/** A ready executor whose environment was built by `builder` instead of the product's. */
function executor(builder: (env: ExecutionEnv) => ExecutionEnv): MachineExec {
  if (!report.available) throw new Error("the probes run only when the probe passed");
  return { ready: true, env: builder(hostEnv(paths.project)), sandbox: report };
}

/** Run through the product's exec path, as the main suite does. */
async function run(machine: MachineExec, script: string): Promise<string> {
  const parsed = parseOperation(
    new TextEncoder().encode(JSON.stringify({ op: "exec", args: ["/bin/sh", "-c", script] })),
  );
  if (parsed.op !== "exec") throw new Error("not an exec");
  return (
    await runExec(machine, parsed, {
      maxOutputBytes: 256 * 1024,
      signal: new AbortController().signal,
      root: paths.project,
    })
  ).output;
}

/**
 * The main suite's "the server's secrets are not in the sandbox" assertion, as a probe verdict.
 *
 * @param output - The sandboxed `env` output.
 * @returns True when no secret leaked, false when one did.
 *
 * @remarks
 * The probes run the *same* rule the product suite runs
 * (`expect(output).not.toContain("sk-ant-must-not-leak")`); writing it as a predicate lets a probe
 * assert that it fails, instead of failing the suite itself.
 */
const leaksSecret = (output: string): boolean => output.includes("sk-ant-must-not-leak");

/** Require that the main suite's secret assertion now fails. */
function expectLeak(output: string): void {
  expect(leaksSecret(output)).toBe(true);
  expect(output).toContain("ANTHROPIC_API_KEY");
}

// The product's own builder, so the probes differ from a passing case only by the mutation.
const product = (env: ExecutionEnv): ExecutionEnv =>
  createMachineSandboxEnv(env, { root: paths.root, projectRoot: paths.project, home: paths.home });

/**
 * Run the product's exec path with one part of the sandbox replaced.
 *
 * @param mutation - The part to break: the names the environment forwards, or the hide list.
 * @returns A ready executor built the way the agent builds one, with that part mutated.
 *
 * @remarks
 * The environment and the hide list are what the two probes below break, so they are passed
 * through to the product builder rather than assembled by hand: what the probe measures is the
 * product's `createMachineExec` -> `runExec` path with one decision changed.
 */
async function productExecWith(mutation: {
  readonly env?: readonly string[] | undefined;
  readonly hide?: readonly string[] | undefined;
}): Promise<MachineExec> {
  const sandboxEnv = createSandboxEnv(hostEnv(paths.project), {
    root: paths.root,
    project: { root: paths.root, projectRoot: paths.project },
    readOnlyInside: [],
    hide: mutation.hide ?? machineHideList(paths.home, paths.root),
    egress: "deny",
    envValues: machineShellEnv(),
    env: mutation.env,
    bwrap: report.available ? report.bwrap : undefined,
  });
  return { ready: true, env: sandboxEnv, sandbox: report };
}

// Control: the unmutated product passes the same assertions. Without this, every probe below
// could be "failing" for a reason unrelated to the mutation.
test.skipIf(skip)(
  "control: the unmutated sandbox passes the assertions the probes break",
  async () => {
    const machine = executor(product);
    expect(
      await run(machine, "cat " + join(paths.home, ".config", "hns", "device.key")),
    ).not.toContain("device-secret");
    expect(leaksSecret(await run(machine, "env"))).toBe(false);
  },
);

// Mutation 1: the product's own allowlist is widened to pass the server's environment through.
// The mutation runs the product path (createMachineExec -> runExec) and changes the one thing the
// allowlist is: the names it forwards.
test.skipIf(skip)("probe: an environment that is passed through is caught", async () => {
  const leaked = await productExecWith({ env: ["ANTHROPIC_API_KEY", "HNS_AGENT_URL"] });
  const output = await run(leaked, "env");
  // The assertion the main suite makes against the product fails here, which is the proof.
  expectLeak(output);
});

// Mutation 2: the hide list is dropped, so the device key reads.
test.skipIf(skip)("probe: dropping the hide list is caught", async () => {
  const open = executor((env) =>
    createSandboxEnv(env, {
      root: paths.root,
      project: { root: paths.root, projectRoot: paths.project },
      bwrap: report.available ? report.bwrap : "bwrap",
    }),
  );
  const output = await run(open, "cat " + join(paths.home, ".config", "hns", "device.key"));
  expect(output).toContain("device-secret");
});

// Mutation 3: the command runs without the wrapper at all.
test.skipIf(skip)("probe: running without the sandbox is caught", async () => {
  const bare: MachineExec = { ready: true, env: hostEnv(paths.project), sandbox: report };
  const output = await run(
    bare,
    "cat " + join(paths.home, ".config", "hns", "device.key") + "; env",
  );
  expect(output).toContain("device-secret");
  expect(output).toContain("sk-ant-must-not-leak");
});

// Mutation 4: the product's fixed hide list is emptied. The mutation is applied to the product
// path (createMachineExec -> runExec), so what fails is the product's own builder, not a wrapper
// the test assembled.
test.skipIf(skip)("probe: an empty fixed hide list is caught", async () => {
  const none = await productExecWith({ hide: [] });
  const output = await run(none, "cat " + join(paths.home, ".ssh", "id_ed25519"));
  expect(output).toContain("ssh-secret");
  // The device key too: an empty list hides nothing, not even the key directory.
  expect(await run(none, "cat " + join(paths.home, ".config", "hns", "device.key"))).toContain(
    "device-secret",
  );
});
