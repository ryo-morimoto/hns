import * as v from "valibot";
import { createSql, type D1Binding, type Sql } from "./sql.ts";

/** One forward step: the schema SQL and the `schema_migrations` version it records. */
interface Migration {
  readonly version: number;
  readonly sql: string;
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  event TEXT NOT NULL,
  request_id TEXT,
  conversation_id TEXT,
  status INTEGER,
  duration_ms INTEGER,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS usage_log (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  at TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  cost REAL NOT NULL,
  request_id TEXT
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  graph_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  graph_json TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS workflow_nodes (
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT,
  output TEXT,
  conversation_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, node_id)
);
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  token TEXT UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_fired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS firings (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE INDEX IF NOT EXISTS usage_at ON usage_log (at);
CREATE INDEX IF NOT EXISTS conversations_project ON conversations (project_id, updated_at);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project_id, created_at);
CREATE INDEX IF NOT EXISTS workflows_project ON workflows (project_id, created_at);
CREATE INDEX IF NOT EXISTS workflow_runs_workflow ON workflow_runs (workflow_id, created_at);
CREATE INDEX IF NOT EXISTS automations_project ON automations (project_id, created_at);
CREATE INDEX IF NOT EXISTS firings_automation ON firings (automation_id, created_at);
`;

const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: SCHEMA_V1 }];

/**
 * Split one migration script into statements.
 *
 * @remarks
 * The migrations are our own SQL and contain no semicolons inside literals, so splitting on
 * `;` is safe. Statements go through `batch` rather than `exec`: D1's batch is atomic and
 * keeps the multi-line DDL intact.
 */
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
 * @throws Error if `sql` records a version newer than this build supports.
 * @throws Whatever a migration threw; that migration is rolled back and later ones are not
 * attempted. A lost race with another opener whose version already advanced is not an error.
 */
export async function migrate(sql: Sql): Promise<void> {
  await sql.batch([
    { sql: "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)" },
  ]);
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  const current = await readVersion(sql);
  if (current > latest) {
    throw new Error(
      "store schema version " + current + " is newer than " + latest + "; open a new database",
    );
  }
  let applied = current;
  for (const migration of MIGRATIONS) {
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
