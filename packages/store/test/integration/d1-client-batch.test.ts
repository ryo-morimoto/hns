import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createSql, type D1Binding } from "../../src/sql.ts";
import { createD1Harness, type D1Harness } from "./harness.ts";

/**
 * The same statements through the Worker's binding and through the Node client (0274n).
 *
 * @remarks
 * 0239 ran the e2e journey over **real workerd** and the store's `sql.batch` did not return in a
 * request, though the same call completed at start-up. The store's own suites call miniflare's D1
 * from **Node**, so neither side of that report had been measured where it happened:
 *
 * - `inside` is miniflare's D1 **fetch binding**, the object a Worker's `env.DB` is;
 * - `outside` is the same database through miniflare's **Node client**, which is what
 *   `e2e/support/d1.ts` stands in for and what `harness.ts` hands the store.
 *
 * Both run the store's own batch — three statements with a `RETURNING` row, an update that changes
 * nothing, and a read (the shape `trailRepository.addChange` issues) — and both answer, with the
 * same rows. **That is what the two D1s differ on here** (2026-11-19): what the e2e journey's
 * stand-in (`e2e/support/d1.ts`) does differently is **not measured** ("its `batch` answers
 * differently from D1's" was a guess, not an observation).
 *
 * **Not covered** (0274n): a batch run inside `blockConcurrencyWhile`; a second request, or two
 * dispatches at once, in the same isolate (every call here is one after another); `cf dev` (it
 * answered, but the project it ran in is not in this repo, so the measurement is unrecorded).
 * `d1-batch.test.ts` (server) covers the Worker's side with `RETURNING`, rollback, and a Durable
 * Object's SQLite; this suite records both clients of the same binding.
 */

const TIMEOUT_MS = 3_000;

/** The three statements `addChange` issues in one batch: a `RETURNING` insert, an update, a read. */
const STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS probe_0274n (id INTEGER PRIMARY KEY, v TEXT)",
  "INSERT OR REPLACE INTO probe_0274n (id, v) VALUES (1, 'x') RETURNING *",
  "UPDATE probe_0274n SET v = 'y' WHERE id = 2",
  "SELECT * FROM probe_0274n",
];

/** What one call did: answered (with its rows) or not, before the deadline. */
const OutcomeSchema = v.object({
  answered: v.boolean(),
  value: v.string(),
});

/**
 * Run one call and report whether it answered.
 *
 * @param run - The call; a rejected call is an answer (it came back), only silence is not.
 * @returns Whether it answered, with its rows rendered for a failure message.
 *
 * @remarks
 * A call that never settles is the observation under test, so the deadline resolves the race
 * instead of failing it.
 */
async function outcome(
  run: () => Promise<v.InferOutput<typeof OutcomeSchema>>,
): Promise<v.InferOutput<typeof OutcomeSchema>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = run().then(
    (value) => ({ answered: true, value: value.value }),
    (error: Error) => ({ answered: true, value: "rejected: " + error.message.slice(0, 300) }),
  );
  const deadline = new Promise<v.InferOutput<typeof OutcomeSchema>>((resolve) => {
    timer = setTimeout(
      () => resolve({ answered: false, value: "no answer in " + TIMEOUT_MS + "ms" }),
      TIMEOUT_MS,
    );
  });
  try {
    return v.parse(OutcomeSchema, await Promise.race([settled, deadline]));
  } finally {
    clearTimeout(timer);
  }
}

let harness: D1Harness | undefined;
let runtime: Miniflare | undefined;
/** The Worker's side: miniflare's D1 fetch binding, as `env.DB` is inside a request. */
let inside: D1Binding | undefined;

beforeAll(async () => {
  harness = await createD1Harness();
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      d1Databases: ["DB"],
      compatibilityDate: "2026-10-30",
      compatibilityFlags: ["nodejs_compat"],
    }),
  );
  // SAFETY: miniflare types a binding's value as any; this suite declared DB as a D1 database.
  const bindings = (await runtime.getBindings()) as { readonly DB: D1Binding };
  inside = bindings.DB;
}, 60_000);

afterAll(async () => {
  await harness?.dispose();
  harness = undefined;
  await runtime?.dispose();
  runtime = undefined;
  inside = undefined;
});

// Catches: the Worker's binding being credited with a hang it does not have (the 0239 report).
test("the D1 binding inside a worker answers the store's batch, RETURNING included", async () => {
  if (inside === undefined) throw new Error("the binding did not start");
  const db = inside;
  const raw = await outcome(async () => {
    const results = await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
    return { answered: true, value: JSON.stringify(results.map((result) => result.results)) };
  });
  expect(raw.answered, "the Worker's binding did not answer the batch: " + raw.value).toBe(true);
  expect(raw.value).toContain('{"id":1,"v":"x"}');
  const sql = createSql(db);
  try {
    const batched = await outcome(async () => {
      const rows = await sql.batch(STATEMENTS.map((statement) => ({ sql: statement })));
      return { answered: true, value: JSON.stringify(rows) };
    });
    expect(
      batched.answered,
      "createSql.batch did not answer inside the Worker: " + batched.value,
    ).toBe(true);
    expect(batched.value).toContain('{"id":1,"v":"x"}');
  } finally {
    await sql.close();
  }
});

// Catches: the Node client being read as the binding — the client the store's suites call.
test("the Node client answers the same batch with the same rows", async () => {
  if (harness === undefined) throw new Error("the harness did not start");
  const db = harness.db;
  const single = await outcome(async () => {
    const row = await db.prepare("SELECT count(*) AS n FROM sqlite_master").first();
    return { answered: true, value: JSON.stringify(row) };
  });
  expect(single.answered, "the client did not answer a single statement: " + single.value).toBe(
    true,
  );
  const batched = await outcome(async () => {
    const results = await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
    return { answered: true, value: JSON.stringify(results.map((result) => result.results)) };
  });
  expect(batched.answered, "the client's batch: " + batched.value).toBe(true);
  expect(batched.value).toContain('{"id":1,"v":"x"}');
});
