import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import * as v from "valibot";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const CF = join(ROOT, "node_modules", ".bin", "cf");
const WORK = join(ROOT, "tools", "deploy", ".work");
const READY_TIMEOUT_MS = 30_000;

/** The limits the harness can set; every field defaults to the seeded value. */
interface LimitSeed {
  readonly doRows?: number | undefined;
  readonly doRequests?: number | undefined;
  readonly r2Objects?: number | undefined;
}

/** One turn for the harness to record. */
interface TurnSeed {
  readonly id: string;
  readonly conversationId?: string | undefined;
  readonly at: string;
  readonly outcome?: string | undefined;
  readonly doRows: number;
  readonly doRequests?: number | undefined;
  readonly r2Objects?: number | undefined;
}

/** The provider budget row for the month a turn belongs to. */
interface ProviderSeed {
  readonly monthKey: string;
  readonly monthSpent: number;
  readonly monthLimit: number;
}

/** The limit row as the product module returns it. */
interface LimitRow {
  readonly doRows: number;
  readonly doRequests: number;
  readonly r2Objects: number;
  readonly warnRatio: number;
  readonly criticalRatio: number;
}

/** The month total as the product module returns it. */
interface MonthTotal {
  readonly doRows: number;
  readonly doRequests: number;
  readonly r2Objects: number;
}

/** What an admission decided. */
type Admission =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: "limit"; readonly budget: string }
  | { readonly ok: false; readonly refusal: "gauge" };

/** The cost project running under cf dev, plus its test-only routes. */
export interface CostHarness {
  /** Apply every migration to the real D1 database. */
  migrate(): Promise<void>;
  /** Apply the migrations and set the monthly limits. */
  setLimits(seed: LimitSeed): Promise<void>;
  /** Read the limit row through the product module. */
  limits(): Promise<LimitRow>;
  /** Record one turn through the product module. */
  record(turn: TurnSeed): Promise<boolean>;
  /** The month total through the product module. */
  month(at: string): Promise<MonthTotal>;
  /** Set the provider gateway's month. */
  setProvider(seed: ProviderSeed): Promise<void>;
  /** Ask the product gate to admit a run at an instant. */
  admit(at: string): Promise<Admission>;
  /** Drop the limit table so the next admission has to fail closed. */
  dropLimits(): Promise<void>;
  /** Empty the ledger and restore the seeded limits, so one test cannot leak into the next. */
  reset(): Promise<void>;
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
    // Bound the probe: a socket that accepts but never answers must not hold the start loop
    // past its own deadline.
    const response = await fetch("http://127.0.0.1:" + String(port) + "/health", {
      signal: AbortSignal.timeout(2_000),
    });
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

/**
 * Take a port below the kernel's ephemeral range.
 *
 * @remarks
 * The gateway and session suites let the kernel choose (32768 and up), so choosing from this
 * fixed range cannot race with them between the probe and cf dev's bind.
 */
async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = 18_100 + Math.floor(Math.random() * 900);
    const free = await new Promise<boolean>((resolveTry) => {
      const server = createServer();
      server.once("error", () => resolveTry(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolveTry(true));
      });
    });
    if (free) return port;
  }
  throw new Error("could not allocate a port for the cost project");
}

const CONFIG = [
  'import { bindings, defineConfig } from "cf/config";',
  "",
  "export default defineConfig({",
  "  worker: {",
  '    name: "hns-cost-test",',
  '    compatibilityDate: "2026-10-30",',
  '    compatibilityFlags: ["nodejs_compat"],',
  '    entrypoint: "worker.ts",',
  "    env: {",
  '      DB: bindings.d1({ name: "hns-cost-test" }),',
  "    },",
  "  },",
  "});",
  "",
].join("\n");

