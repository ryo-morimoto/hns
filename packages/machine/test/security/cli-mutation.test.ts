import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { runCli, type MachineAgent } from "../../src/index.ts";
import { generateControlPlaneKey } from "../support/control-plane.ts";
import { createMachineTransport } from "../../../server/src/machines/transport.ts";

/**
 * Mutation probe for the machine CLI (0270n): the start point the issue is about.
 *
 * @remarks
 * **M3 — `run` starts the agent without the control-plane keys.** A CLI that starts
 * `startMachineAgent` with no `controlPlane` (or with the wrong key) looks like it started: the
 * listener binds, the port answers, and the printed summary says `grants: "on"`. Every request the
 * Worker signs is then refused — the machine is up and unreachable, which is the failure this issue
 * exists to remove. The probe runs the product CLI **without** `--control-plane-key` and requires it
 * to refuse to start (exit 1), which is what makes the product test's success meaningful.
 *
 * **M4 — the enrollment printed by `enroll` is not what `run` reads.** A CLI whose two commands
 * disagree about the document is a machine that cannot be started from its own output. The probe
 * feeds `run` a document the product schema refuses and requires a refusal (not a start).
 */

let base = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "hns-cli-mutation-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The seed of a control-plane pair, base64url, as the Worker secret holds it. */
function seedOf(pair: ReturnType<typeof generateControlPlaneKey>): string {
  const der = pair.privateKey.export({ format: "der", type: "pkcs8" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
}

// M3: a machine that cannot verify the Worker must not start, rather than start unreachable.
test("M3: run without a control-plane key refuses instead of starting an unreachable agent", async () => {
  const configDir = join(base, "config-no-key");
  const root = join(base, "root-no-key");
  await mkdir(root, { recursive: true });
  const enrolled = await runCli(["enroll", "--root", root, "--config-dir", configDir]);
  expect(enrolled.code, enrolled.stderr).toBe(0);
  let started: MachineAgent | undefined;
  const outcome = await runCli(["run", "--config-dir", configDir, "--port", "0"], {
    onStarted: (agent) => {
      started = agent;
    },
  });
  try {
    // The mutation would be `exit 0` with a listener bound and no key: the probe requires the refusal.
    expect(outcome.code).toBe(1);
    expect(started).toBeUndefined();
    expect(outcome.stderr).toContain("--control-plane-key");
  } finally {
    await started?.close();
  }
});

// M4: an enrollment run cannot read is refused before anything is started.
test("M4: run refuses an enrollment that is not this CLI`s output", async () => {
  const root = join(base, "root-bad-doc");
  await mkdir(root, { recursive: true });
  const pair = generateControlPlaneKey();
  const file = join(base, "enrollment-bad.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, JSON.stringify({ publicKey: "not the document" }), "utf8");
  let started: MachineAgent | undefined;
  const outcome = await runCli(
    ["run", "--enrollment", file, "--control-plane-key", seedOf(pair), "--port", "0"],
    {
      onStarted: (agent) => {
        started = agent;
      },
    },
  );
  try {
    expect(outcome.code).toBe(1);
    expect(started).toBeUndefined();
  } finally {
    await started?.close();
  }
});

// The transport the product test uses is the Worker`s own; this pins that it signs a real request
// (a wrong key is refused by the agent it was not enrolled with), so the (a) test is not passing
// because the agent accepts anything.
test("M3: a transport signing with another key is refused by the started agent", async () => {
  const configDir = join(base, "config-wrong-key");
  const root = join(base, "root-wrong-key");
  await mkdir(root, { recursive: true });
  const enrolled = generateControlPlaneKey();
  const stranger = generateControlPlaneKey();
  const seeded = await runCli(["enroll", "--root", root, "--config-dir", configDir]);
  expect(seeded.code, seeded.stderr).toBe(0);
  let started: MachineAgent | undefined;
  const outcome = await runCli(
    ["run", "--config-dir", configDir, "--control-plane-key", seedOf(enrolled), "--port", "0"],
    {
      onStarted: (agent) => {
        started = agent;
      },
    },
  );
  try {
    expect(outcome.code, outcome.stderr).toBe(0);
    if (started === undefined) throw new Error("the CLI did not start an agent");
    const local = new URL(started.origin);
    const loopback: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      url.protocol = local.protocol;
      url.hostname = local.hostname;
      url.port = local.port;
      return await fetch(url, init);
    };
    const answer = await createMachineTransport(loopback).call(
      { hostname: "machine.test" },
      new TextEncoder().encode(JSON.stringify({ op: "health" })),
      { controlPlaneKey: seedOf(stranger), machineId: "machine" },
    );
    expect(answer).toMatchObject({ ok: false, failure: "refused" });
  } finally {
    await started?.close();
  }
});
