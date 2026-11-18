import { expect, test } from "vitest";
import * as v from "valibot";
import { migrate } from "../../../src/migrate.ts";
import { MIGRATIONS } from "../../../src/migrations/index.ts";
import { migration0008 } from "../../../src/migrations/0008-machines.ts";
import { createSql, type Sql } from "../../../src/sql.ts";
import { createD1Harness, type D1Harness } from "../harness.ts";

/**
 * Migration 0008 (0148): the machine registry's two tables.
 *
 * @remarks
 * Additive only (INV-12). The test reads the applied schema back from SQLite: the version is
 * recorded, `machines` has the columns the registry writes, `name` is unique, `status` and
 * `key_algorithm` are CHECK'd, and `machine_events.kind` is the closed vocabulary. A hand-edited
 * row cannot invent a status or an algorithm.
 */

let harness: D1Harness;

/** Migrate a fresh database and run `work`, closing everything afterwards. */
async function withMigrated<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
  harness = await createD1Harness();
  await harness.reset();
  const sql = createSql(harness.db);
  try {
    await migrate(sql, MIGRATIONS);
    return await work(sql);
  } finally {
    await sql.close();
    await harness.dispose();
  }
}

/** One `pragma_table_info` row. */
const ColumnSchema = v.object({ name: v.string(), cid: v.number() });
/** One `pragma_index_list` row. */
const IndexSchema = v.object({ name: v.string(), origin: v.string() });
/** One `schema_migrations` row. */
const VersionSchema = v.object({ version: v.number() });

const columnsOf = async (sql: Sql, table: string): Promise<readonly string[]> => {
  const rows = await sql.all("SELECT name, cid FROM pragma_table_info(?) ORDER BY cid", [table]);
  return rows.map((row) => v.parse(ColumnSchema, row).name);
};

// Catches: a migration that is appended but not recorded, or a version list with a gap.
test("migration 0008 is recorded once applied", async () => {
  expect(migration0008.version).toBe(8);
  await withMigrated(async (sql) => {
    const versions = await sql.all("SELECT version FROM schema_migrations ORDER BY version");
    expect(versions.map((row) => v.parse(VersionSchema, row).version)).toContain(8);
  });
});

// Catches: a machines table missing a column the registry writes, or an index D049 says not to
// create.
test("the machines table has the registry's columns and no index of its own", async () => {
  await withMigrated(async (sql) => {
    expect(await columnsOf(sql, "machines")).toStrictEqual([
      "id",
      "name",
      "hostname",
      "public_key",
      "key_algorithm",
      "agent_version",
      "last_seen",
      "status",
      "created_by",
      "created_at",
      "updated_at",
    ]);
    // The only indexes are SQLite's own for the primary key and the UNIQUE name; there is no
    // index the migration created (D049: a list is a table scan).
    const created = await sql.all(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'machines' AND name NOT LIKE 'sqlite_%'",
    );
    expect(created).toStrictEqual([]);
    const implicit = await sql.all("SELECT name, origin FROM pragma_index_list('machines')");
    expect(implicit.map((row) => v.parse(IndexSchema, row).origin).sort()).toStrictEqual([
      "pk",
      "u",
    ]);
  });
});

// Catches: a status or algorithm a hand-edited row can invent, or a duplicate name.
test("the status and algorithm are closed CHECKs and name is unique", async () => {
  await withMigrated(async (sql) => {
    const key = new Uint8Array(32).buffer;
    const insert =
      "INSERT INTO machines (id, name, hostname, public_key, key_algorithm, agent_version, " +
      "last_seen, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,NULL,?,?,?,?)";
    const at = "2026-01-01T00:00:00.000Z";
    await sql.run(insert, [
      "m1",
      "a",
      "a.example.ts.net",
      key,
      "ed25519",
      "0.1.0",
      "offline",
      "alice",
      at,
      at,
    ]);
    await expect(
      sql.run(insert, [
        "m2",
        "b",
        "b.example.ts.net",
        key,
        "ed25519",
        "0.1.0",
        "bogus",
        "alice",
        at,
        at,
      ]),
    ).rejects.toThrow();
    await expect(
      sql.run(insert, [
        "m3",
        "c",
        "c.example.ts.net",
        key,
        "rsa",
        "0.1.0",
        "offline",
        "alice",
        at,
        at,
      ]),
    ).rejects.toThrow();
    // The UNIQUE name refuses a second row with the same name.
    await expect(
      sql.run(insert, [
        "m4",
        "a",
        "a2.example.ts.net",
        key,
        "ed25519",
        "0.1.0",
        "offline",
        "mallory",
        at,
        at,
      ]),
    ).rejects.toThrow();
    // `created_by` has no default: a row that does not name its operator is refused (B1).
    await expect(
      sql.run(
        "INSERT INTO machines (id, name, hostname, public_key, key_algorithm, agent_version, " +
          "last_seen, status, created_at, updated_at) VALUES ('m5','e','e.example.ts.net',?," +
          "'ed25519','0',NULL,'offline',?,?)",
        [key, at, at],
      ),
    ).rejects.toThrow();
  });
});

// Catches: an event kind outside the vocabulary the registry writes.
test("machine_events records the closed vocabulary and the actor", async () => {
  await withMigrated(async (sql) => {
    expect(await columnsOf(sql, "machine_events")).toStrictEqual([
      "id",
      "machine_id",
      "name",
      "kind",
      "actor",
      "detail",
      "created_at",
    ]);
    const insert =
      "INSERT INTO machine_events (id, machine_id, name, kind, actor, detail, created_at) " +
      "VALUES (?,?,?,?,?,?,?)";
    await sql.run(insert, [
      "e1",
      "m1",
      "a",
      "enrolled",
      "owner",
      "ed25519:0",
      "2026-01-01T00:00:00.000Z",
    ]);
    await expect(
      sql.run(insert, ["e2", "m1", "a", "teleported", "owner", "", "2026-01-01T00:00:00.000Z"]),
    ).rejects.toThrow();
  });
});
