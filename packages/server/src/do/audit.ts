import { isoTimestamp, type IsoTimestamp } from "@hns/core";
import {
  AuditEventSchema,
  DenialCodeSchema,
  TOOL_IDS,
  canonicalize,
  sha256Hex,
  type AuditEvent,
  type DenialCode,
  type PolicyDecision,
  type ToolId,
} from "@hns/core/capability";
import * as v from "valibot";

/**
 * The Session's policy audit: an append-only hash chain in the object's own SQLite.
 *
 * @remarks
 * The writer is the Session Durable Object and nowhere else; D1 is not used (`docs/capability.md`
 * §8, §9, D049). Every tool call appends one `tool.call` before it runs and one `tool.result`
 * after it settles, and each row carries the hash of the row before it, so a deleted, edited, or
 * reordered row is detectable by re-reading the whole table (O(n), which is fine at this
 * size).
 *
 * **The hash.** `hash = sha256Hex(JCS(event with the hash key removed))`, as §8 says. The value
 * hashed is the row **as this module normalizes it** — not the raw SQL row — so the input is one
 * fixed member list ({@link hashedEvent}), one per column that names what was decided, in the
 * contract's spelling (`camelCase`, `eventId`), with `null` for a member the row does not
 * have. Two consequences an editor must keep:
 *
 * - **Adding a column does not change an old row's hash** only when the new column is left out of
 *   {@link hashedEvent}. Adding a member to that list changes every row's hash, so it is a
 *   format change: either do not add it, or add `hash_version` and verify each version under the
 *   rule it was written with. There is no `hash_version` yet; Phase 0 has one rule.
 * - `undefined` has no canonical form, so a member the row does not have is written as `null`
 *   rather than dropped: `{callHash: undefined}` would throw, and dropping the key would make the
 *   member set depend on the row.
 *
 * **The chain.** `prevHash` is the previous row's `hash` and `null` for the first row. The
 * head is read and the new row inserted in **one transaction**, so two appends cannot both chain
 * from the same predecessor (INV-10). The Durable Object runs one request at a time, which serializes
 * the transactions; the transaction makes a reader never see a row whose predecessor is absent.
 */

/** The members a row's hash covers: the contract's event, with `hash` removed. */
export interface HashedEvent {
  readonly v: 1;
  readonly eventId: string;
  /** The contract's timestamp; JCS writes it as its string. */
  readonly at: IsoTimestamp;
  readonly event: AuditEventKind;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly callHash: string | null;
  readonly argsHash: string | null;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly manifestHash: string;
  readonly decision: PolicyDecision | null;
  readonly durationMs: number | null;
  readonly grantId: string | null;
  readonly prevHash: string | null;
}

/** The two steps of one call. */
type AuditEventKind = AuditEvent["event"];

/**
 * The hashed member list, in the order the row is built.
 *
 * @remarks
 * **This is the format.** {@link hashedEvent} and {@link hashOf} both read it, so they cannot drift
 * from each other, and a column that is not named here does not reach the hash.
 */
type MemberName =
  | "v"
  | "eventId"
  | "at"
  | "event"
  | "workspaceId"
  | "sessionId"
  | "callId"
  | "callHash"
  | "argsHash"
  | "toolId"
  | "toolVersion"
  | "manifestHash"
  | "decision"
  | "durationMs"
  | "grantId"
  | "prevHash";

const HASHED_MEMBERS = [
  "v",
  "eventId",
  "at",
  "event",
  "workspaceId",
  "sessionId",
  "callId",
  "callHash",
  "argsHash",
  "toolId",
  "toolVersion",
  "manifestHash",
  "decision",
  "durationMs",
  "grantId",
  "prevHash",
] as const satisfies readonly MemberName[];

/**
 * A compile-time proof that {@link HASHED_MEMBERS} names every member and only the members.
 *
 * @remarks
 * Adding a member to {@link HashedEvent} without adding it to the list (or the reverse) is a type error
 * at this declaration. The hashed object itself is built member by member in {@link entryOf}, whose
 * return type does the same job for the bytes.
 */
type MembersCovered = {
  readonly [K in keyof HashedEvent]: K extends (typeof HASHED_MEMBERS)[number] ? true : false;
};

/**
 * Every member of {@link HashedEvent} is in the list, checked at compile time.
 *
 * @remarks
 * A member missing from the list maps to `false`, which is not assignable to `true`, so the
 * annotation below fails to compile; a member of the list that is not one of the row's is refused by
 * `MemberName`. This is a type-level assertion on purpose: there is no value to compare.
 */
