import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { LEASE_REFUSALS } from "@hns/core";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";

const ROOT = resolve(import.meta.dirname, "../../../..");
const CF = join(ROOT, "node_modules", ".bin", "cf");
const WORK = join(ROOT, "tools", "deploy", ".work");
const TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 40_000;

const CONFIG = [
  'import { bindings, defineConfig, exports } from "cf/config";',
  "",
  "export default defineConfig({",
  "  worker: {",
  '    name: "hns-workspace-do-test",',
  '    compatibilityDate: "2026-10-30",',
  '    compatibilityFlags: ["nodejs_compat"],',
  '    entrypoint: "worker.ts",',
  '    exports: { Workspace: exports.durableObject({ storage: "sqlite" }) },',
  "    env: {",
  '      WORKSPACE: bindings.durableObject({ worker: "hns-workspace-do-test", exportName: "Workspace" }),',
  "    },",
  "  },",
  "});",
  "",
].join("\n");

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
const Read = v.object({ ok: v.literal(true), path: v.string(), version: v.string() });
const Apply = v.object({
  ok: v.literal(true),
  result: v.variant("status", [
    v.object({ status: v.literal("applied"), operationId: v.string(), version: v.string() }),
    v.object({
      status: v.literal("conflict"),
      operationId: v.string(),
      currentVersion: v.string(),
    }),
  ]),
});
const Refused = v.object({ ok: v.literal(false), code: v.picklist(LEASE_REFUSALS) });

interface Running {
  readonly child: ChildProcess;
  readonly output: () => string;
}

let project: string | undefined;
let running: Running | undefined;

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = v.safeParse(
        v.object({ port: v.pipe(v.number(), v.integer()) }),
        server.address(),
      );
      if (!address.success) {
        server.close();
        reject(new Error("could not allocate a port"));
        return;
      }
      const port = address.output.port;
      server.close(() => resolvePort(port));
    });
  });
}

function build(): void {
  if (!existsSync(CF)) return;
  for (const name of ["@hns/core", "@hns/store", "@hns/agent", "@hns/server"]) {
    execFileSync("npm", ["run", "build", "-w", name], {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 90_000,
    });
  }
}

