import type { ConversationId, Usage } from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseUsageToday } from "../parse.ts";

export interface UsageInput {
  readonly conversationId?: ConversationId | undefined;
  readonly tokens: number;
  readonly cost: number;
  readonly requestId?: string | undefined;
}

export interface UsageRepository {
  add(input: UsageInput): void;
  today(date?: string): Usage["today"];
}

export function usageRepository(context: StoreContext): UsageRepository {
  const { db, now, newId, transaction } = context;

  return {
    add(input) {
      transaction(() => {
        db.prepare(
          "INSERT INTO usage_log (id, conversation_id, at, tokens, cost, request_id) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
          newId(),
          input.conversationId ?? null,
          now(),
          Math.round(input.tokens),
          input.cost,
          input.requestId ?? null,
        );
      });
    },
    today(date = now().slice(0, 10)) {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS turns, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost FROM usage_log WHERE substr(at, 1, 10) = ?",
        )
        .get(date);
      return parseUsageToday(row ?? { turns: 0, tokens: 0, cost: 0 });
    },
  };
}
