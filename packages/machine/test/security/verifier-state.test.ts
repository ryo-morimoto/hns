import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GrantCounter } from "../../src/capability/counter.ts";
import { runExec } from "../../src/exec.ts";
import type { MachineExec } from "../../src/exec.ts";
import { createMachineSandboxEnv } from "../../src/sandbox.ts";
import { parseOperation } from "../../src/wire.ts";
import { requireBwrap } from "../../../../tools/test/cf-dev.ts";
import { hostEnv, sandboxPaths, sandboxReport } from "../support/sandbox.ts";
import type { SandboxPaths } from "../support/sandbox.ts";

/**
 * The machine's grant counters are its own (0225, 0194, `docs/capability.md` §5).
 *
 * @remarks
 * The counter lives in `<configDir>/grants/`, and `configDir` on a machine is `~/.config/hns` — the
 * directory 0194's sandbox hides with a tmpfs. The other half of the claim is that the agent's own
 * tools cannot read it: a tool call runs in the sandbox, so the files a call could read are the
 * sandbox's, and the counter's file is not one of them. This runs the product's exec path over a
 * real sandbox whose home holds a real counter file.
 */

const report = await sandboxReport();
const skip = report.available ? false : !requireBwrap(false, report.reason);

let paths: SandboxPaths;

beforeAll(async () => {
  const made = await sandboxPaths();
  paths = { ...made, base: await realpath(made.base) };
  // The counter the machine keeps, in the home the sandbox hides.
  const counter = new GrantCounter(join(paths.home, ".config", "hns", "grants"));
  const spent = await counter.consume({
    grantId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    maxCalls: 5,
    maxBytes: 1000,
    bytes: 10,
    now: Date.now(),
  });
  if (spent.outcome !== "allow") throw new Error("the fixture could not write its counter");
  await writeFile(join(paths.project, "readme.txt"), "project\n");
});

afterAll(async () => {
  await rm(paths.base, { recursive: true, force: true });
});

/** The machine's sandbox over the fixture's home and ROOT, as the agent builds it (D095). */
function executor(): MachineExec {
  return {
    ready: true,
    env: createMachineSandboxEnv(hostEnv(paths.project), {
      root: paths.root,
      projectRoot: paths.project,
      home: paths.home,
      bwrap: report.available ? report.bwrap : undefined,
    }),
    sandbox: report,
  };
}

/** Run one sandboxed shell command through the product's exec path. */
async function run(script: string): Promise<string> {
  const parsed = parseOperation(
    new TextEncoder().encode(JSON.stringify({ op: "exec", args: ["/bin/sh", "-c", script] })),
  );
  if (parsed.op !== "exec") throw new Error("not an exec");
  return (
    await runExec(executor(), parsed, {
      maxOutputBytes: 64 * 1024,
      signal: new AbortController().signal,
      root: paths.project,
    })
  ).output;
}

// The fixture is real: the machine wrote a counter into the hidden home.
test("the fixture wrote a counter into the home the sandbox hides", async () => {
  const shown = await run("cat " + join(paths.home, ".config", "hns", "grants") + "/*.json");
  expect(shown).not.toContain('"calls"');
});

// The agent's shell cannot list or read the counters: the directory is a tmpfs inside the sandbox.
test.skipIf(skip)("an agent's exec cannot read the grant counters", async () => {
  const listing = await run("ls -la " + join(paths.home, ".config", "hns") + " 2>&1");
  expect(listing).not.toContain("grants");
  const read = await run("cat " + join(paths.home, ".config", "hns", "grants") + "/*.json 2>&1");
  expect(read).not.toContain('"calls"');
  expect(read).not.toContain("0f8fad5b");
  // The control: the hidden directory is the counter's parent, and the counter is still there.
  const counter = new GrantCounter(join(paths.home, ".config", "hns", "grants"));
  expect(await counter.read("0f8fad5b-d9cb-469f-a165-70867728950e")).toMatchObject({ calls: 1 });
});
