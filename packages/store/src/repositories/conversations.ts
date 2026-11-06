import type { Conversation, ConversationId, ProjectId } from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseConversation } from "../parse.ts";

export interface ConversationListQuery {
  readonly projectId?: ProjectId | undefined;
  readonly q?: string | undefined;
  readonly includeArchived?: boolean | undefined;
  readonly limit?: number | undefined;
}

export interface ConversationRepository {
  list(query?: ConversationListQuery): Conversation[];
  get(id: ConversationId): Conversation | undefined;
  register(input: { id: ConversationId; projectId: ProjectId; title: string }): Conversation;
  rename(id: ConversationId, title: string): Conversation | undefined;
  setArchived(id: ConversationId, archived: boolean): Conversation | undefined;
  delete(id: ConversationId): Conversation | undefined;
  touch(id: ConversationId): void;
}

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
