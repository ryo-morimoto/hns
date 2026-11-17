import { isoTimestamp, type IsoTimestamp } from "@hns/core";
import {
  CapabilityScopeSchema,
  DENIAL_CODES,
  TOOL_IDS,
  canonicalize,
  sha256Hex,
  type CapabilityScope,
  type DenialCode,
  type ToolId,
} from "@hns/core/capability";
import * as v from "valibot";

/**
 * The issuance audit: every grant attempt the Session object made, in one hash-chained table
 * (0224, `docs/capability.md` §5, §8).
 *
 * @remarks
 * `policy_audit` records **calls** and needs a `callId`; a grant is issued before any call exists,
 * and many grants never serve one. A grant is a capability the control plane handed out, which is a
 * fact an auditor has to read on its own: who asked, for which tool and machine, under which policy
 * revision, and whether it was issued or refused. That is this table. It is **append-only** and
 * chained with `hash = sha256Hex(JCS(row without hash))`, like `policy_audit`, so a deleted, edited,
 * or reordered issuance row is detectable; the head is read and the row written in one transaction,
 * so a concurrent issuance cannot fork it.
 *
 * **What it never holds**: a signature, a seed, a public key, a token, an argument, or an output. A
 * row names the `grantId` (opaque, and useless without the signature) and the decision. `scope_json`
 * is the scope as the contract spells it, which is what a human reads to see what was handed out.
 */

/** What was decided about one request. */
export const GRANT_ISSUE_OUTCOMES = ["issued", "refused"] as const;

/** What was decided about one request. */
export type GrantIssueOutcome = (typeof GRANT_ISSUE_OUTCOMES)[number];

/** One row of the issuance audit, as this module normalizes it. */
export interface GrantAuditEntry {
  readonly v: 1;
  readonly eventId: string;
  readonly at: IsoTimestamp;
  readonly event: "grant.issued" | "grant.refused";
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly grantId: string | null;
  readonly toolId: ToolId | null;
  readonly toolVersion: string | null;
  readonly manifestHash: string | null;
  readonly machineId: string | null;
  /** The scope as canonical JSON; `null` when the refusal never had one to name. */
  readonly scopeJson: string | null;
  readonly epoch: number | null;
  readonly maxCalls: number | null;
  readonly maxBytes: number | null;
  readonly expiresAt: IsoTimestamp | null;
  readonly requestedByKind: "human" | "agent" | null;
  readonly requestedBy: string | null;
  readonly runId: string | null;
  readonly outcome: GrantIssueOutcome;
  readonly code: DenialCode | null;
  readonly prevHash: string | null;
}

/** A stored row: the entry plus its place in the chain. */
export interface GrantAuditRow extends GrantAuditEntry {
  readonly seq: number;
  readonly hash: string;
}

/**
 * A row's members, built in one fixed order (this function is the format).
 *
 * @param entry - The entry, whose members are copied one by one so no JavaScript property outside
 * the type can reach the hashed bytes.
 */
function entryOf(entry: GrantAuditEntry): GrantAuditEntry {
  return {
    v: entry.v,
    eventId: entry.eventId,
    at: entry.at,
    event: entry.event,
    workspaceId: entry.workspaceId,
    sessionId: entry.sessionId,
    grantId: entry.grantId,
    toolId: entry.toolId,
    toolVersion: entry.toolVersion,
    manifestHash: entry.manifestHash,
    machineId: entry.machineId,
    scopeJson: entry.scopeJson,
    epoch: entry.epoch,
    maxCalls: entry.maxCalls,
    maxBytes: entry.maxBytes,
    expiresAt: entry.expiresAt,
    requestedByKind: entry.requestedByKind,
    requestedBy: entry.requestedBy,
    runId: entry.runId,
    outcome: entry.outcome,
    code: entry.code,
    prevHash: entry.prevHash,
  };
}

/**
 * `sha256Hex(JCS(entry))`: one row's hash.
 *
 * @param entry - The row's members, `prevHash` included.
 * @throws UnsupportedFormatError when a member has no canonical form, which leaves the row unwritten
 * and the grant unissued (fail closed).
 */
export async function grantAuditHash(entry: GrantAuditEntry): Promise<string> {
  return await sha256Hex(canonicalize(entryOf(entry)));
}

