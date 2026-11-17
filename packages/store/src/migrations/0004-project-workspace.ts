import type { Migration } from "./migration.ts";

const SQL = `
ALTER TABLE projects ADD COLUMN workspace_root TEXT NOT NULL DEFAULT '';
`;

/**
 * The fourth schema step: every project names its directory below the machine ROOT.
 *
 * @remarks
 * Existing projects already ran with the machine's ROOT, so the column's default (`''`) is what
 * they were using, not a guessed value. A row whose value is missing or not canonical fails
 * `parseProject` instead of being read as the ROOT: the migration never rewrites a root, and no
 * caller coalesces a bad one. SQLite applies the default to existing rows when the column is
 * added, so no separate `UPDATE` runs. The agent's cwd is not stored: it is the same value.
 */
export const migration0004: Migration = { version: 4, sql: SQL };
