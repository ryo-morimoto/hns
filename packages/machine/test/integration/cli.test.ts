import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";
import type { JsonValue } from "@hns/core";
import {
  EnrollmentOutputSchema,
  parseHealthResult,
  runCli,
  type MachineAgent,
} from "../../src/index.ts";
import { generateControlPlaneKey } from "../support/control-plane.ts";
import { createMachineTransport } from "../../../server/src/machines/transport.ts";

/**
 * (a) 0270n: the machine starts from its own CLI, and the Worker's transport reaches it.
 *
 * @remarks
 * Both sides are the product. `hns-machine enroll` makes the device key and prints what a person
 * pastes; `hns-machine run` starts the **real** `startMachineAgent` (the loopback listener, the real
 * request verifier, the real operation table); and the **production** Worker-to-machine transport
 * (`server/src/machines/transport.ts`, the module the registry probes with) signs a health request
 * with the control-plane key and gets an answer the health parser accepts.
 *
 * The one seam is the transport's `fetch`: the registry's hostname is a tunnel host and this test
 * runs on loopback, so the transport is given a fetch that rewrites the https origin to the agent's
 * own `http://127.0.0.1:<port>` and nothing else. Signing, the URL's path, the headers, the body,
 * the machine's verification, and the operation are all the product's.
 *
 * Catches: an enrollment document `run` cannot read, an agent the Worker's signing does not
 * satisfy, and a `run` that starts a machine no signed request can be answered by.
 */

/** A scratch directory for one run: the config directory and the ROOT. */
let base = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "hns-cli-0270n-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** The enrollment document as `enroll` prints it, parsed the way `run` parses it. */
function enrollmentOf(stdout: string): v.InferOutput<typeof EnrollmentOutputSchema> {
  return v.parse(EnrollmentOutputSchema, JSON.parse(stdout));
}

/** The base64url seed the control-plane pair's private half holds, as the Worker secret does. */
function seedOf(privateKey: ReturnType<typeof generateControlPlaneKey>["privateKey"]): string {
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
}

/**
 * Ask the started agent for its health through the production transport.
 *
 * @param origin - The agent's loopback origin (`http://127.0.0.1:<port>`).
 * @param seed - The control-plane seed (`HNS_CONTROL_PLANE_KEY`).
 * @param machineId - The machine id the enrollment names.
 * @returns The parsed health result.
 */
async function healthOf(
  origin: string,
  seed: string,
  machineId: string,
): Promise<ReturnType<typeof parseHealthResult>> {
  // The registry holds a tunnel hostname and the transport always signs https; the test agent is on
  // loopback. The fetch rewrite is the only stand-in, and it changes no byte of the signed request.
  const loopbackFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "machine.test") throw new Error("unexpected host: " + url.host);
    const local = new URL(origin);
    url.protocol = local.protocol;
    url.hostname = local.hostname;
    url.port = local.port;
    return await fetch(url, init);
  };
  const transport = createMachineTransport(loopbackFetch);
  const answer = await transport.call(
    { hostname: "machine.test" },
    new TextEncoder().encode(JSON.stringify({ op: "health" })),
    { controlPlaneKey: seed, machineId, requestId: "corr-0270n-health" },
  );
  if (!answer.ok)
    throw new Error("the machine did not answer: " + answer.failure + " " + answer.detail);
  const body = v.parse(
    v.object({ ok: v.literal(true), op: v.literal("health"), result: v.unknown() }),
    JSON.parse(answer.body),
  );
  // SAFETY: the agent's health result is JSON by its wire contract, which `parseHealthResult` then
  // validates; the envelope parser above only promises "some JSON" for the member.
  return parseHealthResult(body.result as JsonValue);
}

