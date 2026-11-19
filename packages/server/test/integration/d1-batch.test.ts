import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { build } from "vite";

/**
 * The control database inside a worker: openStore, a bound statement, and a batch (0274n).
 *
 * @remarks
 * 0239's attempt to run the e2e journey on workerd stopped at the store's `sql.batch`: inside a
 * request, `db.batch` did not return, though the same call completed at start-up. The store's own
 * suites call miniflare's D1 from **Node**, so they had never asked what the same binding does
 * **inside a request**. This suite asks, on this checkout's miniflare: a store open (the
 * migrations, a batch each), a raw `prepare` with a parameter bound (the shape `createSql` binds),
 * and a `db.batch` of three (the shape `sql.batch` issues) all return, with the rows each
 * statement produced.
 *
 * `cf dev` answers the same three in the same milliseconds, and the real `/graphql`
 * (`ShellProjectsQuery`, which opens the store) is 200 on both: what hung in 0239 was the e2e
 * journey's **hand-made D1** (a `node:sqlite` facade over a model of the dispatch, not a D1
 * binding), not the store and not the runtime. `docs/procedures/testing.md` carries the rule;
 * this test is what keeps the runtime itself from regressing behind it.
 *
 * A call that does not return is a failure, not a hang: each step races a deadline.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Modules the Worker bundle must not inline: Node built-ins and the platform's own modules. */
const EXTERNAL = [/^node:/u, "cloudflare:workers", "cloudflare:sockets"];

/** The probe's own answer: the step, how long it took, and what it saw. */
const AnswerSchema = v.object({
  step: v.string(),
  ms: v.number(),
  projects: v.optional(v.number()),
  rows: v.optional(v.array(v.record(v.string(), v.unknown()))),
  results: v.optional(v.array(v.array(v.unknown()))),
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
 * `import` of its own and the store is one. The steps are the store's own: `openStore` (the
 * migrations, a batch each) and its project list (`sql.all`); a raw `prepare` with a parameter
 * bound (the shape `createSql` binds a statement); and a `db.batch` of three (the shape
 * `sql.batch` issues, a DDL statement included).
 */
const WORKER = `
import { openStore } from "@hns/store";

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
          env.DB.prepare("CREATE TABLE IF NOT EXISTS probe_0274n (id INTEGER PRIMARY KEY, v TEXT)"),
          env.DB.prepare("INSERT OR REPLACE INTO probe_0274n (id, v) VALUES (?1, ?2)").bind(1, "x"),
          env.DB.prepare("SELECT * FROM probe_0274n"),
        ]);
        return Response.json({
          step,
          ms: Date.now() - started,
          results: results.map((result) => result.results ?? []),
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
 * One step of the probe, with a deadline.
 *
 * @param name - The step the probe runs.
 * @param deadlineMs - How long the answer has before the step counts as unanswered.
 * @returns The probe's parsed answer.
 * @throws {Error} When the step does not answer, answers with a non-200, or answers off-schema.
 */
async function step(
  name: string,
  deadlineMs = 10_000,
): Promise<v.InferOutput<typeof AnswerSchema>> {
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
  return v.parse(AnswerSchema, JSON.parse(result.text));
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
  expect(batched.results).toStrictEqual([[], [], [{ id: 1, v: "x" }]]);
});
