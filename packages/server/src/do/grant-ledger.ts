import { isoTimestamp, type IsoTimestamp } from "@hns/core";
import {
  CapabilityScopeSchema,
  TOOL_IDS,
  canonicalize,
  type CapabilityScope,
  type ToolId,
} from "@hns/core/capability";
import * as v from "valibot";

/**
 * Who issued a grant and how it ended (0224, `docs/capability.md` §5, §9).
 *
 * @remarks
 * This is the **grant ledger**: the Session object's record of every grant it issued, who asked
 * for it, and whether it was revoked. It is not the audit of a call (`policy_audit`): a grant is
 * issued before any call exists, so it has no `callId` and no `callHash`, and it is recorded even
 * when the call it was made for never happens.
 *
 * **Issuance is itself recorded.** A grant is a capability the control plane handed out; an
 * auditor has to be able to answer "who asked for what, when, under which policy revision" without
 * replaying conversation transcripts. So a ledger row is written **before** the signed grant is
 * returned, and a row that cannot be written means no grant (`GrantLedgerUnavailableError`): a
 * capability with no record is exactly the fail-open this table exists to prevent.
 *
 * **No secret and no signature is stored.** The row keeps the grant's identity and bounds (id,
 * tool, manifest, machine, scope, times, epoch, counters) and never the signed grant, the seed, or
 * anything derived from it. The signature lives only in the answer to the requester.
 *
 * **The table belongs to the Session's SQLite.** The interface is what 0226 opens over the object's
 * storage (`createSqliteGrantLedger`); the issuer ({@link ./session-grants.ts}) takes the interface,
 * so a unit test records into memory and the integration test records into real `node:sqlite`.
 */

/** Who asked for a grant. */
export interface GrantRequester {
  /**
   * The kind of principal that asked.
   *
   * @remarks
   * `human` is a signed-in person's session; `agent` is a run of the agent itself (a subject in the
   * agent namespace). An agent may ask for a grant for the run it is executing — never for a run it
   * has finished, which is why `runId` exists.
   */
  readonly kind: "human" | "agent";
  /** The principal's stable id (the verified session subject, or the agent's id). */
  readonly id: string;
  /**
   * The run the grant is bound to, when the requester is a run.
   *
   * @remarks
   * A grant bound to a run is **revoked when that run ends** (the conversation's abort, or the
   * Session closing), so an agent cannot keep using a capability after the work it was granted for
   * is over. A grant with no `runId` is a person's: it ends with its TTL.
   */
  readonly runId?: string | undefined;
}

/** One issued grant, as the ledger keeps it. */
export interface GrantRecord {
  readonly grantId: string;
  /** The single-use nonce; two grants never share it, which is what makes a replay detectable. */
  readonly nonce: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly machineId: string;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly manifestHash: string;
  readonly scope: CapabilityScope;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  /** The policy revision the grant was issued under; the payload's `epoch`. */
  readonly epoch: number;
  readonly maxCalls: number;
  readonly maxBytes: number;
  readonly keyId: string;
  readonly requestedBy: GrantRequester;
  /** When it was revoked; absent while it stands. */
  readonly revokedAt?: IsoTimestamp | undefined;
}

/** Why a grant could not be recorded: the capability is withheld. */
export class GrantLedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantLedgerUnavailableError";
  }
}

/**
 * The grants one Session has issued, and their revocation.
 *
 * @remarks
 * A method that can miss returns `undefined` rather than throwing; a write that cannot happen throws
 * {@link GrantLedgerUnavailableError}, because a grant that was handed out without a record must not
 * look like one that was recorded.
 */