// The whole point of the issue: one command makes the key, the next starts the agent, and the
// Worker's signed call is answered by the product on both ends.
test("enroll prints what run reads, and the Worker transport reaches the started agent", async () => {
  const configDir = join(base, "config");
  const root = join(base, "root");
  await mkdir(root, { recursive: true });
  const controlPlane = generateControlPlaneKey();
  const seed = seedOf(controlPlane.privateKey);
  // enroll: the key, the fingerprint, and the document run takes.
  const enrolled = await runCli([
    "enroll",
    "--root",
    root,
    "--name",
    "machine-one",
    "--url",
    "https://machine.example",
    "--config-dir",
    configDir,
  ]);
  expect(enrolled.code, enrolled.stderr).toBe(0);
  const enrollment = enrollmentOf(enrolled.stdout);
  expect(enrollment.root).toBe(root);
  expect(enrollment.name).toBe("machine-one");
  expect(enrollment.agentUrl).toBe("https://machine.example");
  expect(enrollment.fingerprint).toMatch(/^ed25519:[0-9a-f]{32}$/u);
  // The secret stays on the machine, in files only the operator reads.
  const devicePath = join(configDir, "device.json");
  // SAFETY: this test wrote the file a moment ago in this process; the shape is the CLI's own
  // `DeviceFileSchema`, which the CLI validated before writing it.
  const device = JSON.parse(await readFile(devicePath, "utf8")) as { privateKey?: string };
  expect(device.privateKey).toBeTypeOf("string");
  expect((await stat(devicePath)).mode & 0o777).toBe(0o600);
  expect((await stat(configDir)).mode & 0o777).toBe(0o700);
  expect(enrolled.stdout).not.toContain(device.privateKey ?? "<none>");
  // run: the agent the enrollment names, with the control-plane key the Worker signs with.
  let agent: MachineAgent | undefined;
  const started = await runCli(
    ["run", "--config-dir", configDir, "--control-plane-key", seed, "--port", "0"],
    {
      onStarted: (running) => {
        agent = running;
      },
    },
  );
  try {
    expect(started.code, started.stderr).toBe(0);
    if (agent === undefined) throw new Error("the CLI did not start an agent");
    const running: MachineAgent = agent;
    const health = await healthOf(running.origin, seed, enrollment.machineId);
    // The answer is this process's own agent: the listener the CLI started, not a fixture's.
    expect(health.pid).toBe(process.pid);
    expect(health.root).toContain("root");
  } finally {
    await agent?.close();
  }
});

// Catches: enroll replacing an existing key without being told to, which would silently reimage
// the machine.
test("enroll refuses to replace an existing key without --force", async () => {
  const configDir = join(base, "config-force");
  const root = join(base, "root-force");
  await mkdir(root, { recursive: true });
  const first = await runCli(["enroll", "--root", root, "--config-dir", configDir]);
  expect(first.code, first.stderr).toBe(0);
  const again = await runCli(["enroll", "--root", root, "--config-dir", configDir]);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain("--force");
  const forced = await runCli(["enroll", "--root", root, "--config-dir", configDir, "--force"]);
  expect(forced.code, forced.stderr).toBe(0);
  expect(enrollmentOf(forced.stdout).fingerprint).not.toBe(enrollmentOf(first.stdout).fingerprint);
});

// Catches: run starting a machine with no key to verify the Worker with, or with no enrollment:
// both would look like a machine that is up while every request is refused.
test("run refuses without an enrollment or a control-plane key", async () => {
  const configDir = join(base, "config-empty");
  const withoutEnrollment = await runCli(["run", "--config-dir", configDir]);
  expect(withoutEnrollment.code).toBe(1);
  expect(withoutEnrollment.stderr).toContain("enroll");
  const root = join(base, "root-empty");
  await mkdir(root, { recursive: true });
  expect((await runCli(["enroll", "--root", root, "--config-dir", configDir])).code).toBe(0);
  const noControlPlane = await runCli(["run", "--config-dir", configDir, "--port", "0"]);
  expect(noControlPlane.code).toBe(1);
  expect(noControlPlane.stderr).toContain("--control-plane-key");
});

// Catches: a command line the CLI does not understand being treated as a run (or as success).
test("an unknown command and a flag with no value exit 2", async () => {
  expect((await runCli(["start"])).code).toBe(2);
  expect((await runCli(["run", "--config-dir"])).code).toBe(2);
  expect((await runCli([])).code).toBe(2);
});

// The enrollment document is a file run accepts, and it names the machine the agent runs as.
test("run accepts the enrollment from a file as well as from the config directory", async () => {
  const configDir = join(base, "config-stdin");
  const root = join(base, "root-stdin");
  await mkdir(root, { recursive: true });
  const controlPlane = generateControlPlaneKey();
  const seed = seedOf(controlPlane.privateKey);
  const enrolled = await runCli([
    "enroll",
    "--root",
    root,
    "--config-dir",
    configDir,
    "--machine-id",
    "machine-stdin",
  ]);
  expect(enrolled.code, enrolled.stderr).toBe(0);
  const file = join(base, "enrollment.json");
  await writeFile(file, enrolled.stdout, "utf8");
  let agent: MachineAgent | undefined;
  const outcome = await runCli(
    ["run", "--enrollment", file, "--control-plane-key", seed, "--port", "0"],
    {
      onStarted: (running) => {
        agent = running;
      },
    },
  );
  try {
    expect(outcome.code, outcome.stderr).toBe(0);
    if (agent === undefined) throw new Error("the CLI did not start an agent");
    expect(agent.origin).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+$/u);
    expect(JSON.parse(outcome.stdout)).toMatchObject({ machineId: "machine-stdin", grants: "on" });
    // The enrollment file's key is the machine's: the Worker's signed call names its id.
    const health = await healthOf(agent.origin, seed, "machine-stdin");
    expect(health.pid).toBe(process.pid);
  } finally {
    await agent?.close();
  }
});
