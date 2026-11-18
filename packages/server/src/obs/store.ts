import * as v from "valibot";
import {
  EVENT_LEVELS,
  EVENT_NAMES,
  OBS_HOPS,
  OBS_MAX_EVENTS,
  OBS_MAX_QUERY_LIMIT,
  OBS_RETENTION_DAYS,
  parseObsLog,
  type EventLevel,
  type ObsLogEntry,
  type ObsMetrics,
} from "@hns/core";
import { mirrorMetricsOf, mirrorRowsOf } from "../artifacts/observability.ts";

/** How often the append path runs the retention delete; the cap delete runs only when exceeded. */
export const OBS_PRUNE_EVERY = 256;

/** The values the Durable Object SQL binding accepts and returns. */
type SqlValue = ArrayBuffer | string | number | null;

/** The one SQL call the store makes; the Durable Object runs it synchronously. */
interface ObsSql {
  exec(
    query: string,
    ...bindings: SqlValue[]
  ): {
    toArray(): Record<string, SqlValue>[];
  };
}

/** The slice of Durable Object storage the event table needs. */
export interface ObsStorage {
  readonly sql: ObsSql;
}

/** What to read from the log. */
export interface ObsListQuery {
  /** Maximum rows; clamped to 1..OBS_MAX_QUERY_LIMIT. Defaults to 100. */
  readonly limit?: number | undefined;
  /** Only events at this level. */
  readonly level?: EventLevel | undefined;
  /** Only events at or after this ISO timestamp. */
  readonly since?: string | undefined;
  /** Only events that carry this correlation id. */
  readonly requestId?: string | undefined;
}

/** How to build the store; tests shrink the clock and the bounds. */
export interface ObsStoreOptions {
  /** Epoch milliseconds; defaults to Date.now. */
  readonly now?: (() => number) | undefined;
  /** The retention window in days; defaults to OBS_RETENTION_DAYS. */
  readonly retentionDays?: number | undefined;
  /** The event cap; defaults to OBS_MAX_EVENTS. */
  readonly maxEvents?: number | undefined;
  /** Appends between retention deletes; defaults to OBS_PRUNE_EVERY. */
  readonly pruneEvery?: number | undefined;
}

/**
 * The Durable Object event log.
 *
 * @remarks
 * Events live in the Session Durable Object's SQLite, never in D1 (D049 / D053). append is one
 * insert; the cap delete runs only when the count crosses the bound, and the retention delete
 * runs once every OBS_PRUNE_EVERY appends. Reading a corrupt row throws ValiError: an unknown
 * vocabulary member is not defaulted away.
 */
export interface ObsStore {
  /** Append one allowlisted entry. */
  append(entry: ObsLogEntry): void;
  /** Matching entries, newest first. */
  list(query?: ObsListQuery): ObsLogEntry[];
  /** The 24-hour aggregate plus the log's own retention facts. */
  metrics(): ObsMetrics;
  /** Delete rows older than the retention window; returns how many. */
  prune(): number;
  /** Rows stored now. */
  count(): number;
}

const CountSchema = v.object({ count: v.number() });
const StatusCountSchema = v.object({ status: v.number(), count: v.number() });
const HopCountSchema = v.object({ hop: v.picklist(OBS_HOPS), count: v.number() });
const EventCountSchema = v.object({ event: v.picklist(EVENT_NAMES), count: v.number() });
const DurationSchema = v.object({ ms: v.number() });

const RowSchema = v.object({
  at: v.string(),
  level: v.picklist(EVENT_LEVELS),
  event: v.picklist(EVENT_NAMES),
  hop: v.picklist(OBS_HOPS),
  request_id: v.nullable(v.string()),
  path: v.nullable(v.string()),
  status: v.nullable(v.number()),
  duration_ms: v.nullable(v.number()),
  detail: v.nullable(v.string()),
});

type ObsRow = v.InferOutput<typeof RowSchema>;

const COLUMNS = "at, level, event, hop, request_id, path, status, duration_ms, detail";

/** Parse one stored row into the public entry, keeping unknown detail keys out. */
function toEntry(row: ObsRow): ObsLogEntry {
  return parseObsLog({
    v: 1,
    at: row.at,
    level: row.level,
    event: row.event,
    hop: row.hop,
    requestId: row.request_id,
    path: row.path ?? undefined,
    status: row.status ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    detail: row.detail === null ? undefined : JSON.parse(row.detail),
  });
}

function countOf(sql: ObsSql): number {
  const row = sql.exec("SELECT COUNT(*) AS count FROM obs_events").toArray()[0];
  return v.parse(CountSchema, row ?? { count: 0 }).count;
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(name + " must be a positive integer");
  }
  return value;
}

/**
 * Open the event log over one Durable Object's SQLite.
 *
 * @param storage - The object storage; only sql.exec is used.
 * @param options - The clock and bounds; production keeps the defaults.
 * @returns The store, with the table and index created.
 * @throws {RangeError} When a bound is not a positive integer.
 */
