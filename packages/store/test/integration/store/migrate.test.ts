import { afterAll, beforeAll, expect, test } from "vitest";
import { migrate } from "../../../src/migrate.ts";
import { migration0001 } from "../../../src/migrations/0001-initial.ts";
import { createSql } from "../../../src/sql.ts";
import { createD1Harness, type D1Harness } from "../harness.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

const V2_SQL = "CREATE TABLE machines (id TEXT PRIMARY KEY, name TEXT NOT NULL);";

const tablesNamed = async (name: string): Promise<readonly unknown[]> => {
  const sql = createSql(harness.db);
  try {
    return await sql.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [
      name,
    ]);
  } finally {
    await sql.close();
  }
};

// Catches: a new version applied without recording it, or a v1 table dropped by the v2 step.
test("a version 2 fixture applies after version 1 and keeps the existing rows", async () => {
  await harness.reset();
  const sql = createSql(harness.db);
  try {
    await migrate(sql, [migration0001]);
    await sql.run("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)", [
      "kept",
      "kept",
      "2026-01-01T00:00:00.000Z",
    ]);
    await migrate(sql, [migration0001, { version: 2, sql: V2_SQL }]);
    expect(await sql.all("SELECT version FROM schema_migrations ORDER BY version")).toStrictEqual([
      { version: 1 },
      { version: 2 },
    ]);
    expect(await sql.all("SELECT id FROM projects")).toStrictEqual([{ id: "kept" }]);
    expect(await tablesNamed("machines")).toHaveLength(1);
  } finally {
    await sql.close();
  }
});

// Catches: a gap or duplicate that silently skips a version, or a validation that runs after
// the first statement (which would leave schema_migrations behind on a refused list).
test.each([
  ["an empty list", []],
  ["a list that starts at 2", [{ version: 2, sql: V2_SQL }]],
  ["a duplicate version", [migration0001, migration0001]],
  ["a gap", [migration0001, { version: 3, sql: V2_SQL }]],
  ["a descending list", [migration0001, { version: 3, sql: V2_SQL }, { version: 2, sql: V2_SQL }]],
])("refuses %s before executing any SQL", async (_label, migrations) => {
  await harness.reset();
  const sql = createSql(harness.db);
  try {
    await expect(migrate(sql, migrations)).rejects.toThrow(/migrations/);
    expect(await tablesNamed("schema_migrations")).toHaveLength(0);
  } finally {
    await sql.close();
  }
});