const HASHED_MEMBERS_ARE_HASHED: MembersCovered extends Record<keyof HashedEvent, true>
  ? true
  : false = true;

/** One stored row, as the reader returns it. */
export interface AuditRow extends HashedEvent {
  /** SQLite's AUTOINCREMENT, 1 for the first row. */
  readonly seq: number;
  readonly hash: string;
}

/** What the table holds. */
export interface PolicyAudit {
  /**
   * Append one event; idempotent on `eventId`.
   *
   * @param event - The contract's event; its `prevHash` and `hash` are **ignored** and recomputed,
   * because the chain belongs to this table and not to the producer.
   * @returns The row stored for that `eventId`: the new one, or the one an earlier append stored.
   * @throws UnsupportedFormatError when a member has no canonical form (a lone surrogate, a
   * non-integer `durationMs`): the row is not stored and the call must not settle either (fail
   * closed).
   */
  append(event: AuditEvent): Promise<AuditRow>;
  /** Rows in chain order (ascending `seq`), newest last; `limit` clamped to 1..200, default 50. */
  list(limit?: number | undefined): Promise<readonly AuditRow[]>;
  /**
   * Recompute every row's hash and its link to the row before it.
   *
   * @returns `ok:true` when the whole table verifies, or the first break: `tampered` when a row's
   * `hash` is not what its members hash to, `sequence` when `prevHash` is not the previous
   * row's `hash` (a deleted, inserted, or reordered row) or `seq` is not consecutive.
   */
  verify(): Promise<AuditVerdict>;
}

/** What verifying the chain found. */
type AuditVerdict =
  | { readonly ok: true; readonly rows: number }
  | {
      readonly ok: false;
      readonly kind: "tampered" | "sequence";
      /** The `seq` where the chain stopped fitting together. */
      readonly seq: number;
      readonly reason: string;
    };

/** The rows one list returns when the caller names no size. */
const AUDIT_DEFAULT_LIMIT = 50;

/** The most rows one list returns. */
export const AUDIT_MAX_LIMIT = 200;

/** The values the Durable Object SQL binding accepts and returns. */
type SqlValue = ArrayBuffer | string | number | null;

/** One statement's result: the Durable Object runs the SQL synchronously. */
interface SqlStatement {
  toArray(): Record<string, SqlValue>[];
}

/** The one SQL call the audit makes. */
interface AuditSql {
  exec(query: string, ...bindings: SqlValue[]): SqlStatement;
}

/**
 * The part of the object storage the audit needs: the SQL and the transaction that serializes an
 * append with the head it reads (INV-10).
 */
export interface AuditStorage {
  readonly sql: AuditSql;
  transaction<T>(run: () => Promise<T>): Promise<T>;
}

/**
 * Build the event a row's hash covers.
 *
 * @param row - A row of the table, new or stored.
 * @returns The row's hashed members, `null` where the row has none.
 *
 * @remarks
 * A member that is `undefined` is written as `null`, never dropped: the hashed object's member set
 * is fixed (see the module remarks). The two hashes are the one pair the contract lets a refused
 * call leave out; here their absence is `null`.
 */
export function hashedEvent(row: Omit<AuditRow, "hash">): HashedEvent {
  return {
    v: row.v,
    eventId: row.eventId,
    at: row.at,
    event: row.event,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    callId: row.callId,
    callHash: row.callHash,
    argsHash: row.argsHash,
    toolId: row.toolId,
    toolVersion: row.toolVersion,
    manifestHash: row.manifestHash,
    decision: row.decision,
    durationMs: row.durationMs,
    grantId: row.grantId,
    prevHash: row.prevHash,
  };
}

/**
 * `sha256Hex(JCS(...))` of a row's hashed members.
 *
 * @param row - A row of the table, new or stored.
 * @throws UnsupportedFormatError when a member has no canonical form.
 */
export async function hashOf(row: Omit<AuditRow, "hash">): Promise<string> {
  return sha256Hex(canonicalize(entryOf(hashedEvent(row))));
}

/**
 * The object `canonicalize` sees: exactly the fixed member list, in that order.
 *
 * @remarks
 * Built member by member rather than spread, so a row with an extra JavaScript property (or a
 * `HashedEvent` with one) cannot reach the bytes. `decision` keeps the contract's
 * `PolicyDecision` as written, so its key order is the contract's and JCS sorts it anyway.
 */
