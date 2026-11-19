import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build } from "vite";

/**
 * The control database inside a worker: openStore, a bound statement, and batches (0274n).
 *
 * @remarks
 * 0239's attempt to run the e2e journey on workerd stopped at the store's `sql.batch`: inside a
 * request, `db.batch` did not return, though the same call completed at start-up. The store's own
 * suites call miniflare's D1 from **Node**, so they had never asked what the same binding does
 * **inside a request**. This suite asks, on this checkout's miniflare, and pins the answers:
 *
 * - a store open (the migrations, a batch each), a raw `prepare` with a parameter bound (the shape
 *   `createSql` binds), and a `db.batch` of three all return, with the rows each statement made;
 * - a batch whose statements carry `RETURNING` — the shape the store's own multi-statement writes
 *   use (`trailRepository.addChange`, `machines.enroll`) — returns those rows in place, and a
 *   statement that changes nothing returns none;
 * - a batch that fails half way rolls back every statement of it (D1's only transaction);
 * - the same three statements through a Durable Object's SQLite (`ctx.storage.sql`) return the
 *   same rows, so the `RETURNING` rows do not depend on which kind of storage runs them.
 *
 * **What this suite does not cover** (the conditions left for the next reader):
 *
 * - **`blockConcurrencyWhile`** — the candidate 0239 had for its hang (a batch run while the
 *   object's start-up holds the object). The store's call is the same at start-up as in a request,
 *   and 0239 measured start-up as working, but this suite does not run it;
 * - **an isolate's second request, and two dispatches at once** — every step here is one request
 *   after another; concurrency between two in-flight `db.batch` calls is not exercised;
 * - **`cf dev`** — answered 2026-11-19 in the same milliseconds, and the real `/graphql`
 *   (`ShellProjectsQuery`, which opens the store) was 200, but that was **unrecorded**: the project
 *   it ran in is not in this repo, so there is no procedure to repeat it (0274n's remaining work).
 *
 * What that leaves is the conclusion: nothing here writes around the runtime, and 0239's hang is
 * not a D1 binding's — `docs/procedures/testing.md` carries the rule this suite keeps.
 *
 * A call that does not return is a failure, not a hang: each step races a deadline.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Modules the Worker bundle must not inline: Node built-ins and the platform's own modules. */
const EXTERNAL = [/^node:/u, "cloudflare:workers", "cloudflare:sockets"];

/** A row as the probe reports it: the columns each statement names. */
const RowSchema = v.array(v.record(v.string(), v.unknown()));

/** The probe's own answer: the step, how long it took, and what it saw. */
const AnswerSchema = v.object({
  step: v.string(),
  ms: v.number(),
  projects: v.optional(v.number()),
  rows: v.optional(RowSchema),
  results: v.optional(v.array(RowSchema)),
  error: v.optional(v.string()),
});

/** What a batch that fails leaves behind: the failure, and the rows a later read finds. */
const FailureSchema = v.object({
  step: v.string(),
  ms: v.number(),
  failed: v.boolean(),
  error: v.optional(v.string()),
  rows: RowSchema,
});

/** The manifest part each package's `exports` map must declare for the alias. */
const ManifestSchema = v.object({
  exports: v.record(v.string(), v.object({ source: v.pipe(v.string(), v.minLength(1)) })),
});

/**
 * The path aliases `@hns/*` resolves to, read from each package's own `exports`.
 *
 * @returns One alias per export, the longest key first so a subpath beats the root.
 * @throws {Error} When a package's manifest cannot be read or has no `source` for an export.
 *
 * @remarks
 * The probe imports the store by name, as a deployed Worker does, and reading the maps rather
 * than repeating the paths keeps the probe on the same files tsc compiles.
 */
function aliases(): { find: RegExp; replacement: string }[] {
  const found: { find: RegExp; replacement: string }[] = [];
  for (const name of ["core", "record", "store", "workspace", "agent", "server"]) {
    const path = join(ROOT, "packages", name, "package.json");
    const manifest = v.parse(ManifestSchema, JSON.parse(readFileSync(path, "utf8")));
    const entries = Object.entries(manifest.exports).sort((a, b) => b[0].length - a[0].length);
    for (const [key, value] of entries) {
      const sub = key === "." ? "" : key.slice(1);
      found.push({
        find: new RegExp("^@hns/" + name + sub + "$", "u"),
        replacement: join(ROOT, "packages", name, value.source),
      });
    }
  }
  return found;
}

/** The probe worker's virtual entry: a real `.ts` is what Vite compiles as one. */
const PROBE = "hns-0274n-probe.ts";