export interface GrantLedger {
  /**
   * Record one issued grant.
   *
   * @param record - The grant as it was signed; its `revokedAt` is not the caller's to set.
   * @returns The stored record.
   * @throws GrantLedgerUnavailableError when the row cannot be written.
   */
  record(record: GrantRecord): Promise<GrantRecord>;
  /**
   * Revoke a grant.
   *
   * @param grantId - The grant to revoke.
   * @param at - The time the revocation was decided.
   * @returns `true` when this call revoked it, `false` when it was already revoked or unknown.
   * @remarks
   * Idempotent: revoking twice is not an error, and the first time is the one an audit reads. A
   * revoked grant stays in the table (deleting it would erase the record that it existed).
   */
  revoke(grantId: string, at: IsoTimestamp): Promise<boolean>;
  /** One grant, or `undefined` when this object issued none by that id. */
  get(grantId: string): Promise<GrantRecord | undefined>;
  /**
   * The newest grant the run was bound to, live or revoked.
   *
   * @param runId - The run (a conversation id).
   * @returns The newest record, or `undefined` when the run was never granted anything.
   *
   * @remarks
   * `boundTo` answers only the live ones; a run whose grant was revoked must still be visible, so
   * the granted path can refuse it as `grant_revoked` instead of issuing a replacement.
   */
  lastFor(runId: string): Promise<GrantRecord | undefined>;
  /**
   * The grants bound to a run that are still live.
   *
   * @remarks
   * Used when the run ends: those are the grants that have to be revoked. Revoked ones are left out,
   * so a second call after an abort revokes nothing.
   */
  boundTo(runId: string): Promise<readonly GrantRecord[]>;
}

/** The values the Durable Object SQL binding accepts and returns. */
type SqlValue = ArrayBuffer | string | number | null;

/** One statement's result: the Durable Object runs the SQL synchronously. */
interface SqlStatement {
  toArray(): Record<string, SqlValue>[];
}

/** The one SQL call the ledger makes. */
interface GrantSql {
  exec(query: string, ...bindings: SqlValue[]): SqlStatement;
}

/** The part of the object storage the ledger needs. */
export interface GrantLedgerStorage {
  readonly sql: GrantSql;
}

/** One stored row, as the database returns it. */
const RowSchema = v.object({
  grant_id: v.string(),
  nonce: v.string(),
  workspace_id: v.string(),
  session_id: v.string(),
  machine_id: v.string(),
  tool_id: v.picklist(TOOL_IDS),
  tool_version: v.string(),
  manifest_hash: v.string(),
  scope_json: v.string(),
  issued_at: v.string(),
  expires_at: v.string(),
  epoch: v.number(),
  max_calls: v.number(),
  max_bytes: v.number(),
  key_id: v.string(),
  requested_by_kind: v.picklist(["human", "agent"]),
  requested_by: v.string(),
  run_id: v.nullable(v.string()),
  revoked_at: v.nullable(v.string()),
});

const COLUMNS =
  "grant_id, nonce, workspace_id, session_id, machine_id, tool_id, tool_version, manifest_hash, " +
  "scope_json, issued_at, expires_at, epoch, max_calls, max_bytes, key_id, requested_by_kind, " +
  "requested_by, run_id, revoked_at";

const SELECT = "SELECT " + COLUMNS + " FROM session_grants";

/**
 * Turn one stored row into a record.
 *
 * @throws ValiError when a column is not what the table's schema says, or when `scope_json` is not a
 * `CapabilityScope`: a scope that cannot be parsed is corruption, never a default.
 *
 * @remarks
 * The scope is stored as canonical JSON so it round-trips exactly what was signed; parsing it back
 * through {@link CapabilityScopeSchema} is what makes the stored value the contract's closed union
 * rather than a string a reader has to trust.
 */
function toRecord(raw: Record<string, SqlValue>): GrantRecord {
  const row = v.parse(RowSchema, raw);
  const record: GrantRecord = {
    grantId: row.grant_id,
    nonce: row.nonce,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    machineId: row.machine_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    manifestHash: row.manifest_hash,
    scope: v.parse(CapabilityScopeSchema, JSON.parse(row.scope_json)),
    issuedAt: isoTimestamp(row.issued_at),
    expiresAt: isoTimestamp(row.expires_at),
    epoch: row.epoch,
    maxCalls: row.max_calls,
    maxBytes: row.max_bytes,
    keyId: row.key_id,
    requestedBy:
      row.run_id === null
        ? { kind: row.requested_by_kind, id: row.requested_by }
        : { kind: row.requested_by_kind, id: row.requested_by, runId: row.run_id },
  };
  return row.revoked_at === null ? record : { ...record, revokedAt: isoTimestamp(row.revoked_at) };
}

