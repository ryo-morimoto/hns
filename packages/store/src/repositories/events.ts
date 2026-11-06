import * as v from "valibot";
import type { SQLOutputValue } from "node:sqlite";
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

export interface EventListQuery {
  readonly limit?: number | undefined;
  readonly level?: EventLevel | undefined;
  readonly since?: string | undefined;
}

export interface EventInput {
  readonly level?: EventLevel | undefined;
  readonly event: EventName;
  readonly requestId?: string | undefined;
  readonly conversationId?: ConversationId | undefined;
  readonly status?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly detail?: JsonValue | undefined;
}

export interface EventRepository {
  add(input: EventInput): void;
  list(query?: EventListQuery): Event[];
  prune(days?: number): number;
  metrics(): Metrics;
}

const countSchema = v.object({ count: v.number() });
const statusCountSchema = v.object({ status: v.string(), count: v.number() });
const httpStatusSchema = v.object({ status: v.number(), count: v.number() });
const durationSchema = v.object({ ms: v.number() });
const eventCountSchema = v.object({ event: v.string(), count: v.number() });
const namedCountSchema = v.object({ event: v.picklist(EVENT_NAMES), count: v.number() });

const countOf = (row: Record<string, SQLOutputValue> | undefined): number =>
  v.parse(countSchema, row ?? { count: 0 }).count;

export function eventRepository(context: StoreContext): EventRepository {
  const { db, now, newId, transaction } = context;

  return {
    add(input) {
      transaction(() => {
        db.prepare(
          "INSERT INTO events (id, at, level, event, request_id, conversation_id, status, duration_ms, detail) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          newId(),
          now(),
          input.level ?? "info",
          input.event,
          input.requestId ?? null,
          input.conversationId ?? null,
          input.status ?? null,
          input.durationMs ?? null,
          input.detail === undefined ? null : JSON.stringify(input.detail),
        );
      });
    },
    list(query = {}) {
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
      const rows = db
        .prepare("SELECT * FROM events" + where + " ORDER BY at DESC LIMIT ?")
        .all(...params, limit);
      return rows.map((row) => parseEvent(row));
    },
    prune(days = 30) {
      const cutoff = new Date(Date.parse(now()) - days * 86_400_000).toISOString();
      return transaction(() => {
        const result = db.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
        return Number(result.changes);
      });
    },
    metrics() {
      const since = new Date(Date.parse(now()) - 86_400_000).toISOString();
      const durations = db
        .prepare(
          "SELECT duration_ms AS ms FROM events WHERE event = 'http' AND at >= ? AND duration_ms IS NOT NULL ORDER BY duration_ms",
        )
        .all(since)
        .map((row) => v.parse(durationSchema, row).ms);
      const percentile = (p: number): number => {
        if (durations.length === 0) return 0;
        const index = Math.min(durations.length - 1, Math.floor(durations.length * p));
        return durations[index] ?? 0;
      };
      const group = (table: "workflow_runs" | "firings") =>
        db
          .prepare("SELECT status, COUNT(*) AS count FROM " + table + " GROUP BY status")
          .all()
          .map((row) => v.parse(statusCountSchema, row));
      const chats = Object.fromEntries(
        db
          .prepare(
            "SELECT event, COUNT(*) AS count FROM events WHERE event IN ('chat.submitted', 'chat.settled') AND at >= ? GROUP BY event",
          )
          .all(since)
          .map((row) => {
            const parsed = v.parse(eventCountSchema, row);
            return [parsed.event, parsed.count];
          }),
      );
      const usage = db
        .prepare(
          "SELECT COUNT(*) AS turns, COALESCE(SUM(tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost FROM usage_log WHERE substr(at, 1, 10) = ?",
        )
        .get(now().slice(0, 10));
      return {
        http: {
          total: countOf(
            db
              .prepare("SELECT COUNT(*) AS count FROM events WHERE event = 'http' AND at >= ?")
              .get(since),
          ),
          byStatus: db
            .prepare(
              "SELECT status, COUNT(*) AS count FROM events WHERE event = 'http' AND at >= ? AND status IS NOT NULL GROUP BY status",
            )
            .all(since)
            .map((row) => v.parse(httpStatusSchema, row)),
          p50ms: percentile(0.5),
          p95ms: percentile(0.95),
        },
        chats,
        workflowRuns: group("workflow_runs"),
        firings: group("firings"),
        errors: countOf(
          db
            .prepare("SELECT COUNT(*) AS count FROM events WHERE level = 'error' AND at >= ?")
            .get(since),
        ),
        toolCalls: countOf(
          db
            .prepare("SELECT COUNT(*) AS count FROM events WHERE event = 'tool.result' AND at >= ?")
            .get(since),
        ),
        toolErrors: countOf(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM events WHERE event = 'tool.result' AND level = 'warn' AND at >= ?",
            )
            .get(since),
        ),
        agentResponses: countOf(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM events WHERE event = 'agent.response' AND at >= ?",
            )
            .get(since),
        ),
        byEvent: db
          .prepare(
            "SELECT event, COUNT(*) AS count FROM events WHERE at >= ? GROUP BY event ORDER BY count DESC LIMIT 25",
          )
          .all(since)
          .map((row) => v.parse(namedCountSchema, row)),
        tokensToday: parseUsageToday(usage ?? { turns: 0, tokens: 0, cost: 0 }),
      };
    },
  };
}
