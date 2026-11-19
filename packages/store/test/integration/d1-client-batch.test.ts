import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createSql, type D1Binding } from "../../src/sql.ts";
import { createD1Harness, type D1Harness } from "./harness.ts";

/**
 * The same store calls through the Worker's binding and through the Node client (0274n).
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
 * Both run the store's own calls (a raw `batch` of three, the same three through `createSql`, and
 * a single statement), so a difference between them is a difference in how the call reaches the
 * runtime, not in the store. **Measured (2026-11-19): both answer**, which is what places the 0239
 * hang in the journey's own D1 (its `node:sqlite` `batch` answers differently from D1's) rather
 * than in miniflare or in the store. `d1-batch.test.ts` (server) proves the real store's open,
 * read, and batch inside a Worker; this suite is the record `docs/procedures/testing.md` cites.
 */

const TIMEOUT_MS = 3_000;

/** The three statements the store issues in one batch: DDL, a write with parameters, a read. */
const STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS probe_0274n (id INTEGER PRIMARY KEY, v TEXT)",
  "INSERT OR REPLACE INTO probe_0274n (id, v) VALUES (1, 'x')",
  "SELECT * FROM probe_0274n",
];

/** What one call did: answered (with its value) or not, before the deadline. */
const OutcomeSchema = v.object({
  answered: v.boolean(),
  value: v.string(),
});

/**
 * Run one call and report whether it answered.
 *
 * @param run - The call; a rejected call is an answer (it came back), only silence is not.
 * @returns Whether it answered, with its value rendered for a failure message.
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
test("the D1 binding inside a worker answers a raw batch and createSql's batch", async () => {
  if (inside === undefined) throw new Error("the binding did not start");
  const db = inside;
  const raw = await outcome(async () => {
    const results = await db.batch(STATEMENTS.map((sql) => db.prepare(sql)));
    return { answered: true, value: JSON.stringify(results).slice(0, 300) };
  });
  expect(raw.answered, "the Worker's binding did not answer the batch: " + raw.value).toBe(true);
  const sql = createSql(db);
  try {
    const batched = await outcome(async () => {
      const rows = await sql.batch(STATEMENTS.map((statement) => ({ sql: statement })));
      return { answered: true, value: JSON.stringify(rows).slice(0, 300) };
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
test("the Node client answers the same calls through the same binding", async () => {
  if (harness === undefined) throw new Error("the harness did not start");
  const db = harness.db;
  const single = await outcome(async () => {
    const row = await db.prepare("SELECT count(*) AS n FROM sqlite_master").first();
    return { answered: true, value: JSON.stringify(row).slice(0, 300) };
  });
  expect(single.answered, "the client did not answer a single statement: " + single.value).toBe(
    true,
  );
  // An empty batch: the one the store short-circuits before D1 is asked anything.
  const empty = await outcome(async () => {
    const results = await db.batch([]);
    return { answered: true, value: JSON.stringify(results).slice(0, 300) };
  });
  expect(empty.answered, "the client's empty batch: " + empty.value).toBe(true);
});