/** What the table offers. */
export interface GrantAudit {
  /**
   * Append one row; idempotent on `eventId`.
   *
   * @param entry - The row's members; `prevHash` is ignored and set from the chain.
   * @returns The stored row: the new one, or the one an earlier append with this id stored.
   * @throws UnsupportedFormatError when a member has no canonical form (the grant is withheld).
   */
  append(entry: Omit<GrantAuditEntry, "prevHash">): Promise<GrantAuditRow>;
  /**
   * Append one row inside a transaction the caller already opened.
   *
   * @param entry - The row's members; `prevHash` is ignored and set from the chain.
   * @returns The stored row.
   *
   * @remarks
   * The head and the insert must be in **one** transaction (INV-10), and that transaction may belong
   * to a caller: the grant recorder writes the ledger row and this row together and opens the
   * transaction itself. The Durable Object storage does not nest transactions, so "opens one" and
   * "joins the caller's" are two calls rather than a flag: a transaction silently not taken would
   * fork the chain.
   */
  appendWithin(entry: Omit<GrantAuditEntry, "prevHash">): Promise<GrantAuditRow>;
  /**
   * Rows in chain order, oldest first.
   *
   * @remarks
   * There is no product surface that reads this yet: the operations list is 0161's, the same
   * treatment 0148 gave `machine_events`. This is what the verifier and a test read.
   */
  entries(): Promise<readonly GrantAuditRow[]>;
  /**
   * Recompute every row's hash and its link to the row before it.
   *
   * @returns `ok` with the row count, or the first break: `tampered` (a row's hash is not its
   * members'), `sequence` (a `prevHash` or `seq` that does not follow), or `corrupt` (a column that is
   * not what the table promises).
   */
  verify(): Promise<GrantAuditVerdict>;
}

/** What verifying found. */
export type GrantAuditVerdict =
  | { readonly ok: true; readonly rows: number }
  | {
      readonly ok: false;
      readonly kind: "tampered" | "sequence" | "corrupt";
      readonly seq: number;
      readonly reason: string;
    };

/** The values the Durable Object SQL binding accepts and returns. */
type SqlValue = ArrayBuffer | string | number | null;

/** One statement's result: the Durable Object runs the SQL synchronously. */
interface SqlStatement {
  toArray(): Record<string, SqlValue>[];
}

/** One SQL call. */
interface GrantAuditSql {
  exec(query: string, ...bindings: SqlValue[]): SqlStatement;
}

/** The part of the object storage the table needs. */
export interface GrantAuditStorage {
  readonly sql: GrantAuditSql;
  transaction<T>(run: () => Promise<T>): Promise<T>;
}

const COLUMNS =
  "seq, event_id, at, event, workspace_id, session_id, grant_id, tool_id, tool_version, " +
  "manifest_hash, machine_id, scope_json, epoch, max_calls, max_bytes, expires_at, " +
  "requested_by_kind, requested_by, run_id, outcome, code, prev_hash, hash";

const SELECT = "SELECT " + COLUMNS + " FROM grant_audit";

const RowSchema = v.object({
  seq: v.number(),
  event_id: v.string(),
  at: v.string(),
  event: v.picklist(["grant.issued", "grant.refused"]),
  workspace_id: v.string(),
  session_id: v.string(),
  grant_id: v.nullable(v.string()),
  tool_id: v.nullable(v.picklist(TOOL_IDS)),
  tool_version: v.nullable(v.string()),
  manifest_hash: v.nullable(v.string()),
  machine_id: v.nullable(v.string()),
  scope_json: v.nullable(v.string()),
  epoch: v.nullable(v.number()),
  max_calls: v.nullable(v.number()),
  max_bytes: v.nullable(v.number()),
  expires_at: v.nullable(v.string()),
  requested_by_kind: v.nullable(v.picklist(["human", "agent"])),
  requested_by: v.nullable(v.string()),
  run_id: v.nullable(v.string()),
  outcome: v.picklist(GRANT_ISSUE_OUTCOMES),
  code: v.nullable(v.picklist(DENIAL_CODES)),
  prev_hash: v.nullable(v.string()),
  hash: v.string(),
});

/**
 * One row as this module reads it.
 *
 * @throws ValiError when a column is not what the table promises, or when `scope_json` is not the
 * contract's scope: a stored scope that cannot be parsed is corruption, never a string to act on.
 */
