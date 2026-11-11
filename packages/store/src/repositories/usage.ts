import type { ConversationId, Usage } from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseUsageToday } from "../parse.ts";

/**
 * One usage record to append.
 *
 * @remarks
 * `tokens` is rounded to an integer before it is stored; `cost` is stored as given.
 */
export interface UsageInput {
  readonly conversationId?: ConversationId | undefined;
  readonly tokens: number;
  readonly cost: number;
  readonly requestId?: string | undefined;
}

/**
 * Recorded model usage.
 *
 * @remarks
 * `add` appends one row in a transaction. `today` aggregates by the date prefix of `at`;
 * an empty day returns zeroed totals rather than null.
 */
export interface UsageRepository {
  /** Append one usage record, stamped with the context clock and id source. */
  add(input: UsageInput): void;
  /**
   * Totals for one day.
   *
   * @param date - The date prefix to match (`YYYY-MM-DD`); defaults to the clock's date.
   * @returns Turns, tokens, and cost for that day.
   */
  today(date?: string): Usage["today"];
}

/**
 * Build the usage repository over `context`.
 *
 * @internal
 */
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
