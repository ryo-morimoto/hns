import type { Migration } from "./migration.ts";

const SQL = `
CREATE TABLE IF NOT EXISTS cost_limits (
  id TEXT PRIMARY KEY CHECK (id = 'cost'),
  do_rows_limit INTEGER NOT NULL CHECK (do_rows_limit > 0),
  do_requests_limit INTEGER NOT NULL CHECK (do_requests_limit > 0),
  r2_objects_limit INTEGER NOT NULL CHECK (r2_objects_limit > 0),
  warn_ratio REAL NOT NULL,
  critical_ratio REAL NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (warn_ratio > 0 AND warn_ratio < critical_ratio AND critical_ratio <= 1)
);
INSERT OR IGNORE INTO cost_limits (id, do_rows_limit, do_requests_limit, r2_objects_limit, warn_ratio, critical_ratio, updated_at) VALUES ('cost', 50000000, 1000000, 1000000, 0.5, 0.8, '1970-01-01T00:00:00Z');
CREATE TABLE IF NOT EXISTS cost_turn (
  id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed')),
  do_rows INTEGER NOT NULL CHECK (do_rows >= 0),
  do_requests INTEGER NOT NULL CHECK (do_requests >= 0),
  r2_objects INTEGER NOT NULL CHECK (r2_objects >= 0),
  PRIMARY KEY (conversation_id, id)
);
CREATE INDEX IF NOT EXISTS cost_turn_at ON cost_turn (at);
`;

/**
 * The third schema step: the monthly cost limits and the per-turn cost ledger.
 *
 * @remarks
 * `cost_limits` holds one row (`id = 'cost'`) with the monthly DO row, DO request, and R2
 * object limits plus the ratios at which the warn and critical alerts fire. The values are
 * policy, not schema: an operator changes them with `UPDATE cost_limits SET ...`, like the
 * provider gateway's budget row. The seed matches the free-tier figures in
 * docs/durability.md §7 (50,000,000 rows and 1,000,000 Class A writes a month).
 * `cost_turn` holds one row per turn; the id is the turn's request id, so a retried turn is
 * the same row and cannot be counted twice. The month total is a SUM over `at`, never a
 * counter row, so no second copy of the same number exists.
 */
export const migration0003: Migration = { version: 3, sql: SQL };