function toRow(raw: Record<string, SqlValue>): GrantAuditRow {
  const row = v.parse(RowSchema, raw);
  scopeOf(row.scope_json);
  return {
    seq: row.seq,
    v: 1,
    eventId: row.event_id,
    at: isoTimestamp(row.at),
    event: row.event,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    grantId: row.grant_id,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    manifestHash: row.manifest_hash,
    machineId: row.machine_id,
    scopeJson: row.scope_json,
    epoch: row.epoch,
    maxCalls: row.max_calls,
    maxBytes: row.max_bytes,
    expiresAt: row.expires_at === null ? null : isoTimestamp(row.expires_at),
    requestedByKind: row.requested_by_kind,
    requestedBy: row.requested_by,
    runId: row.run_id,
    outcome: row.outcome,
    code: row.code,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

/**
 * A stored scope, parsed as the contract's closed union.
 *
 * @param json - The stored canonical JSON, or `null`.
 * @returns The scope, or `null`.
 * @throws ValiError when the JSON is not a `CapabilityScope`.
 */
export function scopeOf(json: string | null): CapabilityScope | null {
  if (json === null) return null;
  const raw: unknown = JSON.parse(json);
  return v.parse(CapabilityScopeSchema, raw);
}

/**
 * Open the issuance audit over one Durable Object's SQLite.
 *
 * @param storage - The object's storage; the SQL and the transaction are all it uses.
 * @returns The table, created if needed, and its operations.
 */
export function createGrantAudit(storage: GrantAuditStorage): GrantAudit {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS grant_audit (" +
      "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "event_id TEXT NOT NULL UNIQUE, " +
      "at TEXT NOT NULL, " +
      "event TEXT NOT NULL CHECK (event IN ('grant.issued', 'grant.refused')), " +
      "workspace_id TEXT NOT NULL, " +
      "session_id TEXT NOT NULL, " +
      "grant_id TEXT, " +
      "tool_id TEXT CHECK (tool_id IS NULL OR tool_id IN ('read_file', 'write_file', 'bash')), " +
      "tool_version TEXT, " +
      "manifest_hash TEXT, " +
      "machine_id TEXT, " +
      "scope_json TEXT, " +
      "epoch INTEGER, " +
      "max_calls INTEGER, " +
      "max_bytes INTEGER, " +
      "expires_at TEXT, " +
      "requested_by_kind TEXT CHECK (requested_by_kind IS NULL OR requested_by_kind IN ('human', 'agent')), " +
      "requested_by TEXT, " +
      "run_id TEXT, " +
      "outcome TEXT NOT NULL CHECK (outcome IN ('issued', 'refused')), " +
      "code TEXT, " +
      "prev_hash TEXT, " +
      "hash TEXT NOT NULL)",
  );
  const appendRow = async (entry: Omit<GrantAuditEntry, "prevHash">): Promise<GrantAuditRow> => {
    {
      {
        const existing = storage.sql
          .exec(SELECT + " WHERE event_id = ?", entry.eventId)
          .toArray()[0];
        if (existing !== undefined) return toRow(existing);
        const head = storage.sql.exec(SELECT + " ORDER BY seq DESC LIMIT 1").toArray()[0];
        const previous = head === undefined ? undefined : toRow(head);
        const next = entryOf({ ...entry, prevHash: previous?.hash ?? null });
        const hash = await grantAuditHash(next);
        const seq = (previous?.seq ?? 0) + 1;
        storage.sql.exec(
          "INSERT INTO grant_audit (" +
            COLUMNS +
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          seq,
          next.eventId,
          next.at,
          next.event,
          next.workspaceId,
          next.sessionId,
          next.grantId,
          next.toolId,
          next.toolVersion,
          next.manifestHash,
          next.machineId,
          next.scopeJson,
          next.epoch,
          next.maxCalls,
          next.maxBytes,
          next.expiresAt,
          next.requestedByKind,
          next.requestedBy,
          next.runId,
          next.outcome,
          next.code,
          next.prevHash,
          hash,
        );
        return { ...next, seq, hash };
      }
    }
  };
  return {
    append: async (entry) => await storage.transaction(() => appendRow(entry)),
    appendWithin: appendRow,
    async entries() {
      return storage.sql
        .exec(SELECT + " ORDER BY seq ASC")
        .toArray()
        .map(toRow);
    },
    async verify() {
      let rows: GrantAuditRow[];
      try {
        rows = storage.sql
          .exec(SELECT + " ORDER BY seq ASC")
          .toArray()
          .map(toRow);
      } catch (error) {
        return {
          ok: false,
          kind: "corrupt",
          seq: 0,
          reason: error instanceof Error ? error.name : "a row is not one",
        };
      }
      let previous: GrantAuditRow | undefined;
      for (const row of rows) {
        if (previous !== undefined && row.seq !== previous.seq + 1) {
          return {
            ok: false,
            kind: "sequence",
            seq: row.seq,
            reason: "seq " + String(row.seq) + " follows " + String(previous.seq),
          };
        }
        const { seq, hash, ...members } = row;
        if ((await grantAuditHash(members)) !== hash) {
          return {
            ok: false,
            kind: "tampered",
            seq,
            reason: "the row's members do not hash to its hash",
          };
        }
        if (row.prevHash !== (previous?.hash ?? null)) {
          return {
            ok: false,
            kind: "sequence",
            seq,
            reason: "prev_hash is not the hash of the row before it",
          };
        }
        previous = row;
      }
      return { ok: true, rows: rows.length };
    },
  };
}