async function writeProject(): Promise<string> {
  await mkdir(WORK, { recursive: true });
  const dir = await mkdtemp(join(WORK, "workspace-do-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "hns-workspace-do-test",
      private: true,
      type: "module",
      devDependencies: { wrangler: "4.156.0" },
    }),
  );
  // cf's local dev server is the Wrangler bundler; the test invokes only cf, never wrangler.
  await symlink(join("..", "..", "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "cloudflare.config.ts"), CONFIG);
  await writeFile(join(dir, "worker.ts"), WORKER);
  return dir;
}

async function collect(child: ChildProcess): Promise<Running> {
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { child, output: () => text };
}

async function health(port: number, target: Running): Promise<boolean> {
  if (target.child.exitCode !== null) {
    throw new Error("cf dev exited before becoming ready:\n" + target.output());
  }
  try {
    const response = await fetch("http://127.0.0.1:" + String(port) + "/health");
    return response.ok;
  } catch {
    return false;
  }
}

async function start(dir: string, port: number): Promise<Running> {
  const child = spawn(CF, ["dev", "--mode", "development", "--port", String(port)], {
    cwd: dir,
    detached: true,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_CACHE_HOME: join(dir, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const target = await collect(child);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await health(port, target)) return target;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await stop(target);
  throw new Error("cf dev did not become ready:\n" + target.output());
}

async function stop(target: Running | undefined): Promise<void> {
  const child = target?.child;
  if (child === undefined || child.pid === undefined || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
  await Promise.race([
    exited,
    new Promise<void>((resolveTimeout) =>
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        resolveTimeout();
      }, 5_000),
    ),
  ]);
}

async function send(
  port: number,
  method: "GET" | "POST",
  path: string,
  body?: JsonValue,
): Promise<{ readonly status: number; readonly text: string }> {
  const init =
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch("http://127.0.0.1:" + String(port) + path, init);
  return { status: response.status, text: await response.text() };
}

async function call<T>(
  port: number,
  method: "GET" | "POST",
  path: string,
  schema: v.GenericSchema<unknown, T>,
  body?: JsonValue,
): Promise<T> {
  const response = await send(port, method, path, body);
  expect(response.status, response.text).toBeLessThan(300);
  return v.parse(schema, JSON.parse(response.text));
}

function leaseBody(overrides: Record<string, JsonValue> = {}): JsonValue {
  return { workspaceId: "w1", machineId: "m1", epoch: 1, ...overrides };
}

function applyBody(overrides: Record<string, JsonValue> = {}): JsonValue {
  return {
    workspaceId: "w1",
    machineId: "m1",
    epoch: 1,
    operationId: "op-1",
    path: "a.txt",
    expectedVersion: "absent",
    version: "sha256:one",
    ...overrides,
  };
}

beforeAll(() => {
  build();
});

afterAll(async () => {
  await stop(running);
  running = undefined;
  if (project !== undefined) await rm(project, { recursive: true, force: true });
});

test.skipIf(!existsSync(CF))(
  "the Workspace DO serializes writes, fences the old epoch, and survives a restart",
  async () => {
    project = await writeProject();
    const firstPort = await freePort();
    running = await start(project, firstPort);
    try {
      const first = await call(firstPort, "POST", "/t/rpc/lease/acquire", Lease, leaseBody());
      expect(first.lease.epoch).toBe(1);

      const applied = await call(firstPort, "POST", "/t/rpc/apply", Apply, applyBody());
      expect(applied.result.status).toBe("applied");
      const read = await call(firstPort, "GET", "/t/rpc/read?path=a.txt", Read);
      expect(read.version).toBe("sha256:one");

      const concurrent = await Promise.all([
        send(
          firstPort,
          "POST",
          "/t/rpc/apply",
          applyBody({ operationId: "op-b", expectedVersion: "sha256:one", version: "sha256:two" }),
        ),
        send(
          firstPort,
          "POST",
          "/t/rpc/apply",
          applyBody({
            operationId: "op-c",
            expectedVersion: "sha256:one",
            version: "sha256:three",
          }),
        ),
      ]);
      const results = concurrent.map((response) => {
        expect(response.status, response.text).toBe(200);
        return v.parse(Apply, JSON.parse(response.text)).result;
      });
      const appliedResults = results.filter((result) => result.status === "applied");
      const conflictResults = results.filter((result) => result.status === "conflict");
      expect(appliedResults).toHaveLength(1);
      expect(conflictResults).toHaveLength(1);
      const [winner] = appliedResults;
      const [loser] = conflictResults;
      assert.ok(winner !== undefined && winner.status === "applied");
      assert.ok(loser !== undefined && loser.status === "conflict");
      expect(loser.currentVersion).toBe(winner.version);
      const winnerVersion = winner.version;

      const released = await send(firstPort, "POST", "/t/rpc/lease/release", leaseBody());
      expect(released.status).toBe(200);
      const second = await call(firstPort, "POST", "/t/rpc/lease/acquire", Lease, leaseBody());
      expect(second.lease.epoch).toBe(2);

      // Catches: a write from the previous epoch landing after a new holder acquired.
      const stale = await send(
        firstPort,
        "POST",
        "/t/rpc/apply",
        applyBody({ expectedVersion: winnerVersion, version: "sha256:stale" }),
      );
      expect(stale.status).toBe(409);
      expect(v.parse(Refused, JSON.parse(stale.text)).code).toBe("lease_epoch_stale");

      await stop(running);
      running = undefined;
      const secondPort = await freePort();
      running = await start(project, secondPort);

      // Catches: a version or lease table that is only in memory, not in DO SQLite.
      const persisted = await call(secondPort, "GET", "/t/rpc/read?path=a.txt", Read);
      expect(persisted.version).toBe(winnerVersion);
      const resumed = await call(
        secondPort,
        "POST",
        "/t/rpc/apply",
        Apply,
        applyBody({ epoch: 2, expectedVersion: winnerVersion, version: "sha256:persisted" }),
      );
      expect(resumed.result.status).toBe("applied");
    } finally {
      await stop(running);
      running = undefined;
    }
  },
  TIMEOUT_MS,
);
