import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import * as v from "valibot";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const CF = join(ROOT, "node_modules", ".bin", "cf");
const WORK = join(ROOT, "tools", "deploy", ".work");
const READY_TIMEOUT_MS = 40_000;

/** The provider key the test deployment configures; no real key is ever used. */
export const TEST_PROVIDER_KEY = "test-provider-key";

/** What the fake provider answers next. */
export interface FakeProvider {
  readonly url: string;
  /** How many model calls reached the provider. */
  hits(): number;
  /** The authorization header of the latest call, so the test sees which key arrived. */
  lastAuthorization(): string | undefined;
  /** Set the status of the following responses. */
  setStatus(status: number): void;
  dispose(): Promise<void>;
}

/**
 * A provider stand-in on loopback.
 *
 * @remarks
 * The gateway's upstream is env configuration, so the integration test points the real
 * worker at this process and observes exactly which calls got through.
 */
export async function startFakeProvider(): Promise<FakeProvider> {
  let status = 200;
  let hits = 0;
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    hits += 1;
    authorization = request.headers.authorization;
    request.resume();
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [], path: request.url }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const port = v.parse(v.object({ port: v.number() }), server.address()).port;
  return {
    url: "http://127.0.0.1:" + String(port) + "/v1/chat/completions",
    hits: () => hits,
    lastAuthorization: () => authorization,
    setStatus: (next) => {
      status = next;
    },
    dispose: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

/** One read of the budget row. */
const budgetRow = v.object({
  day_key: v.string(),
  month_key: v.string(),
  day_spent: v.number(),
  month_spent: v.number(),
  day_limit: v.number(),
  month_limit: v.number(),
  stopped: v.number(),
});

/** The parsed budget row. */
type BudgetRow = v.InferOutput<typeof budgetRow>;

/** What a seed writes into the row. */
interface Seed {
  readonly dayLimit?: number | undefined;
  readonly monthLimit?: number | undefined;
  readonly stopped?: boolean | undefined;
  readonly dayKey?: string | undefined;
  readonly monthKey?: string | undefined;
  readonly daySpent?: number | undefined;
  readonly monthSpent?: number | undefined;
  /** Drop the table first, so the migration's own row and defaults are observable. */
  readonly reset?: boolean | undefined;
}

/** The gateway project running under cf dev, plus its test-only routes. */
export interface GatewayHarness {
  /** Apply the migrations and write a known budget row; returns the row afterwards. */
  seed(input: Seed): Promise<BudgetRow>;
  /** Read the budget row. */
  row(): Promise<BudgetRow>;
  /** Spend the real budget module with an explicit instant. */
  reserve(input: { amount: number; at: string }): Promise<string>;
  /** Release a reservation through the real budget module. */
  refund(input: { amount: number; at: string }): Promise<void>;
  /** Call a model route (or any path) on the worker. */
  call(path: string, body?: string): Promise<Response>;
  dispose(): Promise<void>;
}

interface Running {
  readonly child: ChildProcess;
  readonly output: () => string;
}

const collect = (child: ChildProcess): Running => {
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { child, output: () => text };
};

const healthy = async (port: number, running: Running): Promise<boolean> => {
  if (running.child.exitCode !== null) {
    throw new Error("cf dev exited before becoming ready:\n" + running.output());
  }
  try {
    const response = await fetch("http://127.0.0.1:" + String(port) + "/health");
    return response.ok;
  } catch {
    return false;
  }
};

const stop = async (running: Running | undefined): Promise<void> => {
  const child = running?.child;
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
};

const config = (upstream: string): string =>
  [
    'import { bindings, defineConfig } from "cf/config";',
    "",
    "export default defineConfig({",
    "  worker: {",
    '    name: "hns-gateway-test",',
    '    compatibilityDate: "2026-10-30",',
    '    compatibilityFlags: ["nodejs_compat"],',
    '    entrypoint: "worker.ts",',
    "    env: {",
    '      DB: bindings.d1({ name: "hns-gateway-test" }),',
    '      HNS_GATEWAY_CALL_PRICE_USD: bindings.text("1"),',
    "      HNS_GATEWAY_OLLAMA_CLOUD_URL: bindings.text(" + JSON.stringify(upstream) + "),",
    '      OLLAMA_CLOUD_API_KEY: bindings.text("' + TEST_PROVIDER_KEY + '"),',
    "    },",
    "  },",
    "});",
    "",
  ].join("\n");

// The worker runs the product modules verbatim; only /health, /seed, /row, and /budget are test routes.
const worker = [
  'import { createBudget, dayKey, monthKey } from "../../../../packages/server/src/gateway/budget.ts";',
  'import gateway from "../../../../packages/server/src/gateway/index.ts";',
  'import { MIGRATIONS } from "../../../../packages/store/src/migrations/index.ts";',
  "",
  "interface Statement {",
  "  bind(...values: unknown[]): Statement;",
  "  run(): Promise<{ meta?: { changes?: number } }>;",
  "  first(): Promise<unknown>;",
  "  all(): Promise<{ results?: unknown[] }>;",
  "}",
  "interface Database {",
  "  prepare(sql: string): Statement;",
  "}",
  "interface Env {",
  "  DB: Database;",
  "}",
  "",
  "const migrate = async (db: Database): Promise<void> => {",
  "  for (const migration of MIGRATIONS) {",
  '    for (const statement of migration.sql.split(";")) {',
  "      const sql = statement.trim();",
  "      if (sql.length > 0) await db.prepare(sql).run();",
  "    }",
  "  }",
  "};",
  "",
  'const readRow = (db: Database): Promise<unknown> => db.prepare("SELECT * FROM provider_gateway WHERE id = ?1").bind("gateway").first();',
  "",
  "const number = (input: Record<string, unknown>, name: string, fallback: number): number => {",
  "  const value = input[name];",
  '  return typeof value === "number" ? value : fallback;',
  "};",
  "",
  "const text = (input: Record<string, unknown>, name: string, fallback: string): string => {",
  "  const value = input[name];",
  '  return typeof value === "string" ? value : fallback;',
  "};",
  "",
  "export default {",
  "  async fetch(request: Request, env: Env): Promise<Response> {",
  "    const url = new URL(request.url);",
  '    if (url.pathname === "/health") return new Response("ok");',
  '    if (url.pathname === "/row") return Response.json(await readRow(env.DB));',
  '    if (url.pathname === "/seed" && request.method === "POST") {',
  "      const input: Record<string, unknown> = await request.json();",
  '      if (input.reset === true) await env.DB.prepare("DROP TABLE IF EXISTS provider_gateway").run();',
  "      await migrate(env.DB);",
  "      if (input.reset === true) return Response.json(await readRow(env.DB));",
  "      const now = new Date();",
  '      const day = text(input, "dayKey", dayKey(now));',
  '      const month = text(input, "monthKey", monthKey(now));',
  "      await env.DB",
  "        .prepare(",
  '          "UPDATE provider_gateway SET day_limit = ?1, month_limit = ?2, stopped = ?3, day_key = ?4, month_key = ?5, day_spent = ?6, month_spent = ?7, updated_at = ?8 WHERE id = ?9",',
  "        )",
  "        .bind(",
  '          number(input, "dayLimit", 100),',
  '          number(input, "monthLimit", 1000),',
  "          input.stopped === true ? 1 : 0,",
  "          day,",
  "          month,",
  '          number(input, "daySpent", 0),',
  '          number(input, "monthSpent", 0),',
  "          new Date().toISOString(),",
  '          "gateway",',
  "        )",
  "        .run();",
  "      return Response.json(await readRow(env.DB));",
  "    }",
  '    if (url.pathname === "/budget" && request.method === "POST") {',
  "      const input: Record<string, unknown> = await request.json();",
  '      const amount = number(input, "amount", 0);',
  '      const at = new Date(text(input, "at", new Date().toISOString()));',
  "      const budget = createBudget(env.DB);",
  '      if (text(input, "op", "reserve") === "refund") {',
  "        await budget.refund(amount, at);",
  "        return Response.json({ ok: true });",
  "      }",
  "      return Response.json({ result: await budget.reserve(amount, at) });",
  "    }",
  "    return gateway.fetch(request, env);",
  "  },",
  "};",
  "",
].join("\n");

/**
 * Start the gateway Worker under cf dev with a real D1 database.
 *
 * @remarks
 * The project lives under `tools/deploy/.work` (ignored) because cf needs its own project
 * root with a `wrangler` dependency; `node_modules` points at the deploy project's install.
 */
export async function startGateway(upstream: string): Promise<GatewayHarness> {
  if (!existsSync(CF)) throw new Error("cf is not installed");
  await mkdir(WORK, { recursive: true });
  const directory = await mkdtemp(join(WORK, "gateway-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "hns-gateway-test",
      private: true,
      type: "module",
      devDependencies: { wrangler: "4.156.0" },
    }),
  );
  await symlink(join("..", "..", "node_modules"), join(directory, "node_modules"));
  await writeFile(join(directory, "cloudflare.config.ts"), config(upstream));
  await writeFile(join(directory, "worker.ts"), worker);
  const port = await freePort();
  const child = spawn(CF, ["dev", "--mode", "development", "--port", String(port)], {
    cwd: directory,
    detached: true,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CACHE_HOME: join(directory, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running = collect(child);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await healthy(port, running)) {
      return harness(directory, running, port);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await stop(running);
  throw new Error("cf dev did not become ready:\n" + running.output());
}

const expectOk = (response: Response): void => {
  if (!response.ok) throw new Error("the test route failed: " + String(response.status));
};

const harness = (directory: string, running: Running, port: number): GatewayHarness => {
  const base = "http://127.0.0.1:" + String(port);
  const post = (path: string, body: string): Promise<Response> =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  return {
    async seed(input) {
      return v.parse(budgetRow, await (await post("/seed", JSON.stringify(input))).json());
    },
    async row() {
      return v.parse(budgetRow, await (await fetch(base + "/row")).json());
    },
    async reserve(input) {
      const response = await post("/budget", JSON.stringify({ op: "reserve", ...input }));
      return v.parse(v.object({ result: v.string() }), await response.json()).result;
    },
    async refund(input) {
      expectOk(await post("/budget", JSON.stringify({ op: "refund", ...input })));
    },
    call: (path, body = '{"model":"m"}') =>
      fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    async dispose() {
      await stop(running);
      await rm(directory, { recursive: true, force: true });
    },
  };
};

const freePort = async (): Promise<number> =>
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = v.parse(v.object({ port: v.number() }), server.address()).port;
      server.close(() => resolvePort(port));
    });
  });
