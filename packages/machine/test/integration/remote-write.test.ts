import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startMachineAgent, type MachineAgent, type MachineLogSink } from "../../src/index.ts";
import type { JsonValue, ObsLogEntry } from "@hns/core";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";
import {
  CF_DEV_WORK_DIR,
  isCfDevInstalled,
  startCfDev,
  type CfDev,
} from "../../../../tools/test/cf-dev.ts";

/**
 * The real path, end to end: a cf dev Worker's Workspace object calls a real machine agent
 * (127.0.0.1) that writes a real file.
 *
 * @remarks
 * The Worker signs with the control-plane key and the machine verifies with the enrolled public
 * half (D100). The machine agent runs in this process; the Durable Object runs in workerd. The
 * project's worker.ts imports `@hns/server` through the repository's hoisted node_modules
 * (the packages are built first); the machine package is the only package this file imports.
 */

const ROOT = resolve(import.meta.dirname, "../../../..");
const TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 40_000;
const MACHINE_ID = "machine-1";

/** The cf dev project: one Worker that forwards /t/rpc/* to the Workspace object. */
function configFor(agentUrl: string, seed: string): string {
  return [
    'import { bindings, defineConfig, exports } from "cf/config";',
    "",
    "export default defineConfig({",
    "  worker: {",
    '    name: "hns-machine-remote-test",',
    '    compatibilityDate: "2026-10-30",',
    '    compatibilityFlags: ["nodejs_compat"],',
    '    entrypoint: "worker.ts",',
    '    exports: { Workspace: exports.durableObject({ storage: "sqlite" }) },',
    "    env: {",
    '      WORKSPACE: bindings.durableObject({ worker: "hns-machine-remote-test", exportName: "Workspace" }),',
    "      HNS_AGENT_URL: bindings.text(" + JSON.stringify(agentUrl) + "),",
    "      HNS_CONTROL_PLANE_KEY: bindings.text(" + JSON.stringify(seed) + "),",
    "    },",
    "  },",
    "});",
    "",
  ].join("\n");
}

const WORKER = [
  'import { Workspace } from "@hns/server";',
  "",
  "interface Env {",
  "  readonly WORKSPACE: {",
  "    idFromName(name: string): unknown;",
  "    get(id: unknown): { fetch(request: Request): Promise<Response> };",
  "  };",
  "}",
  "",
  "export { Workspace };",
  "",
  "export default {",
  "  async fetch(request: Request, env: Env): Promise<Response> {",
  "    const url = new URL(request.url);",
  '    if (url.pathname === "/health") return new Response("ok");',
  '    if (!url.pathname.startsWith("/t/")) return new Response("not found", { status: 404 });',
  '    const forwarded = new Request("https://workspace" + url.pathname.slice(2) + url.search, request);',
  '    return env.WORKSPACE.get(env.WORKSPACE.idFromName("w1")).fetch(forwarded);',
  "  },",
  "};",
  "",
].join("\n");

const Lease = v.object({
  ok: v.literal(true),
  lease: v.object({
    workspaceId: v.string(),
    machineId: v.string(),
    epoch: v.number(),
    expiresAt: v.string(),
  }),
});
const Read = v.object({
  ok: v.literal(true),
  path: v.string(),
  version: v.string(),
  content: v.string(),
  externalChange: v.boolean(),
});
const Apply = v.object({
  ok: v.literal(true),
  result: v.variant("status", [
    v.object({ status: v.literal("applied"), operationId: v.string(), version: v.string() }),
    v.object({
      status: v.literal("conflict"),
      operationId: v.string(),
      currentVersion: v.string(),
    }),
    v.object({
      status: v.literal("unknown"),
      operationId: v.string(),
      reason: v.picklist(["io", "crash", "timeout"]),
    }),
  ]),
});
const Refused = v.object({ ok: v.literal(false), code: v.string() });

let running: CfDev | undefined;
let machine: MachineAgent | undefined;
let machineRoot = "";
let agentUrl = "";
let seed = "";
const projects: string[] = [];
const machineLogs: ObsLogEntry[] = [];

const onMachineLog: MachineLogSink = (entry) => machineLogs.push(entry);

function build(): void {
  if (!isCfDevInstalled()) return;
  for (const name of ["@hns/core", "@hns/store", "@hns/agent", "@hns/server"]) {
    execFileSync("npm", ["run", "build", "-w", name], {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 90_000,
    });
  }
}

