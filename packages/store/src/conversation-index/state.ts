import * as v from "valibot";
import type { Sql } from "../sql.ts";
import { IndexStateRowSchema, type IndexStateRow } from "./model.ts";

/**
 * Read one workspace's index state.
 *
 * @internal
 * @param sql - The D1 adapter for the control database.
 * @param workspaceId - The Session object's name (one row per workspace).
 * @returns The recorded state, or undefined when no drain has written one yet.
 * @throws ValiError when the stored row is corrupt (a negative backlog, a missing column).
 */
export async function readIndexState(
  sql: Sql,
  workspaceId: string,
): Promise<IndexStateRow | undefined> {
  const row = await sql.get("SELECT * FROM index_state WHERE workspace_id = ?", [workspaceId]);
  if (row === undefined) return undefined;
  return v.parse(IndexStateRowSchema, row);
}

/**
 * Write one workspace's index state.
 *
 * @internal
 * @remarks
 * One upsert, so a concurrent writer leaves the row in one of the two states rather than a mix.
 * The caller writes only on a transition (backlog appears, is cleared, or an error is recorded),
 * not on every turn (D078 U-04).
 */
export async function writeIndexState(
  sql: Sql,
  workspaceId: string,
  state: IndexStateRow,
  at: string,
): Promise<void> {
  await sql.run(
    "INSERT INTO index_state (workspace_id, pending, last_synced_at, last_error_code, last_error_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(workspace_id) DO UPDATE SET pending = excluded.pending, " +
      "last_synced_at = excluded.last_synced_at, last_error_code = excluded.last_error_code, " +
      "last_error_at = excluded.last_error_at, updated_at = excluded.updated_at",
    [workspaceId, state.pending, state.lastSyncedAt, state.lastErrorCode, state.lastErrorAt, at],
  );
}