/**
 * The one-module worker the probe runs in.
 *
 * @remarks
 * It is a **module worker**, as the deploy project's is: a classic service worker has no
 * `import` of its own and the store is one. Its steps are the store's own calls: `openStore`
 * (the migrations, a batch each) and its project list (`sql.all`); a raw `prepare` with a
 * parameter bound (the shape `createSql` binds a statement); a `db.batch` of three, plain and
 * with `RETURNING`; a batch whose second statement cannot commit; and the same three through the
 * store's `createSql`. The `Storage` export runs the same three in a Durable Object's SQLite.
 */
const WORKER = `
import { DurableObject } from "cloudflare:workers";
import { openStore } from "@hns/store";

export class Storage {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async fetch() {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS probe_0274n (id INTEGER PRIMARY KEY, v TEXT)");
    const results = [
      [...sql.exec("INSERT INTO probe_0274n (id, v) VALUES (?1, ?2) RETURNING *", 1, "x")],
      [...sql.exec("UPDATE probe_0274n SET v = ?1 WHERE id = ?2 AND v = ?3", "y", 1, "no row")],
      [...sql.exec("SELECT * FROM probe_0274n")],
    ];
    return Response.json({ results });
  }
}

const create = (db) => "CREATE TABLE IF NOT EXISTS probe_0274n (id INTEGER PRIMARY KEY, v TEXT)";
const insert = "INSERT OR REPLACE INTO probe_0274n (id, v) VALUES (?1, ?2)";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const step = url.searchParams.get("step") ?? "open";
    const started = Date.now();
    try {
      if (step === "open") {
        const store = await openStore({ d1: env.DB });
        const projects = await store.projects.list();
        return Response.json({ step, ms: Date.now() - started, projects: projects.length });
      }
      if (step === "raw") {
        const rows = await env.DB.prepare("SELECT id FROM projects WHERE id = ?1")
          .bind("default")
          .all();
        return Response.json({ step, ms: Date.now() - started, rows: rows.results });
      }
      if (step === "batch") {
        const results = await env.DB.batch([
          env.DB.prepare(create(env.DB)),
          env.DB.prepare(insert).bind(1, "plain"),
          env.DB.prepare("SELECT * FROM probe_0274n"),
        ]);
        return Response.json({
          step,
          ms: Date.now() - started,
          results: results.map((result) => result.results ?? []),
        });
      }
      if (step === "returning") {
        await env.DB.batch([env.DB.prepare(create(env.DB))]);
        const results = await env.DB.batch([
          env.DB.prepare(insert + " RETURNING *").bind(1, "returned"),
          env.DB.prepare("UPDATE probe_0274n SET v = ?1 WHERE id = ?2 AND v = ?3").bind("y", 1, "no row"),
          env.DB.prepare("SELECT * FROM probe_0274n"),
        ]);
        return Response.json({
          step,
          ms: Date.now() - started,
          results: results.map((result) => result.results ?? []),
        });
      }
      if (step === "rollback") {
        await env.DB.batch([env.DB.prepare(create(env.DB))]);
        let error;
        try {
          await env.DB.batch([
            env.DB.prepare("INSERT INTO probe_0274n (id, v) VALUES (?1, ?2)").bind(1, "kept"),
            env.DB.prepare("INSERT INTO probe_0274n (id, v) VALUES (?1, ?2)").bind(1, "lost"),
          ]);
        } catch (failure) {
          error = String(failure);
        }
        const rows = await env.DB.prepare("SELECT * FROM probe_0274n WHERE v = 'kept'").all();
        return Response.json({
          step,
          ms: Date.now() - started,
          failed: error !== undefined,
          error,
          rows: rows.results,
        });
      }
      return Response.json({ step: "unknown", ms: Date.now() - started }, { status: 400 });
    } catch (error) {
      return Response.json(
        { step, ms: Date.now() - started, error: String(error) },
        { status: 500 },
      );
    }
  },
};
`;

/**
 * Build the probe worker as one module, from this checkout's sources.
 *
 * @returns The entry chunk's code.
 * @throws {Error} When the build produces no entry chunk.
 */
async function bundleWorker(): Promise<string> {
  const built = await build({
    logLevel: "silent",
    publicDir: false,
    configFile: false,
    root: ROOT,
    build: {
      write: false,
      emptyOutDir: false,
      minify: false,
      ssr: true,
      target: "es2022",
      rollupOptions: {
        input: { probe: PROBE },
        external: EXTERNAL,
        output: { format: "es", entryFileNames: "[name].mjs" },
      },
    },
    resolve: { conditions: ["source"], alias: aliases() },
    ssr: { noExternal: true },
    plugins: [
      {
        name: "hns-0274n-probe",
        resolveId: (id) => (id === PROBE ? "\0" + PROBE : null),
        load: (id) => (id === "\0" + PROBE ? WORKER : null),
      },
    ],
  });
  // SAFETY: `write: false` makes Vite read-only and returns the build's outputs; the declared
  // type also covers a watcher and an array of builds, neither of which a read-only build is.
  const outputs = (Array.isArray(built) ? built[0] : built) as {
    readonly output?: readonly OutputChunk[];
  };
  for (const output of outputs.output ?? []) {
    if (output.isEntry) return output.code;
  }
  throw new Error("the probe worker did not bundle");
}

