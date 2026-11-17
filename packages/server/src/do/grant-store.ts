import { canonicalize, type GrantPayload } from "@hns/core/capability";
import { createGrantAudit, type GrantAudit, type GrantAuditStorage } from "./grant-audit.ts";
import {
  createSqliteGrantLedger,
  type GrantLedger,
  type GrantLedgerStorage as SqliteLedgerStorage,
} from "./grant-ledger.ts";
import type { GrantAttempt, GrantRecorder, GrantRequest } from "./session-grants.ts";

/**
 * The Session object's grant recorder: the ledger and the issuance audit, written together (0224).
 *
 * @remarks
 * A grant is recorded in **both** tables before it is answered: `session_grants` says what stands and
 * what was revoked, `grant_audit` is the chained record of every attempt. A refusal has no ledger row
 * (there is nothing to revoke) but does have an audit row: "who asked for a capability and did not
 * get it" is what a detector reads after an incident.
 *
 * The two writes are one transaction on the object's storage, so a grant is in both or in neither.
 * The audit row is what can fail for a grant whose signature is fine (a member with no canonical
 * form), and then the ledger row must not stand either: the write throws
 * {@link ./grant-ledger.ts GrantLedgerUnavailableError} and the plane turns that into a refusal, so
 * a grant is never handed out with no record of having been issued.
 */

/** What the recorder is built with. */
export interface SqliteGrantRecorderOptions {
  /** The ledger over the object's storage. */
  readonly ledger: GrantLedger;
  /** The issuance audit over the object's storage. */
  readonly audit: GrantAudit;
  /** The object's storage transaction; both writes are one. */
  transaction<T>(run: () => Promise<T>): Promise<T>;
  /** The event id for one audit row. */
  readonly eventId: () => string;
}

/** The audit row one attempt becomes, from the payload when issued and the request when refused. */
function auditEntryOf(attempt: GrantAttempt, eventId: string) {
  const issued = attempt.issue.ok ? attempt.issue.grant.payload : undefined;
  const request: GrantRequest | undefined = attempt.issue.ok ? undefined : attempt.issue.request;
  return {
    v: 1 as const,
    eventId,
    at: attempt.at,
    event: issued === undefined ? ("grant.refused" as const) : ("grant.issued" as const),
    workspaceId: attempt.workspaceId,
    sessionId: attempt.sessionId,
    grantId: issued?.grantId ?? null,
    toolId: issued?.toolId ?? request?.toolId ?? null,
    toolVersion: issued?.toolVersion ?? request?.toolVersion ?? null,
    manifestHash: issued?.manifestHash ?? request?.manifestHash ?? null,
    machineId: issued?.machineId ?? request?.machineId ?? null,
    scopeJson: issued === undefined ? null : canonicalize(issued.scope),
    epoch: issued?.epoch ?? null,
    maxCalls: issued?.maxCalls ?? null,
    maxBytes: issued?.maxBytes ?? null,
    expiresAt: issued?.expiresAt ?? null,
    requestedByKind: attempt.requestedBy.kind,
    requestedBy: attempt.requestedBy.id,
    runId: attempt.requestedBy.runId ?? null,
    outcome: issued === undefined ? ("refused" as const) : ("issued" as const),
    code: attempt.issue.ok ? null : attempt.issue.decision.code,
  };
}

/**
 * The recorder over the Session's SQLite.
 *
 * @param options - The two tables, their shared transaction, and the event id source.
 * @returns The recorder the grant plane writes through.
 */
export function createSqliteGrantRecorder(options: SqliteGrantRecorderOptions): GrantRecorder {
  return {
    async record(attempt) {
      // One transaction for both writes, and the audit joins it rather than opening its own: the
      // object's storage runs one transaction at a time and does not nest them.
      return await options.transaction(async () => {
        await options.audit.appendWithin(auditEntryOf(attempt, options.eventId()));
        if (!attempt.issue.ok) return undefined;
        const payload = attempt.issue.grant.payload;
        return await options.ledger.record(recordOfPayload(payload, attempt));
      });
    },
    async revoke(grantId, at) {
      return await options.ledger.revoke(grantId, at);
    },
    async boundTo(runId) {
      return await options.ledger.boundTo(runId);
    },
  };
}

/** The ledger row one issued grant becomes. */
function recordOfPayload(payload: GrantPayload, attempt: GrantAttempt) {
  return {
    grantId: payload.grantId,
    nonce: payload.nonce,
    workspaceId: payload.workspaceId,
    sessionId: payload.sessionId,
    machineId: payload.machineId,
    toolId: payload.toolId,
    toolVersion: payload.toolVersion,
    manifestHash: payload.manifestHash,
    scope: payload.scope,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    epoch: payload.epoch,
    maxCalls: payload.maxCalls,
    maxBytes: payload.maxBytes,
    keyId: payload.keyId,
    requestedBy: attempt.requestedBy,
  };
}

/** The tables one Session opens: the ledger and the issuance audit. */
export interface GrantTables {
  readonly ledger: GrantLedger;
  readonly audit: GrantAudit;
}

/**
 * Open both grant tables over one object's storage.
 *
 * @param storage - The object's storage (its SQL and its transaction).
 * @returns The tables; the recorder and the plane are built from them.
 */
export function openGrantTables(storage: GrantAuditStorage & SqliteLedgerStorage): GrantTables {
  return {
    ledger: createSqliteGrantLedger({ sql: storage.sql }),
    audit: createGrantAudit(storage),
  };
}
