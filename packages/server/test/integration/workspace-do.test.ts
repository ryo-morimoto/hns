import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { LEASE_REFUSALS } from "@hns/core";

import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";

import {
  CF_DEV_WORK_DIR,
  isCfDevInstalled,
  startCfDev,
  type CfDev,
} from "../../../../tools/test/cf-dev.ts";
import { ensureDist } from "../../../../tools/test/ensure-dist.ts";

const TIMEOUT_MS = 300_000;
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
  "    exports: {",
  '      Workspace: exports.durableObject({ storage: "sqlite" }),',
  '      MigrationProbe: exports.durableObject({ storage: "sqlite" }),',
  "    },",
  "    env: {",
  '      WORKSPACE: bindings.durableObject({ worker: "hns-workspace-do-test", exportName: "Workspace" }),',
  '      MIGRATION: bindings.durableObject({ worker: "hns-workspace-do-test", exportName: "MigrationProbe" }),',
  "    },",
  "  },",
  "});",
  "",
].join("\n");

const WORKER = [
  'import { Workspace } from "@hns/server";',
  'import { JOURNAL_SCHEMA, journalUpgradeStatements } from "@hns/store";',
  "",
  "interface Storage {",
  "  readonly sql: { exec(query: string): { toArray(): unknown[] } };",
  "  transaction<T>(run: () => Promise<T>): Promise<T>;",
  "}",
  "",
  "interface Env {",
  "  readonly WORKSPACE: {",
  "    idFromName(name: string): unknown;",
  "    get(id: unknown): { fetch(request: Request): Promise<Response> };",
  "  };",
  "  readonly MIGRATION: {",
  "    idFromName(name: string): unknown;",
  "    get(id: unknown): { fetch(request: Request): Promise<Response> };",
  "  };",
  "}",
  "",
  "/**",
  " * Runs the journal upgrade from a table created with the previous DDL, so the workerd",
  " * migration (DDL inside one transaction) is proved end to end.",
  " */",
  "export class MigrationProbe {",
  "  readonly #storage: Storage;",
  "  constructor(state: { storage: Storage }) {",
  "    this.#storage = state.storage;",
  "  }",
  "  async fetch(): Promise<Response> {",
  "    for (const statement of JOURNAL_SCHEMA) {",
  '      this.#storage.sql.exec(statement.replace(", \'denied\'", ""));',
  "    }",
  "    await this.#storage.transaction(async () => {",
  "      for (const statement of journalUpgradeStatements()) this.#storage.sql.exec(statement);",
  "    });",
  "    const rows = this.#storage.sql",
  "      .exec(\"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'journal'\")",
  "      .toArray();",
  "    return new Response(JSON.stringify({ ok: true, rows }), {",
  '      headers: { "content-type": "application/json" },',
  "    });",
  "  }",
  "}",
  "",
  "export { Workspace };",
  "",
  "export default {",
  "  async fetch(request: Request, env: Env): Promise<Response> {",
  "    const url = new URL(request.url);",
  '    if (url.pathname === "/health") return new Response("ok");',
  '    if (url.pathname === "/migrate") {',
  '      return env.MIGRATION.get(env.MIGRATION.idFromName("probe")).fetch(request);',
  "    }",
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
const Refused = v.object({ ok: v.literal(false), code: v.picklist(LEASE_REFUSALS) });
const Watermark = v.object({
  ok: v.literal(true),
  watermark: v.object({ throughSeq: v.number(), at: v.string() }),
  truncated: v.number(),
});
const Conflict = v.object({ ok: v.literal(false), code: v.string() });

let project: string | undefined;
let running: CfDev | undefined;

async function writeProject(): Promise<string> {
  await mkdir(CF_DEV_WORK_DIR, { recursive: true });
  const dir = await mkdtemp(join(CF_DEV_WORK_DIR, "workspace-do-"));
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
    projectRoot: "project",
    path: "a.txt",
    expectedVersion: "absent",
    content: Buffer.from("one", "utf8").toString("base64"),
    ...overrides,
  };
}

beforeAll(() => {
  if (!isCfDevInstalled()) return;
  ensureDist(["@hns/core", "@hns/store", "@hns/agent", "@hns/server"]);
});

afterAll(async () => {
  await running?.stop();
  running = undefined;
  if (project !== undefined) await rm(project, { recursive: true, force: true });
});

test.skipIf(!isCfDevInstalled())(
  "the Workspace DO fences the old epoch and keeps the lease across a restart",
  async () => {
    project = await writeProject();
    running = await startCfDev({ cwd: project, readyTimeoutMs: READY_TIMEOUT_MS });
    const firstPort = running.port;
    try {
      const first = await call(firstPort, "POST", "/t/rpc/lease/acquire", Lease, leaseBody());
      expect(first.lease.epoch).toBe(1);
      const second = await send(firstPort, "POST", "/t/rpc/lease/acquire", leaseBody());
      expect(second.status).toBe(409);

      const released = await send(firstPort, "POST", "/t/rpc/lease/release", leaseBody());
      expect(released.status).toBe(200);
      const third = await call(firstPort, "POST", "/t/rpc/lease/acquire", Lease, leaseBody());
      expect(third.lease.epoch).toBe(2);

      // Catches: a write from the previous epoch passing after a new holder acquired. The
      // lease check runs before the machine, so no machine is configured in this project.
      const stale = await send(firstPort, "POST", "/t/rpc/apply", applyBody({ epoch: 1 }));
      expect(stale.status).toBe(409);
      expect(v.parse(Refused, JSON.parse(stale.text)).code).toBe("lease_epoch_stale");

      await running.stop();
      running = undefined;
      running = await startCfDev({ cwd: project, readyTimeoutMs: READY_TIMEOUT_MS });
      const secondPort = running.port;

      // Catches: a lease that lives only in memory, not in the object's SQLite.
      const held = await send(secondPort, "POST", "/t/rpc/lease/acquire", leaseBody());
      expect(held.status).toBe(409);
      const releaseSecond = await send(
        secondPort,
        "POST",
        "/t/rpc/lease/release",
        leaseBody({ epoch: 2 }),
      );
      expect(releaseSecond.status).toBe(200);
      const resumed = await call(secondPort, "POST", "/t/rpc/lease/acquire", Lease, leaseBody());
      expect(resumed.lease.epoch).toBe(3);
    } finally {
      await running?.stop();
      running = undefined;
    }
  },
  TIMEOUT_MS,
);

