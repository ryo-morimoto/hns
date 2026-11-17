import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MIGRATIONS } from "../../../src/migrations/index.ts";
import { migrate } from "../../../src/migrate.ts";
import { createSql, type Sql } from "../../../src/sql.ts";
import { createD1Harness, type D1Harness } from "../harness.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

/** The version-5 schema: every step before the tables are dropped. */
const BEFORE = MIGRATIONS.filter((migration) => migration.version <= 5);

const PlanSchema = v.object({ id: v.number(), parent: v.number(), detail: v.string() });

/** Whether sqlite_master still knows a table of this name. */
async function hasTable(sql: Sql, name: string): Promise<boolean> {
  const rows = await sql.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [
    name,
  ]);
  return rows.length > 0;
}

/**
 * Seed a version-5 database with rows in the tables the step drops and in the ones it keeps.
 *
 * @remarks
 * `cost_turn` is the ledger the month total sums; `obs_events` lives in the Session object's
 * SQLite, so a `cost_turn` row is what proves the canonical source survives here.
 */
async function seed(sql: Sql): Promise<void> {
  await migrate(sql, BEFORE);
  await sql.run("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)", [
    "default",
    "default",
    "2026-01-01T00:00:00.000Z",
  ]);
  for (const id of ["e1", "e2"]) {
    await sql.run(
      "INSERT INTO events (id, at, level, event, request_id, conversation_id, status, duration_ms, detail) " +
        "VALUES (?, ?, 'info', 'http', 'req', NULL, 200, 5, NULL)",
      [id, "2026-01-01T00:00:00.000Z"],
    );
  }
  await sql.run(
    "INSERT INTO usage_log (id, conversation_id, at, tokens, cost, request_id) VALUES (?, ?, ?, ?, ?, ?)",
    ["u1", "c1", "2026-01-01T00:00:00.000Z", 12, 0.5, "req"],
  );
  await sql.run(
    "INSERT INTO cost_turn (id, conversation_id, at, outcome, do_rows, do_requests, r2_objects) " +
      "VALUES ('t1', 'c1', '2026-01-01T00:00:00.000Z', 'completed', 10, 1, 0)",
  );
}

// Catches: the drop step failing on a database that already holds the first-generation rows, or
// the version recorded while the tables survive.
test("the drop step removes events and usage_log from a version-5 database", async () => {
  await harness.reset();
  const sql = createSql(harness.db);
  try {
    await seed(sql);
    expect(await hasTable(sql, "events")).toBe(true);
    expect(await hasTable(sql, "usage_log")).toBe(true);
    await migrate(sql, MIGRATIONS);
    expect(await hasTable(sql, "events")).toBe(false);
    expect(await hasTable(sql, "usage_log")).toBe(false);
    expect(await sql.get("SELECT MAX(version) AS version FROM schema_migrations")).toStrictEqual({
      version: 6,
    });
  } finally {
    await sql.close();
  }
});

// Catches: the drop step taking a canonical source's rows with it, so the month total resets.
test("the drop step keeps the cost ledger and the projects", async () => {
  await harness.reset();
  const sql = createSql(harness.db);
  try {
    await seed(sql);
    await migrate(sql, MIGRATIONS);
    expect(await sql.get("SELECT COUNT(*) AS count FROM cost_turn")).toStrictEqual({ count: 1 });
    expect(await sql.all("SELECT id, do_rows FROM cost_turn")).toStrictEqual([
      { id: "t1", do_rows: 10 },
    ]);
    expect(await sql.get("SELECT COUNT(*) AS count FROM projects")).toStrictEqual({ count: 1 });
    expect(await sql.get("SELECT COUNT(*) AS count FROM cost_limits")).toStrictEqual({ count: 1 });
  } finally {
    await sql.close();
  }
});

// Catches: the list reading a sort no index serves, so D1 builds a temporary B-tree per page.
test("the conversation list is served by the conversations_page index", async () => {
  await harness.reset();
  const sql = createSql(harness.db);
  try {
    await migrate(sql, MIGRATIONS);
    const planOf = async (
      statement: string,
      params: readonly (string | number)[],
    ): Promise<string> =>
      (await sql.all("EXPLAIN QUERY PLAN " + statement, params))
        .map((row) => v.parse(PlanSchema, row))
        .map((row) => row.detail)
        .join("; ");
    const page =
      "SELECT * FROM conversations WHERE deleted_at IS NULL AND indexed_at IS NOT NULL AND archived = 0 " +
      "AND project_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?";
    const keyset =
      "SELECT * FROM conversations WHERE deleted_at IS NULL AND indexed_at IS NOT NULL AND archived = 0 " +
      "AND project_id = ? AND (updated_at < ? OR (updated_at = ? AND id < ?)) " +
      "ORDER BY updated_at DESC, id DESC LIMIT ?";

    // A row no Session has indexed yet must still leave the index usable for the page it does
    // not appear in: the index is a plain one over updated_at, not a partial one.
    await sql.run("INSERT INTO projects (id, name, created_at) VALUES ('p', 'p', '2026-01-01')");
    await sql.run(
      "INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES ('legacy', 'p', 't', '2026-01-01', NULL)",
    );
    await sql.run(
      "INSERT INTO conversations (id, project_id, title, created_at, updated_at, indexed_at) " +
        "VALUES ('c1', 'p', 't', '2026-01-01', '2026-01-01', '2026-01-01')",
    );

    const first = await planOf(page, ["p", 10]);
    expect(first).toContain("USING INDEX conversations_page");
    const next = await planOf(keyset, ["p", "2026-01-02", "2026-01-02", "c1", 10]);
    expect(next).toContain("USING INDEX conversations_page");
    expect(first).not.toContain("TEMP B-TREE");
    expect(next).not.toContain("TEMP B-TREE");
  } finally {
    await sql.close();
  }
});