/**
 * Open the ledger over one Durable Object's SQLite.
 *
 * @param storage - The object's storage; the SQL is all it uses.
 * @returns The table, created if needed, and its operations.
 *
 * @throws UnsupportedFormatError when a scope has no canonical form, which the issuer refuses
 * before it ever reaches here.
 *
 * @remarks
 * The table is the one `docs/capability.md` §9 names (`session_grants`), with `scope_json` as the
 * signed scope and `revoked_at` as the one column a later write sets. `expires_at` and `run_id` are
 * indexed because they are the two questions a reader asks ("is this grant still live", "what did
 * this run hold"). Nothing here stores a signature, a seed, or a public key.
 *
 * There is **no `list`**: the reader a person uses is an operations surface, which is 0161's
 * (the same treatment 0148 gave `machine_events`: the writer lands with the feature, the reader with
 * the surface that shows it). {@link GrantLedger.get} and {@link GrantLedger.boundTo} are what the
 * issuer and the run-end revocation need.
 */
export function createSqliteGrantLedger(storage: GrantLedgerStorage): GrantLedger {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS session_grants (" +
      "grant_id TEXT PRIMARY KEY, " +
      "nonce TEXT NOT NULL UNIQUE, " +
      "workspace_id TEXT NOT NULL, " +
      "session_id TEXT NOT NULL, " +
      "machine_id TEXT NOT NULL, " +
      "tool_id TEXT NOT NULL CHECK (tool_id IN ('read_file', 'write_file', 'bash')), " +
      "tool_version TEXT NOT NULL, " +
      "manifest_hash TEXT NOT NULL, " +
      "scope_json TEXT NOT NULL, " +
      "issued_at TEXT NOT NULL, " +
      "expires_at TEXT NOT NULL, " +
      "epoch INTEGER NOT NULL, " +
      "max_calls INTEGER NOT NULL, " +
      "max_bytes INTEGER NOT NULL, " +
      "key_id TEXT NOT NULL, " +
      "requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('human', 'agent')), " +
      "requested_by TEXT NOT NULL, " +
      "run_id TEXT, " +
      "revoked_at TEXT)",
  );
  storage.sql.exec("CREATE INDEX IF NOT EXISTS session_grants_run ON session_grants (run_id)");
  storage.sql.exec(
    "CREATE INDEX IF NOT EXISTS session_grants_expiry ON session_grants (expires_at)",
  );
  return {
    async record(record) {
      // The scope is written as its canonical JSON so the stored bytes are the signed ones (JCS
      // sorts the keys of a read/write scope's roots the same way on the way back in).
      const scopeJson = canonicalize(record.scope);
      storage.sql.exec(
        "INSERT INTO session_grants (" +
          COLUMNS +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        record.grantId,
        record.nonce,
        record.workspaceId,
        record.sessionId,
        record.machineId,
        record.toolId,
        record.toolVersion,
        record.manifestHash,
        scopeJson,
        record.issuedAt,
        record.expiresAt,
        record.epoch,
        record.maxCalls,
        record.maxBytes,
        record.keyId,
        record.requestedBy.kind,
        record.requestedBy.id,
        record.requestedBy.runId ?? null,
      );
      const stored = storage.sql.exec(SELECT + " WHERE grant_id = ?", record.grantId).toArray()[0];
      if (stored === undefined) {
        throw new GrantLedgerUnavailableError("the grant was not written");
      }
      return toRecord(stored);
    },
    async revoke(grantId, at) {
      // One read decides, then one conditional write: the row is revoked only while it is not, and
      // the answer is the row's state **before** the update, so the first call reports the revocation
      // and a second one reports nothing was revoked (the first call keeps the timestamp).
      const before = storage.sql.exec(SELECT + " WHERE grant_id = ?", grantId).toArray()[0];
      if (before === undefined || toRecord(before).revokedAt !== undefined) return false;
      storage.sql.exec(
        "UPDATE session_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL",
        at,
        grantId,
      );
      return true;
    },
    async get(grantId) {
      const row = storage.sql.exec(SELECT + " WHERE grant_id = ?", grantId).toArray()[0];
      return row === undefined ? undefined : toRecord(row);
    },
    async lastFor(runId) {
      const row = storage.sql
        .exec(SELECT + " WHERE run_id = ? ORDER BY issued_at DESC, grant_id DESC LIMIT 1", runId)
        .toArray()[0];
      return row === undefined ? undefined : toRecord(row);
    },
    async boundTo(runId) {
      return storage.sql
        .exec(SELECT + " WHERE run_id = ? AND revoked_at IS NULL", runId)
        .toArray()
        .map(toRecord);
    },
  };
}