// The worker runs the product modules verbatim; only the routes below are test scaffolding.
const WORKER = [
  'import { MIGRATIONS } from "../../../../packages/store/src/migrations/index.ts";',
  'import { CostGaugeUnavailableError, CostLimitError, createCostGate } from "../../../../packages/server/src/cost/index.ts";',
  'import { readCostLimits } from "../../../../packages/server/src/cost/limits.ts";',
  'import { readMonthlyTotal, recordTurn } from "../../../../packages/server/src/cost/ledger.ts";',
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
  "// admit() reads only the database; the storage is unused on that path.",
  "const storage = { sql: { exec: () => ({ toArray: () => [] }) } };",
  "",
  "export default {",
  "  async fetch(request: Request, env: Env): Promise<Response> {",
  "    const url = new URL(request.url);",
  '    if (url.pathname === "/health") return new Response("ok");',
  '    if (url.pathname === "/migrate" && request.method === "POST") {',
  "      await migrate(env.DB);",
  "      return Response.json({ ok: true });",
  "    }",
  '    if (url.pathname === "/limits" && request.method === "GET") return Response.json(await readCostLimits(env.DB));',
  '    if (url.pathname === "/limits" && request.method === "POST") {',
  "      const input: Record<string, unknown> = await request.json();",
  "      await migrate(env.DB);",
  "      await env.DB",
  "        .prepare(",
  "          \"UPDATE cost_limits SET do_rows_limit = ?1, do_requests_limit = ?2, r2_objects_limit = ?3 WHERE id = 'cost'\",",
  "        )",
  '        .bind(number(input, "doRows", 50000000), number(input, "doRequests", 1000000), number(input, "r2Objects", 1000000))',
  "        .run();",
  "      return Response.json({ ok: true });",
  "    }",
  '    if (url.pathname === "/record" && request.method === "POST") {',
  "      const input: Record<string, unknown> = await request.json();",
  "      const inserted = await recordTurn(env.DB, {",
  '        id: text(input, "id", ""),',
  '        conversationId: text(input, "conversationId", "2"),',
  '        at: new Date(text(input, "at", new Date().toISOString())),',
  '        outcome: text(input, "outcome", "completed") === "failed" ? "failed" : "completed",',
  '        doRows: number(input, "doRows", 0),',
  '        doRequests: number(input, "doRequests", 0),',
  '        r2Objects: number(input, "r2Objects", 0),',
  "      });",
  "      return Response.json({ inserted });",
  "    }",
  '    if (url.pathname === "/month") {',
  '      const at = url.searchParams.get("at") ?? new Date().toISOString();',
  "      return Response.json(await readMonthlyTotal(env.DB, new Date(at)));",
  "    }",
  '    if (url.pathname === "/provider" && request.method === "POST") {',
  "      const input: Record<string, unknown> = await request.json();",
  "      await migrate(env.DB);",
  "      await env.DB",
  "        .prepare(",
  "          \"UPDATE provider_gateway SET month_key = ?1, month_spent = ?2, month_limit = ?3 WHERE id = 'gateway'\",",
  "        )",
  '        .bind(text(input, "monthKey", "1970-01"), number(input, "monthSpent", 0), number(input, "monthLimit", 50))',
  "        .run();",
  "      return Response.json({ ok: true });",
  "    }",
  '    if (url.pathname === "/admit" && request.method === "POST") {',
  "      const input: Record<string, unknown> = await request.json();",
  "      const gate = createCostGate({",
  "        db: env.DB,",
  "        storage,",
  '        now: () => new Date(text(input, "at", new Date().toISOString())),',
  "      });",
  "      try {",
  '        await gate.admit(new Date(text(input, "at", new Date().toISOString())));',
  "        return Response.json({ ok: true });",
  "      } catch (error) {",
  '        if (error instanceof CostLimitError) return Response.json({ ok: false, refusal: "limit", budget: error.budget });',
  '        if (error instanceof CostGaugeUnavailableError) return Response.json({ ok: false, refusal: "gauge" });',
  "        throw error;",
  "      }",
  "    }",
  '    if (url.pathname === "/reset" && request.method === "POST") {',
  "      await migrate(env.DB);",
  '      await env.DB.prepare("DELETE FROM cost_turn").run();',
  "      await env.DB",
  "        .prepare(",
  "          \"UPDATE cost_limits SET do_rows_limit = 50000000, do_requests_limit = 1000000, r2_objects_limit = 1000000 WHERE id = 'cost'\",",
  "        )",
  "        .run();",
  "      return Response.json({ ok: true });",
  "    }",
  '    if (url.pathname === "/drop-limits" && request.method === "POST") {',
  '      await env.DB.prepare("DROP TABLE IF EXISTS cost_limits").run();',
  "      return Response.json({ ok: true });",
  "    }",
  '    return new Response("not found", { status: 404 });',
  "  },",
  "};",
  "",
].join("\n");

