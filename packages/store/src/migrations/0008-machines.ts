import type { Migration } from "./migration.ts";

const SQL = `
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  hostname TEXT NOT NULL,
  public_key BLOB NOT NULL,
  key_algorithm TEXT NOT NULL CHECK (key_algorithm = 'ed25519'),
  agent_version TEXT NOT NULL,
  last_seen INTEGER,
  status TEXT NOT NULL CHECK (status IN ('online','offline','revoked')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS machine_events (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('enrolled','reimaged','revoked')),
  actor TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * The eighth schema step: the machine registry (0148, D087).
 *
 * @remarks
 * Additive only (`docs/invariants.md` INV-12): two new tables, and no existing table changes.
 *
 * `machines` is the registry D1 keeps instead of a Durable Object (D049). `name` is unique so one
 * machine is one row; `public_key` is a 32-byte BLOB, the raw Ed25519 half the Workspace object
 * reads to verify a machine-signed pack (0245). `key_algorithm` is a CHECK because the key is an
 * Ed25519 key or it is nothing. `status` is a closed CHECK so a hand-edited row cannot invent a
 * state; `revoked` is terminal in the repository, not in the CHECK.
 *
 * **`created_by` is the operator who enrolled the machine**, and it is what makes a reimage
 * possible for them and nobody else: replacing the key of an existing name hands over every
 * workspace that bound that machine, so the right to do it is the right to the original
 * enrollment. The registry refuses a reimage whose actor differs (B1).
 *
 * `last_seen` is nullable (never probed) and holds **epoch milliseconds**, so the 30-second
 * throttle compares integers rather than parsing a timestamp on every write. Writes are
 * throttled (D087): the row moves at most once a minute per machine, and a probe that changes
 * nothing writes nothing.
 *
 * `machine_events` records the changes a person would want to see. `actor` is the **same
 * operator vocabulary as `created_by`**: the session subject that performed the change. `detail`
 * holds the JSON of what changed (for a reimage, the fingerprint of the key that was replaced).
 * Nothing reads this table yet: it is written now so the operator-facing history exists when a
 * reader arrives (0161 / an audit UI); that reader is the follow-up, not this migration.
 *
 * There is no index: a list is a D1 read of a handful of rows (D049), and an index would be a
 * second thing to keep correct.
 */
export const migration0008: Migration = { version: 8, sql: SQL };
