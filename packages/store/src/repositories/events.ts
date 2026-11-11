import * as v from "valibot";
import {
  EVENT_NAMES,
  type ConversationId,
  type Event,
  type EventLevel,
  type EventName,
  type JsonValue,
  type Metrics,
} from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseEvent, parseUsageToday } from "../parse.ts";

/**
 * Filters for {@link EventRepository.list}.
 *
 * @remarks
 * `since` is an inclusive lower bound compared as text, so it must be an ISO timestamp.
 * `limit` is clamped to 1..1000 and defaults to 100.
 */
export interface EventListQuery {
  /** Maximum rows; clamped to 1..1000. Defaults to 100. */
  readonly limit?: number | undefined;
  /** Only events at this level. */
  readonly level?: EventLevel | undefined;
  /** Only events at or after this ISO timestamp. */
  readonly since?: string | undefined;
}

/**
 * One event to append.
 *
 * @remarks
 * `detail` is stored as JSON text; `undefined` means no detail and becomes null. `level`
 * defaults to `info`. `status` and `durationMs` describe an HTTP response and stay null on
 * other events.
 */
export interface EventInput {
  readonly level?: EventLevel | undefined;
  readonly event: EventName;
  /** The request that produced the event, when one applies. */
  readonly requestId?: string | undefined;
  readonly conversationId?: ConversationId | undefined;
  readonly status?: number | undefined;
  readonly durationMs?: number | undefined;
  /** Structured detail; stored as JSON text and decoded on read. */
  readonly detail?: JsonValue | undefined;
}

/**
 * The append-only event log and the aggregates computed from it.
 *
 * @remarks
 * `add` and `prune` are one statement each. Metrics read the last 24 hours plus today's
 * usage; they return zeros on an empty log rather than null.
 */
export interface EventRepository {
  /** Append one event, stamped with the context clock and id source. */
  add(input: EventInput): Promise<void>;
  /** Events matching `query`, newest first. */
  list(query?: EventListQuery): Promise<Event[]>;
  /**
   * Delete events older than `days` before now.
   *
   * @param days - The retention window; defaults to 30.
   * @returns The number of rows deleted.
   */
  prune(days?: number): Promise<number>;
  /**
   * Aggregate the event log for the observability view.
   *
   * @remarks
   * `http` percentiles, `chats`, `errors`, tool counts, and `byEvent` cover the last 24
   * hours. `workflowRuns` and `firings` count every row by status, and `tokensToday` reads
   * today's usage.
   */
  metrics(): Promise<Metrics>;
}

const countSchema = v.object({ count: v.number() });
const statusCountSchema = v.object({ status: v.string(), count: v.number() });
const httpStatusSchema = v.object({ status: v.number(), count: v.number() });
const durationSchema = v.object({ ms: v.number() });
const eventCountSchema = v.object({ event: v.string(), count: v.number() });
const namedCountSchema = v.object({ event: v.picklist(EVENT_NAMES), count: v.number() });

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- countSchema parses the row here.
const countOf = (row: unknown): number => v.parse(countSchema, row ?? { count: 0 }).count;

/**
 * Build the event repository over `context`.
 *
 * @internal
 */
export function eventRepository(context: StoreContext): EventRepository {
  const { sql, now, newId } = context;

  return {
    async add(input) {
      await sql.run(
        "INSERT INTO events (id, at, level, event, request_id, conversation_id, status, duration_ms, detail) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          newId(),
          now(),
          input.level ?? "info",
          input.event,
          input.requestId ?? null,
          input.conversationId ?? null,
          input.status ?? null,
          input.durationMs ?? null,
          input.detail === undefined ? null : JSON.stringify(input.detail),
        ],
      );
    },
    async list(query = {}) {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (query.level !== undefined) {
        clauses.push("level = ?");
        params.push(query.level);
      }
      if (query.since !== undefined) {
        clauses.push("at >= ?");
        params.push(query.since);
      }
      const where = clauses.length === 0 ? "" : " WHERE " + clauses.join(" AND ");
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 1000);
      const rows = await sql.all("SELECT * FROM events" + where + " ORDER BY at DESC LIMIT ?", [
        ...params,
        limit,
      ]);
      return rows.map((row) => parseEvent(row));
    },
    async prune(days = 30) {
      const cutoff = new Date(Date.parse(now()) - days * 86_400_000).toISOString();
      return await sql.run("DELETE FROM events WHERE at < ?", [cutoff]);
    },
    async metrics() {
      const since = new Date(Date.parse(now()) - 86_400_000).toISOString();
      const durations = (
        await sql.all(
          "SELECT duration_ms AS ms FROM events WHERE event = 'http' AND at >= ? AND duration_ms IS NOT NULL ORDER BY duration_ms",
          [since],
        )
      ).map((row) => v.parse(durationSchema, row).ms);
      const percentile = (p: number): number => {
        if (durations.length === 0) return 0;
        const index = Math.min(durations.length - 1, Math.floor(durations.length * p));
        return durations[index] ?? 0;
      };
      const group = async (
        table: "workflow_runs" | "firings",
      ): Promise<Array<{ status: string; count: number }>> =>
        (await sql.all("SELECT status, COUNT(*) AS count FROM " + table + " GROUP BY status")).map(
          (row) => v.parse(statusCountSchema, row),
        );
      const chats = Object.fromEntries(
        (
          await sql.all(
            "SELECT event, COUNT(*) AS count FROM events WHERE event IN ('chat.submitted', 'chat.settled') AND at >= ? GROUP BY event",
            [since],
          )
        ).map((row) => {
          const parsed = v.parse(eventCountSchema, row);
          return [parsed.event, parsed.count];
        }),
      );
      const usage = await sql.get(
        "SELECT COUNT(*) AS turns, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost FROM usage_log WHERE substr(at, 1, 10) = ?",
        [now().slice(0, 10)],
      );
      return {
        http: {
          total: countOf(
            await sql.get("SELECT COUNT(*) AS count FROM events WHERE event = 'http' AND at >= ?", [
              since,
            ]),
          ),
          byStatus: (
            await sql.all(
              "SELECT status, COUNT(*) AS count FROM events WHERE event = 'http' AND at >= ? AND status IS NOT NULL GROUP BY status",
              [since],
            )
          ).map((row) => v.parse(httpStatusSchema, row)),
          p50ms: percentile(0.5),
          p95ms: percentile(0.95),
        },
        chats,
        workflowRuns: await group("workflow_runs"),
        firings: await group("firings"),
        errors: countOf(
          await sql.get("SELECT COUNT(*) AS count FROM events WHERE level = 'error' AND at >= ?", [
            since,
          ]),
        ),
        toolCalls: countOf(
          await sql.get(
            "SELECT COUNT(*) AS count FROM events WHERE event = 'tool.result' AND at >= ?",
            [since],
          ),
        ),
        toolErrors: countOf(
          await sql.get(
            "SELECT COUNT(*) AS count FROM events WHERE event = 'tool.result' AND level = 'warn' AND at >= ?",
            [since],
          ),
        ),
        agentResponses: countOf(
          await sql.get(
            "SELECT COUNT(*) AS count FROM events WHERE event = 'agent.response' AND at >= ?",
            [since],
          ),
        ),
        byEvent: (
          await sql.all(
            "SELECT event, COUNT(*) AS count FROM events WHERE at >= ? GROUP BY event ORDER BY count DESC LIMIT 25",
            [since],
          )
        ).map((row) => v.parse(namedCountSchema, row)),
        tokensToday: parseUsageToday(usage ?? { turns: 0, tokens: 0, cost: 0 }),
      };
    },
  };
}
