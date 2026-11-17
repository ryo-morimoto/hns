import type { Migration } from "./migration.ts";

const SQL = `
CREATE TABLE IF NOT EXISTS policy_revisions (
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  hash TEXT NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, revision)
);
CREATE TABLE IF NOT EXISTS policy_active (
  workspace_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  base_hash TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  review_token TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS policy_proposals_pending
  ON policy_proposals (workspace_id, status, created_at);
`;

/**
 * The seventh schema step: a workspace's policy as immutable revisions and one active pointer.
 *
 * @remarks
 * Additive only (`docs/invariants.md` INV-12): three new tables and one index, and no existing
 * table changes. The shapes are `docs/capability.md` §9.
 *
 * A revision is written once and never updated; the active revision is the single `policy_active`
 * row per workspace, which the server changes with `UPDATE ... WHERE revision = ?` so a decision
 * made against a moved base changes nothing. A disabled tool's scope is stored as given: the
 * `capabilityAtoms` contract reads a disabled tool as allowing nothing, whatever its scope names.
 *
 * `document_json` and `candidate_json` hold the contract's `PolicyDocument` as JSON. The store
 * validates them on the way in (`PolicyDocumentSchema`) and on the way out, so a row written by an
 * older build that no longer parses fails the read instead of flowing on as a wrong type.
 * `status` is a closed CHECK so a hand-edited row cannot invent a proposal state.
 */
export const migration0007: Migration = { version: 7, sql: SQL };