/** The part of a Durable Object namespace this file calls. */
interface DurableObjectNamespace {
  idFromName(name: string): { readonly name: string };
  get(id: { readonly name: string }): { fetch(request: string): Promise<Response> };
}

/** The part of a rollup chunk this file reads. */
interface OutputChunk {
  readonly type: string;
  readonly isEntry: boolean;
  readonly code: string;
}

let runtime: Miniflare | undefined;

beforeAll(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      script: await bundleWorker(),
      modules: true,
      d1Databases: ["DB"],
      durableObjects: { STORAGE: { className: "Storage", useSQLite: true } },
      compatibilityDate: "2026-10-30",
      compatibilityFlags: ["nodejs_compat"],
    }),
  );
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

/**
 * Ask the probe one step, with a deadline.
 *
 * @param name - The step the probe runs.
 * @param answer - The step's own failure, run here so a 4xx/5xx reports its rows rather than a status.
 * @param deadlineMs - How long the answer has before the step counts as unanswered.
 * @returns The probe's parsed answer.
 * @throws {Error} When the step does not answer, or answers off-schema.
 */
async function ask<T>(
  name: string,
  schema: v.GenericSchema<unknown, T>,
  deadlineMs = 10_000,
): Promise<T> {
  if (runtime === undefined) throw new Error("the runtime did not start");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = runtime.dispatchFetch("http://probe/?step=" + name).then(async (response) => ({
    status: response.status,
    text: await response.text(),
  }));
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), deadlineMs);
  });
  const result = await Promise.race([answered, deadline]).finally(() => {
    clearTimeout(timer);
  });
  if (result === undefined) throw new Error("the " + name + " step did not return");
  expect(result.status, result.text).toBe(200);
  return v.parse(schema, JSON.parse(result.text));
}

/**
 * One step of the probe.
 *
 * @param name - The step the probe runs.
 * @returns The probe's parsed answer.
 * @throws {Error} When the step does not answer, or answers off-schema.
 */
async function step(name: string): Promise<v.InferOutput<typeof AnswerSchema>> {
  return await ask(name, AnswerSchema);
}

// Catches: a store open (the migrations, one batch each) that never returns inside a request.
test("openStore migrates and reads its projects on workerd inside a request", async () => {
  const opened = await step("open");
  expect(opened.projects).toBe(1);
});

// Catches: a raw prepare with parameters bound that never returns inside a request.
test("a raw prepare with a bound parameter returns on workerd inside a request", async () => {
  const rows = await step("raw");
  expect(rows.rows).toStrictEqual([{ id: "default" }]);
});

// Catches: a db.batch of three, the shape sql.batch issues, that never returns inside a request.
test("a db.batch returns rows per statement on workerd inside a request", async () => {
  await step("open");
  const batched = await step("batch");
  expect(batched.results).toStrictEqual([[], [], [{ id: 1, v: "plain" }]]);
});

// Catches: a RETURNING row lost in a batch — the shape addChange and machines.enroll issue — and a
// statement that changes nothing being reported as changing one.
test("a batch with RETURNING returns the changed row and no row for an unchanged statement", async () => {
  const batched = await step("returning");
  expect(batched.results).toStrictEqual([
    [{ id: 1, v: "returned" }],
    [],
    [{ id: 1, v: "returned" }],
  ]);
});

// Catches: a half-failed batch that commits its first statement — a transaction D1 does not give.
test("a failing statement rolls back the whole batch", async () => {
  const failed = await ask("rollback", FailureSchema);
  expect(failed.failed, "the second insert did not fail").toBe(true);
  expect(failed.error).toContain("UNIQUE");
  expect(failed.rows, "the batch's first insert committed anyway").toStrictEqual([]);
});

// Catches: addChange's answer depending on which storage runs its batch — the DO's SQLite has no
// db.batch, so the store's write runs this way there.
test("a Durable Object's SQLite returns the same rows for the same three statements", async () => {
  if (runtime === undefined) throw new Error("the runtime did not start");
  /* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion --
     miniflare declares this accessor as a bare `Request` (its own types collide on the name); the
     value it returns is the namespace of the class this suite declared. */
  const namespace = (await runtime.getDurableObjectNamespace(
    "STORAGE",
  )) as unknown as DurableObjectNamespace;
  // oxlint-enable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion

  const stub = namespace.get(namespace.idFromName("probe"));
  const answer = await stub.fetch("http://probe/");
  const parsed = v.parse(
    v.object({ results: v.array(RowSchema) }),
    JSON.parse(await answer.text()),
  );
  expect(parsed.results).toStrictEqual([[{ id: 1, v: "x" }], [], [{ id: 1, v: "x" }]]);
});
