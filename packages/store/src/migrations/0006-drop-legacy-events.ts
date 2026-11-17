import type { Migration } from "./migration.ts";

const SQL = `
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS usage_log;
DROP INDEX IF EXISTS conversations_project;
DROP INDEX IF EXISTS conversations_activity;
CREATE INDEX conversations_page ON conversations (project_id, updated_at DESC, id DESC);
`;

/**
 * The sixth schema step: D1 drops the first-generation `events` and `usage_log` tables.
 *
 * @remarks
 * Nothing is migrated out of these tables. The records they held already live in the sources
 * that own them: observations are `obs_events` in the Session Durable Object's SQLite (D049 /
 * D053), and per-turn usage is the `cost_turn` ledger with its limits (migration 3). The two
 * tables were the first-generation store's append-only log and daily usage roll-up, and no
 * production code has written or read them since the object took over. Copying their rows into
 * `obs_events` would put a second writer on a log that is bounded by row count per object, and
 * copying them into `cost_turn` would need a turn id and an outcome per row that they never
 * recorded — the copy would either fail a CHECK or invent a measurement the month total counts.
 * This release does not carry data written by an older one, so the tables are dropped outright
 * and the drop is the whole step.
 *
 * `conversations` keeps one index for the list: `(project_id, updated_at DESC, id DESC)` in the
 * same order the keyset page reads. `updated_at` is what the ordering and the cursor use (the
 * writer fills it from `created_at` when a conversation was never touched), so the read can use
 * one index instead of a `COALESCE` expression. `events_at`, `usage_at`, and the two
 * `conversations` indexes go with the tables they served.
 *
 * The statements run as one D1 batch, so a failure leaves the old tables and version in place.
 */
export const migration0006: Migration = { version: 6, sql: SQL };