const LimitRowSchema = v.object({
  doRows: v.number(),
  doRequests: v.number(),
  r2Objects: v.number(),
  warnRatio: v.number(),
  criticalRatio: v.number(),
});

const MonthTotalSchema = v.object({
  doRows: v.number(),
  doRequests: v.number(),
  r2Objects: v.number(),
});

const AdmissionSchema = v.union([
  v.object({ ok: v.literal(true) }),
  v.object({ ok: v.literal(false), refusal: v.literal("limit"), budget: v.string() }),
  v.object({ ok: v.literal(false), refusal: v.literal("gauge") }),
]);

const expectOk = (response: Response): void => {
  if (!response.ok) throw new Error("the test route failed: " + String(response.status));
};

/**
 * Start the cost project under cf dev with a real D1 database.
 *
 * @remarks
 * The worker imports the product modules by relative path, so the real SQL, constraints, and
 * migration run in workerd. The project lives under `tools/deploy/.work` (ignored) because cf
 * needs its own project root with a `wrangler` dependency.
 */
export async function startCost(): Promise<CostHarness> {
  if (!existsSync(CF)) throw new Error("cf is not installed");
  await mkdir(WORK, { recursive: true });
  const directory = await mkdtemp(join(WORK, "cost-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "hns-cost-test",
      private: true,
      type: "module",
      devDependencies: { wrangler: "4.156.0" },
    }),
  );
  await symlink(join("..", "..", "node_modules"), join(directory, "node_modules"));
  await writeFile(join(directory, "cloudflare.config.ts"), CONFIG);
  await writeFile(join(directory, "worker.ts"), WORKER);
  // A free port is taken between the probe and cf dev's bind, so another suite (this file runs
  // beside the gateway and session suites) can win the race. That is a lost random resource,
  // not a product failure: start again on a new port, and report the output if both lose.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const port = await freePort();
    // The inspector proxy defaults to 9229, which the gateway and session dev servers already
    // claim; give this one an address of its own. Everything after "--" is forwarded as-is.
    const child = spawn(
      CF,
      [
        "dev",
        "--mode",
        "development",
        "--port",
        String(port),
        "--",
        "--inspector-port",
        String(port + 500),
      ],
      {
        cwd: directory,
        detached: true,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(directory, "config"),
          XDG_CACHE_HOME: join(directory, "cache"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const running = collect(child);
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        if (await healthy(port, running)) {
          ready = true;
          break;
        }
      } catch {
        // The child exited during startup; let the retry take a fresh port.
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (ready) return harness(directory, running, port);
    await stop(running);
    if (attempt === 2) {
      throw new Error("cf dev did not become ready:\n" + running.output());
    }
  }
  throw new Error("cf dev did not become ready");
}

const harness = (directory: string, running: Running, port: number): CostHarness => {
  const base = "http://127.0.0.1:" + String(port);
  const post = (path: string, body: string): Promise<Response> =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  return {
    async migrate() {
      expectOk(await post("/migrate", "{}"));
    },
    async setLimits(seed) {
      expectOk(await post("/limits", JSON.stringify(seed)));
    },
    async limits() {
      return v.parse(LimitRowSchema, await (await fetch(base + "/limits")).json());
    },
    async record(turn) {
      const response = await post("/record", JSON.stringify(turn));
      expectOk(response);
      return v.parse(v.object({ inserted: v.boolean() }), await response.json()).inserted;
    },
    async month(at) {
      return v.parse(
        MonthTotalSchema,
        await (await fetch(base + "/month?at=" + encodeURIComponent(at))).json(),
      );
    },
    async setProvider(seed) {
      expectOk(await post("/provider", JSON.stringify(seed)));
    },
    async admit(at) {
      const response = await post("/admit", JSON.stringify({ at }));
      expectOk(response);
      return v.parse(AdmissionSchema, await response.json());
    },
    async dropLimits() {
      expectOk(await post("/drop-limits", "{}"));
    },
    async reset() {
      expectOk(await post("/reset", "{}"));
    },
    async dispose() {
      await stop(running);
      await rm(directory, { recursive: true, force: true });
    },
  };
};
