import * as v from "valibot";
import { MIGRATIONS } from "./migrations/index.ts";
import type { Migration } from "./migrations/migration.ts";
import { createSql, type D1Binding, type Sql } from "./sql.ts";

/**
 * Refuse a version list that is not 1..n, ascending, with no gap or duplicate.
 *
 * @internal
 * @remarks
 * Checked before the first statement runs: a gap would let a later build record a version it
 * never applied, and a duplicate would make an applied version look pending.
 * @throws Error when the list is empty, does not start at 1, repeats a version, or skips one.
 */
function assertMigrations(migrations: readonly Migration[]): void {
  if (migrations.length === 0) throw new Error("store has no migrations");
  let expected = 1;
  for (const migration of migrations) {
    if (migration.version !== expected) {
      throw new Error(
        "store migrations must be 1..n without gaps or duplicates: expected " +
          expected +
          ", got " +
          migration.version,
      );
    }
    expected += 1;
  }
}

const statements = (script: string): readonly string[] =>
  script
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const versionSchema = v.object({ version: v.number() });

const readVersion = async (sql: Sql): Promise<number> =>
  v.parse(
    versionSchema,
    await sql.get("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations"),
  ).version;

/**
 * Apply the pending migrations to `sql`.
 *
 * @internal
 * @remarks
 * The schema version lives in `schema_migrations` so one runner works on D1, which rejects
 * `PRAGMA user_version`. Each migration's statements and its version row go in one `batch`,
 * which D1 runs atomically, so a failure leaves no table or version row from that migration
 * behind (the empty `schema_migrations` table is created first). The version is monotonic, so
 * reopening an up-to-date database is a no-op.
 * A database whose version is newer than this build is refused rather than opened and
 * damaged.
 *
 * @param sql - The D1 adapter for the database.
 * @param migrations - The version list; tests pass fixtures, production uses {@link MIGRATIONS}.
 * @throws Error if `sql` records a version newer than this build supports.
 * @throws Whatever a migration threw; that migration is rolled back and later ones are not
 * attempted. A lost race with another opener whose version already advanced is not an error.
 */
export async function migrate(
  sql: Sql,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<void> {
  assertMigrations(migrations);
  await sql.batch([
    { sql: "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)" },
  ]);
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  const current = await readVersion(sql);
  if (current > latest) {
    throw new Error(
      "store schema version " + current + " is newer than " + latest + "; open a new database",
    );
  }
  let applied = current;
  for (const migration of migrations) {
    if (migration.version <= applied) continue;
    try {
      await sql.batch(
        [
          ...statements(migration.sql),
          "INSERT INTO schema_migrations (version) VALUES (" + migration.version + ")",
        ].map((statement) => ({ sql: statement })),
      );
      applied = migration.version;
    } catch (error) {
      // Another isolate can apply the same version between our read and this write. D1
      // rolled our script back, so continue only when the version now includes this step.
      const after = await readVersion(sql);
      if (after < migration.version) throw error;
      applied = after;
    }
  }
}

/**
 * Apply the pending migrations through a D1 binding.
 *
 * @remarks
 * `openStore` runs the same runner. This entry is for a deploy or maintenance step that
 * must migrate without opening the repositories.
 *
 * @param d1 - The D1 binding to migrate.
 * @throws Error if the database is newer than this build or a migration fails.
 */
export async function migrateStore(d1: D1Binding): Promise<void> {
  const sql = createSql(d1);
  try {
    await migrate(sql);
  } finally {
    await sql.close();
  }
}
