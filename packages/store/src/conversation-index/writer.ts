import * as v from "valibot";
import { createSql, type D1Binding, type SqlStatement } from "../sql.ts";
import type { ConversationIndexRow, IndexStateRow } from "./model.ts";
import { readIndexState, writeIndexState } from "./state.ts";

/** D1 refuses a statement with more than 100 bound parameters; stay under it. */
const MAX_PARAMETERS = 90;

const COLUMNS = "id, project_id, title, created_at, updated_at, archived, deleted_at, indexed_at";

const UPDATE =
  "DO UPDATE SET title = excluded.title, created_at = excluded.created_at, " +
  "updated_at = excluded.updated_at, archived = excluded.archived, " +
  "deleted_at = excluded.deleted_at, indexed_at = excluded.indexed_at";

const INSERT = "INSERT INTO conversations (" + COLUMNS + ") VALUES (?, ?, ?, ?, ?, ?, ?, ?) ";

/** The monotonic upsert: a stale resend never rolls a newer row back. */
const UPSERT =
  INSERT +
  "ON CONFLICT(project_id, id) " +
  UPDATE +
  " WHERE excluded.updated_at >= COALESCE(conversations.updated_at, conversations.created_at)";

/** The rebuild upsert: reindex is authoritative, so it repairs a row whatever it says. */
const UPSERT_FORCED = INSERT + "ON CONFLICT(project_id, id) " + UPDATE;

/** One id column, for the ids already stored under a project. */
const IdRowSchema = v.object({ id: v.string() });

/** The row's bind values, in {@link COLUMNS} order. */
function values(row: ConversationIndexRow): readonly (string | number | null)[] {
  return [
    row.id,
    row.projectId,
    row.title,
    row.createdAt,
    row.updatedAt,
    row.archived ? 1 : 0,
    row.deletedAt,
    row.indexedAt,
  ];
}

/** Split a list into batches small enough for one D1 statement's parameter limit. */
function chunks<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const out: (readonly T[])[] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * The narrow write face a Session object has on the D1 conversation index.
 *
 * @remarks
 * The Session owns the conversations and this is the only table it may write (0145's index
 * exception, D078). Reads of the index go through the store's conversation repository; the
 * object never reads control data. `upsert` is monotonic so a resend of an older row cannot
 * roll a newer one back; `replaceAll` is the rebuild and writes what the object says.
 */
export interface ConversationIndex {
  /** Write or refresh rows; a row whose `updatedAt` is older than the stored one is left alone. */
  upsert(rows: readonly ConversationIndexRow[]): Promise<void>;
  /** Delete these ids in one project; ids that are absent are ignored. */
  remove(projectId: string, ids: readonly string[]): Promise<number>;
  /**
   * Make the project's rows match `rows` exactly: upsert every row, then delete the ones the
   * caller no longer knows. Upserts run first, so an interrupted rebuild never leaves the index
   * missing rows.
   */
  replaceAll(
    projectId: string,
    rows: readonly ConversationIndexRow[],
  ): Promise<{ readonly indexed: number; readonly removed: number }>;
  /** The workspace's recorded state, or undefined when no drain has written one. */
  state(workspaceId: string): Promise<IndexStateRow | undefined>;
  /** Record a transition of the workspace's state. */
  writeState(workspaceId: string, state: IndexStateRow, at: string): Promise<void>;
}

/**
 * Open the conversation index writer over a D1 binding.
 *
 * @param db - The control database binding (`env.DB`).
 * @returns The writer; it holds no resources and has nothing to close (D1 does).
 *
 * @remarks
 * The binding is the Session's only access to the control database. A deployment without one
 * never calls this: the object then keeps its dirty rows and the chat still works.
 */
export function openConversationIndex(db: D1Binding): ConversationIndex {
  const sql = createSql(db);

  const write = async (rows: readonly ConversationIndexRow[], forced: boolean): Promise<void> => {
    if (rows.length === 0) return;
    const statements: SqlStatement[] = rows.map((row) => ({
      sql: forced ? UPSERT_FORCED : UPSERT,
      params: values(row),
    }));
    for (const batch of chunks(statements, MAX_PARAMETERS)) await sql.batch(batch);
  };

  const remove = async (projectId: string, ids: readonly string[]): Promise<number> => {
    let removed = 0;
    for (const batch of chunks(ids, MAX_PARAMETERS)) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(", ");
      removed += await sql.run(
        "DELETE FROM conversations WHERE project_id = ? AND id IN (" + placeholders + ")",
        [projectId, ...batch],
      );
    }
    return removed;
  };

  return {
    upsert: (rows) => write(rows, false),
    remove,
    async replaceAll(projectId, rows) {
      await write(rows, true);
      const known = new Set(rows.map((row) => row.id));
      const stored = await sql.all("SELECT id FROM conversations WHERE project_id = ?", [
        projectId,
      ]);
      const stale = stored
        .map((row) => v.parse(IdRowSchema, row).id)
        .filter((id) => !known.has(id));
      return { indexed: rows.length, removed: await remove(projectId, stale) };
    },
    state: (workspaceId) => readIndexState(sql, workspaceId),
    writeState: (workspaceId, state, at) => writeIndexState(sql, workspaceId, state, at),
  };
}