test.skipIf(!isCfDevInstalled())(
  "the Workspace DO keeps the journal watermark across a restart",
  async () => {
    project = await writeProject();
    running = await startCfDev({ cwd: project, readyTimeoutMs: READY_TIMEOUT_MS });
    const firstPort = running.port;
    try {
      const written = await call(firstPort, "POST", "/t/rpc/journal/watermark", Watermark, {
        workspaceId: "w1",
        throughSeq: 7,
      });
      expect(written.watermark.throughSeq).toBe(7);
      expect(written.truncated).toBe(0);

      // Catches: a watermark moving backwards, which would replay absorbed entries.
      const lower = await send(firstPort, "POST", "/t/rpc/journal/watermark", {
        workspaceId: "w1",
        throughSeq: 3,
      });
      expect(lower.status).toBe(409);
      expect(v.parse(Conflict, JSON.parse(lower.text)).code).toBe("conflict");

      await running.stop();
      running = undefined;
      running = await startCfDev({ cwd: project, readyTimeoutMs: READY_TIMEOUT_MS });
      const secondPort = running.port;

      // Catches: a watermark that lives only in memory, not in the object's SQLite.
      const persisted = await send(secondPort, "POST", "/t/rpc/journal/watermark", {
        workspaceId: "w1",
        throughSeq: 3,
      });
      expect(persisted.status).toBe(409);
      const same = await call(secondPort, "POST", "/t/rpc/journal/watermark", Watermark, {
        workspaceId: "w1",
        throughSeq: 7,
      });
      expect(same.watermark.throughSeq).toBe(7);
    } finally {
      await running?.stop();
      running = undefined;
    }
  },
  TIMEOUT_MS,
);
const Migration = v.object({
  ok: v.literal(true),
  rows: v.array(v.object({ sql: v.string() })),
});

test.skipIf(!isCfDevInstalled())(
  "the Workspace DO opens an existing object with the checkpoint table added",
  async () => {
    project = await writeProject();
    running = await startCfDev({ cwd: project, readyTimeoutMs: READY_TIMEOUT_MS });
    const firstPort = running.port;
    try {
      await call(firstPort, "POST", "/t/rpc/journal/watermark", Watermark, {
        workspaceId: "w1",
        throughSeq: 2,
      });
      await running.stop();
      running = undefined;
      running = await startCfDev({ cwd: project, readyTimeoutMs: READY_TIMEOUT_MS });
      const secondPort = running.port;

      // Catches: an object that cannot open over its own storage after the checkpoint table was
      // added, or a checkpoint call answering with an unhandled failure instead of a typed one.
      // No machine is configured here, so prepare must fail closed (503) after reaching the gate.
      const prepared = await send(secondPort, "POST", "/t/rpc/checkpoint/prepare", {
        workspaceId: "w1",
        runId: "run-1",
      });
      expect(prepared.status).toBe(503);
      expect(v.parse(Conflict, JSON.parse(prepared.text)).code).toBe("unavailable");
      // The edge refuses a non-pack media type before the object is reached, and the object
      // refuses a pack with no declared length after it (the edge passed the empty JSON body).
      const pack = await fetch(
        "http://127.0.0.1:" + String(secondPort) + "/t/rpc/checkpoint/run-1/pack",
        {
          method: "POST",
          headers: { "content-type": "text/plain", "content-length": "1" },
          body: "x",
        },
      );
      const packText = await pack.text();
      // The deployment's OBJECTS binding is not in this project, so the pack path fails closed
      // with a typed 503 instead of accepting bytes it cannot store.
      expect(pack.status, packText).toBe(503);
      expect(v.parse(Conflict, JSON.parse(packText)).code).toBe("unavailable");
      // The object still serves its existing faces: the restart kept the watermark.
      const lower = await send(secondPort, "POST", "/t/rpc/journal/watermark", {
        workspaceId: "w1",
        throughSeq: 1,
      });
      expect(lower.status).toBe(409);
    } finally {
      await running?.stop();
      running = undefined;
    }
  },
  TIMEOUT_MS,
);

test.skipIf(!isCfDevInstalled())(
  "the journal table is rebuilt from the previous DDL inside a transaction",
  async () => {
    project = await writeProject();
    running = await startCfDev({ cwd: project, readyTimeoutMs: READY_TIMEOUT_MS });
    const port = running.port;
    try {
      const response = await fetch("http://127.0.0.1:" + String(port) + "/migrate");
      expect(response.status).toBe(200);
      const body = v.parse(Migration, await response.json());
      // Catches: a workerd SQLite build that refuses DDL (rename/copy/drop) in a transaction.
      expect(body.rows[0]?.sql).toContain("'denied'");
    } finally {
      await running?.stop();
      running = undefined;
    }
  },
  TIMEOUT_MS,
);