function entryOf(event: HashedEvent): HashedEvent {
  return {
    v: event.v,
    eventId: event.eventId,
    at: event.at,
    event: event.event,
    workspaceId: event.workspaceId,
    sessionId: event.sessionId,
    callId: event.callId,
    callHash: event.callHash,
    argsHash: event.argsHash,
    toolId: event.toolId,
    toolVersion: event.toolVersion,
    manifestHash: event.manifestHash,
    decision: event.decision,
    durationMs: event.durationMs,
    grantId: event.grantId,
    prevHash: event.prevHash,
  };
}

/** The columns, in insert order; `seq` comes from the table and `hash` from this module. */
const COLUMNS =
  "seq, event_id, at, event, workspace_id, session_id, call_id, call_hash, args_hash, " +
  "tool_id, tool_version, manifest_hash, decision_json, duration_ms, grant_id, prev_hash, hash";

const SELECT = "SELECT " + COLUMNS + " FROM policy_audit";

/**
 * The contract's decision, as stored.
 *
 * @remarks
 * The allowance is **non-null**, unlike `PolicyDecisionSchema`'s: `{policyRevision: 0}` is how
 * `@hns/agent` records "no policy revision yet, and no grant" in Phase 0 (`PHASE0_POLICY_REVISION`),
 * and a refusal is one an auditor must be able to read; a stored decision the contract would not accept
 * is corruption, so the two shapes are checked strictly here rather than defaulted. Only the allow's
 * revision is relaxed; every other member is the contract's own.
 */
const StoredDecisionSchema: v.GenericSchema<unknown, PolicyDecision> = v.variant("outcome", [
  v.strictObject({
    outcome: v.literal("allow"),
    policyRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
    policyHash: v.string(),
    grantId: v.optional(v.string()),
  }),
  v.strictObject({
    outcome: v.literal("deny"),
    code: DenialCodeSchema,
    message: v.string(),
    policyRevision: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    policyHash: v.optional(v.string()),
  }),
]);

/** One stored row as the database returns it. */
const RowSchema = v.object({
  seq: v.number(),
  event_id: v.string(),
  at: v.string(),
  event: v.picklist(["tool.call", "tool.result"]),
  workspace_id: v.string(),
  session_id: v.string(),
  call_id: v.string(),
  call_hash: v.nullable(v.string()),
  args_hash: v.nullable(v.string()),
  tool_id: v.picklist(TOOL_IDS),
  tool_version: v.string(),
  manifest_hash: v.string(),
  decision_json: v.nullable(v.string()),
  duration_ms: v.nullable(v.number()),
  grant_id: v.nullable(v.string()),
  prev_hash: v.nullable(v.string()),
  hash: v.string(),
});

/**
 * Turn one stored row into the row this module reads and hashes.
 *
 * @throws ValiError when a column is not what the table's schema says.
 */
