import type { Conversation, ConversationId, ProjectId } from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseConversation } from "../parse.ts";

/**
 * Where a conversation page stopped.
 *
 * @remarks
 * The pair is the ordering key: `(updated_at, id)` descending. A client returns it unchanged as
 * `after` to read the next page.
 */
export interface ConversationCursor {
  readonly updatedAt: string;
  readonly id: ConversationId;
}

/**
 * Filters for {@link ConversationRepository.page}.
 *
 * @remarks
 * Archived conversations are omitted unless `includeArchived` is true, and soft-deleted ones
 * are always omitted. `q` matches the title literally: LIKE wildcards are escaped. `after` is
 * a keyset position, not an offset, so a row that moves between pages is never skipped
 * permanently.
 */
export interface ConversationListQuery {
  /** Restrict to one project; omitted lists every project. */
  readonly projectId?: ProjectId | undefined;
  /** Title substring; `%`, `_`, and `\\` match themselves. */
  readonly q?: string | undefined;
  /** Include archived conversations; defaults to false. */
  readonly includeArchived?: boolean | undefined;
  /** Maximum rows; clamped to 1..500. Defaults to 100. */
  readonly limit?: number | undefined;
  /** Return only rows ordered after this position. */
  readonly after?: ConversationCursor | undefined;
}

/** One page of conversations and the position to continue from. */
export interface ConversationPage {
  readonly items: Conversation[];
  /** The last row's position when more rows exist, else null. */
  readonly nextCursor: ConversationCursor | null;
}

/**
 * Conversations: the D1 index the Session objects write.
 *
 * @remarks
 * A row is listed only once a Session wrote it (`indexed_at` is not null), so a row left by an
 * older build is not shown as a conversation that no object knows. Delete is a tombstone
 * (`deleted_at`): a deleted conversation disappears from `page` but `get` still returns it.
 * Missing rows return `undefined`.
 */
export interface ConversationRepository {
  /**
   * Conversations matching `query`, most recently active first.
   *
   * @remarks
   * Activity is `updated_at`; the writer fills it from `created_at` when a conversation is
   * created, so it is never null for an indexed row. The ordering key is `(updated_at, id)`,
   * which is also the cursor, so pages join without a gap; a row updated between two reads can
   * appear twice, and the caller folds duplicates by id. The statement is written against the
   * `conversations_page` index instead of a `COALESCE` expression, so the sort is a seek.
   */
  page(query?: ConversationListQuery): Promise<ConversationPage>;
  /** The conversation with `id` in `projectId`, including a soft-deleted one, or `undefined`. */
  get(projectId: ProjectId, id: ConversationId): Promise<Conversation | undefined>;
  /**
   * The conversation with `id`, wherever its project is, including a soft-deleted one.
   *
   * @remarks
   * The primary key is `(project_id, id)`, and a conversation id is unique within its project (the
   * Session object's name), so the pair a send needs — the conversation and therefore its project —
   * is one read. This is the lookup a face performs **before** it addresses an object (0270n): the
   * object cannot read D1 (D049), so the Worker is what says which project a conversation belongs
   * to, and a send names the object by the conversation's own id.
   */
  findById(id: ConversationId): Promise<Conversation | undefined>;
  /** Record activity by bumping `updated_at`; a no-op when the conversation is missing. */
  touch(projectId: ProjectId, id: ConversationId): Promise<void>;
}

/** Escape LIKE metacharacters so a search term matches itself. */
function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/**
 * Build the conversation repository over `context`.
 *
 * @internal
 */
export function conversationRepository(context: StoreContext): ConversationRepository {
  const { sql, now } = context;

  const get = async (
    projectId: ProjectId,
    id: ConversationId,
  ): Promise<Conversation | undefined> => {
    const row = await sql.get("SELECT * FROM conversations WHERE project_id = ? AND id = ?", [
      projectId,
      id,
    ]);
    return row === undefined ? undefined : parseConversation(row);
  };
  const findById = async (id: ConversationId): Promise<Conversation | undefined> => {
    // Without a project the row is found through the primary key's leading column no more; the
    // read is by id alone, which SQLite answers from the key's rowid index.
    const row = await sql.get("SELECT * FROM conversations WHERE id = ? LIMIT 1", [id]);
    return row === undefined ? undefined : parseConversation(row);
  };

  return {
    async page(query = {}) {
      const clauses = ["deleted_at IS NULL", "indexed_at IS NOT NULL"];
      const params: Array<string | number> = [];
      if (query.includeArchived !== true) clauses.push("archived = 0");
      if (query.projectId !== undefined) {
        clauses.push("project_id = ?");
        params.push(query.projectId);
      }
      if (query.q !== undefined && query.q !== "") {
        clauses.push("title LIKE ? ESCAPE '\\'");
        params.push("%" + escapeLike(query.q) + "%");
      }
      if (query.after !== undefined) {
        clauses.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
        params.push(query.after.updatedAt, query.after.updatedAt, query.after.id);
      }
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
      const rows = await sql.all(
        "SELECT * FROM conversations WHERE " +
          clauses.join(" AND ") +
          " ORDER BY updated_at DESC, id DESC LIMIT ?",
        [...params, limit + 1],
      );
      const items = rows.slice(0, limit).map((row) => parseConversation(row));
      const last = items[items.length - 1];
      const nextCursor =
        rows.length > limit && last !== undefined
          ? { updatedAt: last.updated_at ?? last.created_at, id: last.id }
          : null;
      return { items, nextCursor };
    },
    get,
    findById,
    async touch(projectId, id) {
      await sql.run(
        "UPDATE conversations SET updated_at = ?, indexed_at = ? WHERE project_id = ? AND id = ?",
        [now(), now(), projectId, id],
      );
    },
  };
}
