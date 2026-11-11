import type { Conversation, ConversationId, ProjectId } from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseConversation } from "../parse.ts";

/**
 * Filters for {@link ConversationRepository.list}.
 *
 * @remarks
 * Archived conversations are omitted unless `includeArchived` is true, and soft-deleted
 * ones are always omitted. `q` matches the title literally: LIKE wildcards are escaped.
 */
export interface ConversationListQuery {
  /** Restrict to one project; omitted lists every project. */
  readonly projectId?: ProjectId | undefined;
  /** Title substring; `%`, `_`, and `\` match themselves. */
  readonly q?: string | undefined;
  /** Include archived conversations; defaults to false. */
  readonly includeArchived?: boolean | undefined;
  /** Maximum rows; clamped to 1..500. Defaults to 100. */
  readonly limit?: number | undefined;
}

/**
 * Conversations: the durable chat threads.
 *
 * @remarks
 * Delete is a tombstone (`deleted_at`), not a row delete: a deleted conversation disappears
 * from `list` but `get` still returns it. Missing rows return `undefined`, and each write
 * runs in one transaction.
 */
export interface ConversationRepository {
  /**
   * Conversations matching `query`, most recently active first.
   *
   * @remarks
   * Activity is `updated_at`, falling back to `created_at` when the conversation has never
   * been touched.
   */
  list(query?: ConversationListQuery): Conversation[];
  /** The conversation with `id`, including a soft-deleted one, or `undefined`. */
  get(id: ConversationId): Conversation | undefined;
  /**
   * Insert a conversation, or update the project and title when `id` already exists.
   *
   * @remarks
   * The upsert bumps `updated_at`, so re-registering records activity.
   *
   * @returns The stored conversation.
   * @throws Error if the row is missing after the write (a broken connection).
   */
  register(input: { id: ConversationId; projectId: ProjectId; title: string }): Conversation;
  /** Rename a conversation; `undefined` when it does not exist. */
  rename(id: ConversationId, title: string): Conversation | undefined;
  /** Set the archived flag; `undefined` when the conversation does not exist. */
  setArchived(id: ConversationId, archived: boolean): Conversation | undefined;
  /**
   * Soft-delete a conversation by setting `deleted_at`.
   *
   * @remarks
   * The row stays for its history and usage; `get` still returns it. `undefined` when it
   * does not exist.
   */
  delete(id: ConversationId): Conversation | undefined;
  /** Record activity by bumping `updated_at`; a no-op when the conversation is missing. */
  touch(id: ConversationId): void;
}

/**
 * Build the conversation repository over `context`.
 *
 * @internal
 */
export function conversationRepository(context: StoreContext): ConversationRepository {
  const { db, now, transaction } = context;

  const get = (id: ConversationId): Conversation | undefined => {
    const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);
    return row === undefined ? undefined : parseConversation(row);
  };

  return {
    list(query = {}) {
      const clauses = ["deleted_at IS NULL"];
      const params: Array<string | number> = [];
      if (query.includeArchived !== true) clauses.push("archived = 0");
      if (query.projectId !== undefined) {
        clauses.push("project_id = ?");
        params.push(query.projectId);
      }
      if (query.q !== undefined && query.q !== "") {
        const escaped = query.q
          .replaceAll("\\", "\\\\")
          .replaceAll("%", "\\%")
          .replaceAll("_", "\\_");
        clauses.push("title LIKE ? ESCAPE '\\'");
        params.push("%" + escaped + "%");
      }
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 500);
      const rows = db
        .prepare(
          "SELECT * FROM conversations WHERE " +
            clauses.join(" AND ") +
            " ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?",
        )
        .all(...params, limit);
      return rows.map((row) => parseConversation(row));
    },
    get,
    register(input) {
      transaction(() => {
        db.prepare(
          "INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, updated_at = excluded.updated_at",
        ).run(input.id, input.projectId, input.title, now(), now());
      });
      const conversation = get(input.id);
      if (conversation === undefined) throw new Error("conversation was not registered");
      return conversation;
    },
    rename(id, title) {
      transaction(() => {
        db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(
          title,
          now(),
          id,
        );
      });
      return get(id);
    },
    setArchived(id, archived) {
      transaction(() => {
        db.prepare("UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?").run(
          archived ? 1 : 0,
          now(),
          id,
        );
      });
      return get(id);
    },
    delete(id) {
      transaction(() => {
        db.prepare("UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?").run(
          now(),
          now(),
          id,
        );
      });
      return get(id);
    },
    touch(id) {
      transaction(() => {
        db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), id);
      });
    },
  };
}