/** The base64url seed of the control-plane key, as the Worker secret carries it. */
function seedOf(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"]): string {
  const jwk = v.parse(
    v.object({ d: v.pipe(v.string(), v.minLength(1)) }),
    privateKey.export({ format: "jwk" }),
  );
  return jwk.d;
}

/** The raw 32-byte public half the machine enrolls. */
function rawPublicKey(publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"]): Uint8Array {
  const der = publicKey.export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(12));
}

async function writeProject(agentUrl: string, seed: string): Promise<string> {
  await mkdir(CF_DEV_WORK_DIR, { recursive: true });
  const dir = await mkdtemp(join(CF_DEV_WORK_DIR, "machine-remote-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "hns-machine-remote-test",
      private: true,
      type: "module",
      devDependencies: { wrangler: "4.156.0" },
    }),
  );
  await symlink(join("..", "..", "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "cloudflare.config.ts"), configFor(agentUrl, seed));
  await writeFile(join(dir, "worker.ts"), WORKER);
  return dir;
}

async function call<T>(
  port: number,
  method: "GET" | "POST",
  path: string,
  schema: v.GenericSchema<unknown, T>,
  body?: JsonValue,
  requestId?: string,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (requestId !== undefined) headers["x-request-id"] = requestId;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch("http://127.0.0.1:" + String(port) + path, init);
  const text = await response.text();
  expect(response.status, text).toBeLessThan(300);
  return v.parse(schema, JSON.parse(text));
}

/** base64 of the text, the RPC's content encoding. */
function encoded(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function applyBody(overrides: Record<string, string> = {}): JsonValue {
  return {
    workspaceId: "w1",
    operationId: "op-1",
    projectRoot: "project",
    path: "a.txt",
    expectedVersion: "absent",
    content: encoded("one"),
    ...overrides,
  };
}

beforeAll(async () => {
  build();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  machineRoot = await mkdtemp(join(CF_DEV_WORK_DIR, "machine-root-"));
  await mkdir(join(machineRoot, "project"));
  machine = await startMachineAgent({
    root: machineRoot,
    machineId: MACHINE_ID,
    controlPlane: { publicKeys: async () => [rawPublicKey(publicKey)] },
    port: 0,
    onLog: onMachineLog,
  });
  agentUrl = machine.origin;
  seed = seedOf(privateKey);
});

/** One fresh cf dev project, so the object state of one test does not leak into the next. */
async function newProject(): Promise<string> {
  const dir = await writeProject(agentUrl, seed);
  projects.push(dir);
  return dir;
}

afterAll(async () => {
  await running?.stop();
  running = undefined;
  await machine?.close();
  machine = undefined;
  for (const project of projects) await rm(project, { recursive: true, force: true });
  if (machineRoot !== "") await rm(machineRoot, { recursive: true, force: true });
});

test.skipIf(!isCfDevInstalled())(
  "a save travels from the Workspace object to the machine and back",
  async () => {
    if (machine === undefined) throw new Error("setup failed");
    const cwd = await newProject();
    running = await startCfDev({ cwd, readyTimeoutMs: READY_TIMEOUT_MS });
    const port = running.port;
    try {
      const lease = await call(port, "POST", "/t/rpc/lease/acquire", Lease, {
        workspaceId: "w1",
        machineId: MACHINE_ID,
      });
      expect(lease.lease.machineId).toBe(MACHINE_ID);

      // 1. A save applies on the machine and the file on disk matches.
      const applied = await call(port, "POST", "/t/rpc/apply", Apply, applyBody(), "corr-save");
      if (applied.result.status !== "applied") {
        console.log("cf dev output:\n" + (running?.output() ?? ""));
      }
      assert.equal(applied.result.status, "applied");
      expect(await readFile(join(machineRoot, "project", "a.txt"), "utf8")).toBe("one");

      // 2. Retrying the same attempt returns the recorded outcome without a second write.
      const retried = await call(port, "POST", "/t/rpc/apply", Apply, applyBody(), "corr-retry");
      expect(retried.result).toStrictEqual(applied.result);

      // 3. A read comes from the machine, with the version of the bytes and the fs log line
      //    carrying the correlation id that is not part of the signature.
      const read = await call(
        port,
        "GET",
        "/t/rpc/read?projectRoot=project&path=a.txt",
        Read,
        undefined,
        "corr-read",
      );
      assert.equal(applied.result.status, "applied");
      expect(read.version).toBe(applied.result.version);
      expect(read.externalChange).toBe(false);
      expect(Buffer.from(read.content, "base64").toString("utf8")).toBe("one");
      const log = machineLogs.find((entry) => entry.requestId === "corr-read");
      expect(log, "the fs log line for the read").toMatchObject({
        hop: "fs",
        path: "/project/a.txt",
      });

      // 4. An outside write (the agent's shell) is visible as an external change.
      await writeFile(join(machineRoot, "project", "a.txt"), "outside");
      const afterOutside = await call(
        port,
        "GET",
        "/t/rpc/read?projectRoot=project&path=a.txt",
        Read,
      );
      expect(afterOutside.externalChange).toBe(true);

      // 5. A save from a stale version is a conflict with what the machine has now.
      const stale = await call(
        port,
        "POST",
        "/t/rpc/apply",
        Apply,
        applyBody({ operationId: "op-2", content: encoded("two") }),
      );
      assert.equal(stale.result.status, "conflict");
      expect(await readFile(join(machineRoot, "project", "a.txt"), "utf8")).toBe("outside");

      // 6. Two concurrent saves from the same version: the machine serializes, one conflicts.
      const fresh = await call(port, "GET", "/t/rpc/read?projectRoot=project&path=a.txt", Read);
      const concurrentBodies = ["b", "c"].map((text, index) => ({
        body: applyBody({
          operationId: "op-race-" + String(index),
          expectedVersion: fresh.version,
          content: encoded(text),
        }),
      }));
      const responses = await Promise.all(
        concurrentBodies.map((item) => call(port, "POST", "/t/rpc/apply", Apply, item.body)),
      );
      const appliedCount = responses.filter((item) => item.result.status === "applied").length;
      const conflictCount = responses.filter((item) => item.result.status === "conflict").length;
      expect({ appliedCount, conflictCount }).toStrictEqual({ appliedCount: 1, conflictCount: 1 });

      // 7. Observability: the save's request id reached the machine without being signed.
      expect(machineLogs.some((entry) => entry.requestId === "corr-save")).toBe(true);

      // 8. Save latency: 20 sequential saves, recorded in the issue (end-to-end <= 1s, DO-side
      //    <= 150ms). No timing assertion: the numbers are the evidence, not a gate.
      const durations: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const started = performance.now();
        const body = applyBody({
          operationId: "op-perf-" + String(index),
          path: "perf-" + String(index) + ".txt",
          content: encoded("v" + String(index)),
        });
        const answer = await call(port, "POST", "/t/rpc/apply", Apply, body);
        durations.push(performance.now() - started);
        assert.equal(answer.result.status, "applied");
      }
      durations.sort((left, right) => left - right);
      const at = (fraction: number): number =>
        durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))] ?? 0;
      console.log(
        "save latency ms: p50=" +
          at(0.5).toFixed(1) +
          " p95=" +
          at(0.95).toFixed(1) +
          " n=" +
          String(durations.length),
      );
    } finally {
      await running?.stop();
      running = undefined;
    }
  },
  TIMEOUT_MS,
);

test.skipIf(!isCfDevInstalled())(
  "a stopped machine leaves reads unreadable and saves unknown",
  async () => {
    if (machine === undefined) throw new Error("setup failed");
    const cwd = await newProject();
    running = await startCfDev({ cwd, readyTimeoutMs: READY_TIMEOUT_MS });
    const port = running.port;
    try {
      await call(port, "POST", "/t/rpc/lease/acquire", Lease, {
        workspaceId: "w1",
        machineId: MACHINE_ID,
      });
      await call(port, "POST", "/t/rpc/apply", Apply, applyBody());
      await machine.close();
      machine = undefined;

      const read = await fetch(
        "http://127.0.0.1:" + String(port) + "/t/rpc/read?projectRoot=project&path=a.txt",
      );
      expect(read.status).toBe(503);
      expect(v.parse(Refused, await read.json()).code).toBe("unavailable");

      const write = await call(
        port,
        "POST",
        "/t/rpc/apply",
        Apply,
        applyBody({ operationId: "op-offline", content: encoded("offline") }),
      );
      assert.equal(write.result.status, "unknown");
    } finally {
      await running?.stop();
      running = undefined;
    }
  },
  TIMEOUT_MS,
);
