import type { Migration } from "./migration.ts";

const SQL = `
CREATE TABLE conversations_next (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  deleted_at TEXT,
  indexed_at TEXT,
  PRIMARY KEY (project_id, id)
);
INSERT INTO conversations_next (id, project_id, title, created_at, updated_at, archived, deleted_at, indexed_at) SELECT id, project_id, title, created_at, updated_at, archived, deleted_at, NULL FROM conversations;
DROP TABLE conversations;
ALTER TABLE conversations_next RENAME TO conversations;
CREATE INDEX conversations_activity ON conversations (project_id, updated_at DESC, id);
CREATE TABLE IF NOT EXISTS index_state (
  workspace_id TEXT PRIMARY KEY,
  pending INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0),
  last_synced_at TEXT,
  last_error_code TEXT,
  last_error_at TEXT,
  updated_at TEXT NOT NULL
);
`;

/**
 * The fifth schema step: conversations become the project-scoped index the Session writes.
 *
 * @remarks
 * The old key was `id` alone, which one project's object could not keep separate from another's
 * (D080). The table is rebuilt because SQLite cannot change a primary key in place: every row is
 * copied, so nothing is dropped, and the new key is `(project_id, id)`. A collision is impossible
 * from a database this migration built (the old key was a superset of the new one); if one ever
 * existed, the copy would fail, the batch would roll back, and the store would not open — the
 * database is left untouched rather than half-migrated.
 *
 * `indexed_at` is the new column: NULL means no Session has written the row into the index yet, so
 * a Session object's first drain (the backfill) is what fills it. `updated_at` stays nullable for
 * rows older than the index; the writer always fills it, and since migration 6 the page reads it
 * directly (the index is on `updated_at`, not on a `COALESCE`).
 *
 * `index_state` is one row per workspace (the Session object's name): the backlog size and the
 * last success or failure, written only when that state changes (D078 U-04).
 */
export const migration0005: Migration = { version: 5, sql: SQL };
