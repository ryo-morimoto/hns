import type { Migration } from "./migration.ts";

const SQL = `
CREATE TABLE IF NOT EXISTS provider_gateway (
  id TEXT PRIMARY KEY CHECK (id = 'gateway'),
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  day_key TEXT NOT NULL,
  month_key TEXT NOT NULL,
  day_spent REAL NOT NULL DEFAULT 0 CHECK (day_spent >= 0),
  month_spent REAL NOT NULL DEFAULT 0 CHECK (month_spent >= 0),
  day_limit REAL NOT NULL CHECK (day_limit > 0),
  month_limit REAL NOT NULL CHECK (month_limit > 0),
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO provider_gateway (id, day_key, month_key, day_spent, month_spent, day_limit, month_limit, updated_at) VALUES ('gateway', '1970-01-01', '1970-01', 0, 0, 5, 50, '1970-01-01T00:00:00Z');
`;

/**
 * The second schema step: the provider gateway's single budget row.
 *
 * @remarks
 * One row (`id = 'gateway'`) holds the daily and monthly spend and limits, the period keys
 * the counters belong to, and the emergency stop flag. The gateway spends it with one
 * `UPDATE ... WHERE spent + price <= limit` so concurrent calls cannot pass the limit.
 * The first period key is the epoch, so the first call after a deploy resets the counters
 * to its own charge instead of inheriting a stale day.
 * Changing a limit is an operator statement (`UPDATE provider_gateway SET day_limit = ...`),
 * not a new migration: the limits are policy, the schema is not.
 */
export const migration0002: Migration = { version: 2, sql: SQL };
