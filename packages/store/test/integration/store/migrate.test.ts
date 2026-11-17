import { afterAll, beforeAll, expect, test } from "vitest";
import { migrate } from "../../../src/migrate.ts";
import { migration0001 } from "../../../src/migrations/0001-initial.ts";
import { migration0002 } from "../../../src/migrations/0002-gateway.ts";
import { migration0003 } from "../../../src/migrations/0003-cost.ts";
import { MIGRATIONS } from "../../../src/migrations/index.ts";
import { parseProject } from "../../../src/parse.ts";
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

// Catches: existing projects losing their workspace, or the migration inventing a non-root value.
test("the root migration gives an existing project the machine ROOT it already used", async () => {
  await harness.reset();
  const sql = createSql(harness.db);
  try {
    await migrate(sql, [migration0001, migration0002, migration0003]);
    await sql.run("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)", [
      "kept",
      "kept",
      "2026-01-01T00:00:00.000Z",
    ]);
    await migrate(sql, MIGRATIONS);
    const row = await sql.get("SELECT * FROM projects WHERE id = ?", ["kept"]);
    const project = parseProject(row);
    expect(project.workspace_root).toBe("");
    expect(project.agent_cwd).toBe("");
  } finally {
    await sql.close();
  }
});

// Catches: a stored root that is missing or not canonical read as the machine ROOT.
test("a project row without a canonical root fails closed", async () => {
  await harness.reset();
  const sql = createSql(harness.db);
  try {
    await migrate(sql, MIGRATIONS);
    await sql.run("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)", [
      "forged",
      "forged",
      "2026-01-01T00:00:00.000Z",
    ]);
    // The column defaults to '' when omitted; break it explicitly to prove the read fails.
    await sql.run("UPDATE projects SET workspace_root = ? WHERE id = ?", ["../outside", "forged"]);
    const row = await sql.get("SELECT * FROM projects WHERE id = ?", ["forged"]);
    expect(() => parseProject(row)).toThrow();
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