export function createObsStore(storage: ObsStorage, options: ObsStoreOptions = {}): ObsStore {
  const now = options.now ?? Date.now;
  const retentionDays = positive("retentionDays", options.retentionDays ?? OBS_RETENTION_DAYS);
  const maxEvents = positive("maxEvents", options.maxEvents ?? OBS_MAX_EVENTS);
  const pruneEvery = positive("pruneEvery", options.pruneEvery ?? OBS_PRUNE_EVERY);
  const sql = storage.sql;

  sql.exec(
    "CREATE TABLE IF NOT EXISTS obs_events (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "at TEXT NOT NULL, level TEXT NOT NULL, event TEXT NOT NULL, hop TEXT NOT NULL, " +
      "request_id TEXT, path TEXT, status INTEGER, duration_ms INTEGER, detail TEXT)",
  );
  sql.exec("CREATE INDEX IF NOT EXISTS obs_events_at ON obs_events(at)");
  sql.exec("CREATE INDEX IF NOT EXISTS obs_events_request ON obs_events(request_id)");

  const cutoff = (): string => new Date(now() - retentionDays * 86_400_000).toISOString();
  let stored = countOf(sql);
  let sincePrune = 0;

  const deleteOld = (): void => {
    sql.exec("DELETE FROM obs_events WHERE at < ?", cutoff());
    stored = countOf(sql);
    sincePrune = 0;
  };
  // Retention runs at open as well as on the append interval, so a quiet workspace still shrinks.
  deleteOld();

  return {
    append(entry) {
      const clean = parseObsLog(entry);
      sql.exec(
        "INSERT INTO obs_events (at, level, event, hop, request_id, path, status, duration_ms, detail) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        clean.at,
        clean.level,
        clean.event,
        clean.hop,
        clean.requestId,
        clean.path ?? null,
        clean.status ?? null,
        clean.durationMs ?? null,
        clean.detail === undefined ? null : JSON.stringify(clean.detail),
      );
      stored += 1;
      sincePrune += 1;
      if (stored > maxEvents) {
        // One statement keeps the newest maxEvents rows; the excess is the oldest.
        sql.exec(
          "DELETE FROM obs_events WHERE id NOT IN " +
            "(SELECT id FROM obs_events ORDER BY id DESC LIMIT ?)",
          maxEvents,
        );
        stored = maxEvents;
      }
      if (sincePrune >= pruneEvery) deleteOld();
    },
    list(query = {}) {
      const clauses: string[] = [];
      const params: SqlValue[] = [];
      if (query.level !== undefined) {
        clauses.push("level = ?");
        params.push(query.level);
      }
      if (query.since !== undefined) {
        clauses.push("at >= ?");
        params.push(query.since);
      }
      if (query.requestId !== undefined) {
        clauses.push("request_id = ?");
        params.push(query.requestId);
      }
      const where = clauses.length === 0 ? "" : " WHERE " + clauses.join(" AND ");
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), OBS_MAX_QUERY_LIMIT);
      const bindings = [...params, limit];
      return sql
        .exec(
          "SELECT " + COLUMNS + " FROM obs_events" + where + " ORDER BY at DESC, id DESC LIMIT ?",
          ...bindings,
        )
        .toArray()
        .map((row) => toEntry(v.parse(RowSchema, row)));
    },
    metrics() {
      const windowMs = 86_400_000;
      const since = new Date(now() - windowMs).toISOString();
      const durations = sql
        .exec(
          "SELECT duration_ms AS ms FROM obs_events WHERE event IN ('http', 'http.error') AND at >= ? AND duration_ms IS NOT NULL ORDER BY duration_ms",
          since,
        )
        .toArray()
        .map((row) => v.parse(DurationSchema, row).ms);
      const percentile = (p: number): number => {
        if (durations.length === 0) return 0;
        const index = Math.min(durations.length - 1, Math.floor(durations.length * p));
        return durations[index] ?? 0;
      };
      const countWhere = (where: string): number =>
        v.parse(
          CountSchema,
          sql
            .exec("SELECT COUNT(*) AS count FROM obs_events WHERE " + where + " AND at >= ?", since)
            .toArray()[0] ?? { count: 0 },
        ).count;
      return {
        windowMs,
        http: {
          total: countWhere("event IN ('http', 'http.error')"),
          byStatus: sql
            .exec(
              "SELECT status, COUNT(*) AS count FROM obs_events WHERE event IN ('http', 'http.error') AND at >= ? AND status IS NOT NULL GROUP BY status",
              since,
            )
            .toArray()
            .map((row) => v.parse(StatusCountSchema, row)),
          p50ms: percentile(0.5),
          p95ms: percentile(0.95),
        },
        byHop: sql
          .exec(
            "SELECT hop, COUNT(*) AS count FROM obs_events WHERE at >= ? GROUP BY hop ORDER BY count DESC",
            since,
          )
          .toArray()
          .map((row) => v.parse(HopCountSchema, row)),
        errors: countWhere("level = 'error'"),
        toolCalls: countWhere("event = 'tool.call'"),
        toolErrors: countWhere("event = 'tool.result' AND level IN ('warn', 'error')"),
        agentResponses: countWhere("event = 'agent.response'"),
        byEvent: sql
          .exec(
            "SELECT event, COUNT(*) AS count FROM obs_events WHERE at >= ? GROUP BY event ORDER BY count DESC LIMIT 25",
            since,
          )
          .toArray()
          .map((row) => v.parse(EventCountSchema, row)),
        // The mirror is reduced from its own entries (0249): one page of them, read back through
        // the same entry shape every other number is read with, so a token cannot be counted.
        mirror: mirrorMetricsOf(
          mirrorRowsOf(
            sql
              .exec(
                "SELECT " +
                  COLUMNS +
                  " FROM obs_events WHERE event = 'artifacts.mirror' AND at >= ? ORDER BY id DESC",
                since,
              )
              .toArray()
              .map((row) => toEntry(v.parse(RowSchema, row))),
          ),
          windowMs,
        ),
        stored,
        retentionDays,
        maxEvents,
      };
    },
    prune() {
      const before = countOf(sql);
      deleteOld();
      return before - stored;
    },
    count() {
      return countOf(sql);
    },
  };
}