function toRow(raw: Record<string, SqlValue>): AuditRow {
  const row = v.parse(RowSchema, raw);
  const decision =
    row.decision_json === null
      ? null
      : v.parse(StoredDecisionSchema, JSON.parse(row.decision_json));
  return {
    seq: row.seq,
    v: 1,
    eventId: row.event_id,
    at: isoTimestamp(row.at),
    event: row.event,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    callId: row.call_id,
    callHash: row.call_hash,
    argsHash: row.args_hash,
    toolId: row.tool_id,
    toolVersion: row.tool_version,
    manifestHash: row.manifest_hash,
    decision,
    durationMs: row.duration_ms,
    grantId: row.grant_id,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

/** What a stored row is, for the reader: the row plus the hash the chain gave it. */
function storedRow(
  event: AuditEvent,
  seq: number,
  prevHash: string | null,
  hash: string,
): AuditRow {
  return {
    seq,
    v: 1,
    eventId: event.eventId,
    at: event.at,
    event: event.event,
    workspaceId: event.workspaceId,
    sessionId: event.sessionId,
    callId: event.callId,
    callHash: event.callHash ?? null,
    argsHash: event.argsHash ?? null,
    toolId: event.toolId,
    toolVersion: event.toolVersion,
    manifestHash: event.manifestHash,
    decision: event.event === "tool.result" ? event.decision : null,
    durationMs: event.event === "tool.result" ? event.durationMs : null,
    grantId: event.grantId ?? null,
    prevHash,
    hash,
  };
}

/**
 * Insert one event, or return the row an earlier append of the same `eventId` stored.
 *
 * @remarks
 * Idempotent on `eventId`: a retried append (the sink is awaited, and a caller may retry a failed
 * request) returns the first row instead of adding a second one to the chain. The lookup, the head,
 * the hash, and the insert are in one transaction, so no other append can land between them; the
 * `event_id` UNIQUE index is the second line of defence.
 *
 * A stored row is returned as it was: an event whose stored row differs from the one offered is
 * the same event by `eventId`, and rewriting it would break the chain it is in.
 */
async function appendOne(storage: AuditStorage, event: AuditEvent): Promise<AuditRow> {
  return storage.transaction(async () => {
    const existing = storage.sql.exec(SELECT + " WHERE event_id = ?", event.eventId).toArray()[0];
    if (existing !== undefined) return toRow(existing);
    const head = storage.sql.exec(SELECT + " ORDER BY seq DESC LIMIT 1").toArray()[0];
    const previous = head === undefined ? null : toRow(head);
    const prevHash = previous === null ? null : previous.hash;
    const next: Omit<AuditRow, "hash"> = storedRow(event, (previous?.seq ?? 0) + 1, prevHash, "");
    const hash = await hashOf(next);
    storage.sql.exec(
      "INSERT INTO policy_audit (" +
        COLUMNS +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      next.seq,
      next.eventId,
      next.at,
      next.event,
      next.workspaceId,
      next.sessionId,
      next.callId,
      next.callHash,
      next.argsHash,
      next.toolId,
      next.toolVersion,
      next.manifestHash,
      next.decision === null ? null : JSON.stringify(next.decision),
      next.durationMs,
      next.grantId,
      next.prevHash,
      hash,
    );
    return { ...next, hash };
  });
}

/**
 * Verify every row of the chain.
 *
 * @throws UnsupportedFormatError when a stored member has no canonical form.
 */
async function verifyChain(storage: AuditStorage): Promise<AuditVerdict> {
  const rows = storage.sql
    .exec(SELECT + " ORDER BY seq ASC")
    .toArray()
    .map(toRow);
  let previous: AuditRow | undefined;
  for (const row of rows) {
    if (previous !== undefined && row.seq !== previous.seq + 1) {
      return {
        ok: false,
        kind: "sequence",
        seq: row.seq,
        reason: "seq " + String(row.seq) + " follows " + String(previous.seq),
      };
    }
    const { hash, ...rest } = row;
    if ((await hashOf(rest)) !== hash) {
      return {
        ok: false,
        kind: "tampered",
        seq: row.seq,
        reason: "the row's members do not hash to its hash",
      };
    }
    if (row.prevHash !== (previous?.hash ?? null)) {
      return {
        ok: false,
        kind: "sequence",
        seq: row.seq,
        reason: "prev_hash is not the hash of the row before it",
      };
    }
    previous = row;
  }
  return { ok: true, rows: rows.length };
}

/**
 * Open the policy audit over one Durable Object's SQLite.
 *
 * @param storage - The object's storage; the SQL and the transaction are all it uses.
 * @returns The table, created if needed, and the three operations on it.
 *
 * @remarks
 * The table is the one `docs/capability.md` §9 spells: `seq` is SQLite's AUTOINCREMENT (a
 * deleted row's number is never reused), `event_id` is UNIQUE (idempotence), and the denial codes
 * are a closed CHECK. `decision_json` is the contract's `PolicyDecision` as JSON, `NULL` for a
 * `tool.call` (the decision is judged once the call settles); `duration_ms` is `NULL` there
 * too. A refused call's `call_hash` / `args_hash` are `NULL`: it never became a call
 * (`AuditEventBase`). Nothing here stores an argument, an output, or a secret.
 *
 * The append is one transaction and reads the head inside it (INV-10); reading does not verify the
 * chain (an O(1) page is what the RPC needs), and `verify` is how an auditor proves it.
 */
export function createPolicyAudit(storage: AuditStorage): PolicyAudit {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS policy_audit (" +
      "seq INTEGER PRIMARY KEY AUTOINCREMENT, " +
      "event_id TEXT NOT NULL UNIQUE, " +
      "at TEXT NOT NULL, " +
      "event TEXT NOT NULL CHECK (event IN ('tool.call', 'tool.result')), " +
      "workspace_id TEXT NOT NULL, " +
      "session_id TEXT NOT NULL, " +
      "call_id TEXT NOT NULL, " +
      "call_hash TEXT, " +
      "args_hash TEXT, " +
      "tool_id TEXT NOT NULL CHECK (tool_id IN ('read_file', 'write_file', 'bash')), " +
      "tool_version TEXT NOT NULL, " +
      "manifest_hash TEXT NOT NULL, " +
      "decision_json TEXT, " +
      "duration_ms INTEGER, " +
      "grant_id TEXT, " +
      "prev_hash TEXT, " +
      "hash TEXT NOT NULL)",
  );
  return {
    append: (event) => appendOne(storage, event),
    async list(limit) {
      const size = Math.min(Math.max(Math.trunc(limit ?? AUDIT_DEFAULT_LIMIT), 1), AUDIT_MAX_LIMIT);
      // The newest rows, then the chain's order: the page an operator reads is the tail of the chain.
      const rows = storage.sql
        .exec(SELECT + " ORDER BY seq DESC LIMIT ?", size)
        .toArray()
        .map(toRow);
      return rows.reverse();
    },
    verify: () => verifyChain(storage),
  };
}

/**
 * The sink shape the agent's audit events arrive as, without importing `@hns/agent`.
 *
 * @remarks
 * The same `(event) => Promise<void>` as the contract's `AuditSink`; the Session hands this to
 * `openSession`, which awaits it before a call runs and before a result returns (`docs/capability.md`
 * §8).
 */
export type AuditSink = (event: AuditEvent) => Promise<void>;

/**
 * The audit as a sink: append, which chains the row, and never swallow a failure.
 *
 * @param audit - The open table.
 * @returns The sink the Session passes to `openSession`'s `onAudit`.
 */
export function auditSink(audit: PolicyAudit): AuditSink {
  return async (event) => {
    await audit.append(event);
  };
}

/** What an audit row's `eventId` is minted from: one per object, monotone within it. */
export interface AuditEventIds {
  /** A fresh event id, unique in this object. */
  next(): string;
}

/**
 * Mint event ids for one object.
 *
 * @param prefix - The object's name, so a row copied between objects still says where it came from.
 * @returns A counter; a fresh Session (an eviction) starts a new random epoch, so two objects' ids
 * never collide.
 *
 * @remarks
 * `eventId` is the idempotence key of the append, so it has to be unique and cheap: `crypto.randomUUID`
 * per event would be fine too, but ids are read in the audit's sequence and a counter makes a stored
 * object's chain readable. The epoch is random because the counter restarts when the object does.
 */
export function auditEventIds(prefix: string): AuditEventIds {
  const epoch = crypto.randomUUID();
  let counter = 0;
  return {
    next() {
      counter += 1;
      return prefix + ":" + epoch + ":" + String(counter);
    },
  };
}

/**
 * The denial code a stored decision denies with, or undefined for an allow.
 *
 * @internal
 * @remarks
 * The reader hands the decision back as the contract's value; this is for a caller that wants only
 * the code (an operator's table).
 */
export function denialOf(row: AuditRow): DenialCode | undefined {
  return row.decision?.outcome === "deny" ? row.decision.code : undefined;
}

/** The contract's audit event a stored row is, for a test that re-reads what was written. */
function eventOf(row: AuditRow): AuditEvent {
  const base = {
    v: 1 as const,
    eventId: row.eventId,
    at: row.at,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    callId: row.callId,
    toolId: row.toolId,
    toolVersion: row.toolVersion,
    manifestHash: row.manifestHash,
    prevHash: row.prevHash,
    hash: row.hash,
  };
  const hashes =
    row.callHash === null || row.argsHash === null
      ? {}
      : { callHash: row.callHash, argsHash: row.argsHash };
  if (row.decision !== null && row.durationMs !== null) {
    return {
      ...base,
      ...hashes,
      event: "tool.result",
      decision: row.decision,
      durationMs: row.durationMs,
    };
  }
  return { ...base, ...hashes, event: "tool.call" };
}

/**
 * The stored row read back through the contract's schema.
 *
 * @param row - One row of the table.
 * @returns The event the row is, parsed by `AuditEventSchema`: the contract's own reading of what was
 * stored, so a stored row that the contract would not accept fails here rather than in a reader.
 */
export function storedEvent(row: AuditRow): AuditEvent {
  return v.parse(AuditEventSchema, eventOf(row));
}
