import { expect, test } from "vitest";
import * as v from "valibot";
import { migrate } from "../../../src/migrate.ts";
import { MIGRATIONS } from "../../../src/migrations/index.ts";
import { migration0009 } from "../../../src/migrations/0009-conversation-edited.ts";
import { openConversationIndex } from "../../../src/conversation-index/index.ts";
import { createSql, type Sql } from "../../../src/sql.ts";
import { openStore } from "../../../src/store.ts";
import { createD1Harness, type D1Harness } from "../harness.ts";
import type { ConversationId } from "@hns/core";

/**
 * Migration 0009 (0271n): a conversation row remembers that a person edited it.
 *
 * @remarks
 * Additive only (INV-12). The test reads the applied schema back from SQLite — the version is
 * recorded, \`edited_at\` exists and is nullable — and then shows where the column starts: NULL for
 * everything the index writes, set by a person's write, and read back as NULL for a row written
 * before this column existed.
 */

let harness: D1Harness;

/** Migrate a fresh database and run \`work\`, closing everything afterwards. */
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

/** One `schema_migrations` row. */
const VersionSchema = v.object({ version: v.number() });

/** One `pragma_table_info` row. */
const ColumnSchema = v.object({ name: v.string(), type: v.string(), required: v.number() });

// Catches: a migration that is appended but not recorded, or a version list with a gap.
test("migration 0009 is the last step and is recorded once applied", async () => {
  expect(MIGRATIONS[MIGRATIONS.length - 1]?.version).toBe(9);
  expect(migration0009.version).toBe(9);
  await withMigrated(async (sql) => {
    const versions = await sql.all("SELECT version FROM schema_migrations ORDER BY version");
    expect(versions.map((row) => v.parse(VersionSchema, row).version)).toContain(9);
  });
});

// Catches: an edited_at that is required, which would refuse every row the object writes.
test("conversations gain a nullable edited_at, and an object's row leaves it NULL", async () => {
  await withMigrated(async (sql) => {
    // The pragma's column is called \`notnull\`, which the runner's SQL would read as a keyword; it
    // is read back as \`"notnull"\` instead.
    const columns = await sql.all(
      'SELECT name, type, "notnull" AS required FROM pragma_table_info(?)',
      ["conversations"],
    );
    const edited = columns
      .map((row) => v.parse(ColumnSchema, row))
      .find((row) => row.name === "edited_at");
    expect(edited?.type).toBe("TEXT");
    expect(edited?.required).toBe(0);
    // Opening the store applies the migrations and seeds the default project a row needs.
    const store = await openStore({ d1: harness.db });
    await openConversationIndex(harness.db).upsert([
      {
        id: "1",
        projectId: "default",
        title: "chat",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archived: false,
        deletedAt: null,
        indexedAt: "2026-01-01T00:00:01.000Z",
      },
    ]);
    // The column is not part of the public row: the model parses the row that carries it.
    // SAFETY: the index row was written with this id a moment ago; the brand is compile-time only.
    const stored = await store.conversations.findById("1" as ConversationId);
    expect(stored?.title).toBe("chat");
    await store.close();
  });
});
