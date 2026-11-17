import { isoTimestamp } from "@hns/core";
import { canonicalize } from "@hns/core/capability";
import { expect, test } from "vitest";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { createGrantAudit, grantAuditHash, scopeOf, type GrantAuditEntry } from "./grant-audit.ts";
import { createSqliteGrantLedger, type GrantRecord } from "./grant-ledger.ts";

/**
 * The grant ledger and the issuance audit over real `node:sqlite` (0224, `docs/capability.md` §9).
 *
 * @remarks
 * The tests run the production code over the Durable Object storage's shape: the ledger's rows and
 * the audit's chain, including an edit made behind the writer's back, which the chain has to detect.
 */

/** One issued grant, as the ledger keeps it. */
function recordOf(overrides: Partial<GrantRecord> = {}): GrantRecord {
  return {
    grantId: "g1",
    nonce: "n1",
    workspaceId: "w1",
    sessionId: "s1",
    machineId: "m1",
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: "a".repeat(64),
    scope: { kind: "read", roots: ["."] },
    issuedAt: isoTimestamp("2026-11-18T00:00:00.000Z"),
    expiresAt: isoTimestamp("2026-11-18T00:01:00.000Z"),
    epoch: 7,
    maxCalls: 10,
    maxBytes: 4096,
    keyId: "k1",
    requestedBy: { kind: "agent", id: "agent:1", runId: "12" },
    ...overrides,
  };
}

// Catches: a ledger that loses a field on the round trip (the scope most of all), or that cannot
// answer which grants a run holds and which were revoked.
test("the ledger round-trips a grant and revokes it once", async () => {
  const opened = openSqliteState();
  try {
    const ledger = createSqliteGrantLedger(opened.state.storage);
    const stored = await ledger.record(recordOf());
    expect(stored).toStrictEqual(recordOf());
    expect(await ledger.get("g1")).toStrictEqual(recordOf());
    expect(await ledger.boundTo("12")).toStrictEqual([recordOf()]);
    // A person's grant is bound to no run, so no run end touches it.
    await ledger.record(
      recordOf({ grantId: "g2", nonce: "n2", requestedBy: { kind: "human", id: "u1" } }),
    );
    expect(await ledger.boundTo("12")).toHaveLength(1);
    const at = isoTimestamp("2026-11-18T00:00:30.000Z");
    expect(await ledger.revoke("g1", at)).toBe(true);
    expect(await ledger.revoke("g1", at)).toBe(false);
    expect((await ledger.get("g1"))?.revokedAt).toBe(at);
    expect(await ledger.boundTo("12")).toStrictEqual([]);
    expect(await ledger.revoke("missing", at)).toBe(false);
    expect(await ledger.get("missing")).toBeUndefined();
  } finally {
    opened.close();
  }
});

// Catches: two grants sharing an id or a nonce (a replay the machine would accept once).
test("the ledger refuses a duplicate grant id or nonce", async () => {
  const opened = openSqliteState();
  try {
    const ledger = createSqliteGrantLedger(opened.state.storage);
    await ledger.record(recordOf());
    await expect(ledger.record(recordOf())).rejects.toThrow();
    await expect(ledger.record(recordOf({ grantId: "g2" }))).rejects.toThrow();
  } finally {
    opened.close();
  }
});

/** One audit row. */
function entryOf(eventId: string, overrides: Partial<Omit<GrantAuditEntry, "prevHash">> = {}) {
  return {
    v: 1 as const,
    eventId,
    at: isoTimestamp("2026-11-18T00:00:00.000Z"),
    event: "grant.issued" as const,
    workspaceId: "w1",
    sessionId: "s1",
    grantId: "g1",
    toolId: "read_file" as const,
    toolVersion: "1",
    manifestHash: "a".repeat(64),
    machineId: "m1",
    scopeJson: canonicalize({ kind: "read", roots: ["."] }),
    epoch: 7,
    maxCalls: 10,
    maxBytes: 4096,
    expiresAt: isoTimestamp("2026-11-18T00:01:00.000Z"),
    requestedByKind: "agent" as const,
    requestedBy: "agent:1",
    runId: "12",
    outcome: "issued" as const,
    code: null,
    ...overrides,
  };
}

// Catches: an issuance audit whose chain does not verify, or that accepts the same event twice.
test("the issuance audit chains, is idempotent, and verifies", async () => {
  const opened = openSqliteState();
  try {
    const audit = createGrantAudit(opened.state.storage);
    const first = await audit.append(entryOf("e1"));
    const second = await audit.append(
      entryOf("e2", { outcome: "refused", code: "tool_disabled", grantId: null }),
    );
    expect(first.prevHash).toBeNull();
    expect(second.prevHash).toBe(first.hash);
    expect(second.seq).toBe(2);
    // The same event id is the same row: a retried append does not add to the chain.
    const again = await audit.append(
      entryOf("e2", { outcome: "refused", code: "tool_disabled", grantId: null }),
    );
    expect(again.hash).toBe(second.hash);
    expect(await audit.verify()).toStrictEqual({ ok: true, rows: 2 });
    // The stored scope parses back as the contract's scope.
    expect(scopeOf(first.scopeJson)).toStrictEqual({ kind: "read", roots: ["."] });
    expect(() => scopeOf('{"kind":"unknown"}')).toThrow();
  } finally {
    opened.close();
  }
});

// Catches: a chain that would accept an edited row (the row's hash no longer matches its members) or
// a deleted middle row (the next row's prevHash no longer matches).
test("the issuance audit detects an edited row and a deleted one", async () => {
  const opened = openSqliteState();
  try {
    const audit = createGrantAudit(opened.state.storage);
    await audit.append(entryOf("e1"));
    await audit.append(entryOf("e2", { grantId: "g2" }));
    await audit.append(entryOf("e3", { grantId: "g3" }));
    opened.sql("UPDATE grant_audit SET max_calls = 99 WHERE event_id = 'e2'");
    expect(await audit.verify()).toMatchObject({ ok: false, kind: "tampered", seq: 2 });
    // Undo the edit; delete the middle row instead.
    await opened.state.storage.sql.exec(
      "UPDATE grant_audit SET max_calls = 10 WHERE event_id = 'e2'",
    );
    expect((await audit.verify()).ok).toBe(true);
    opened.sql("DELETE FROM grant_audit WHERE event_id = 'e2'");
    expect(await audit.verify()).toMatchObject({ ok: false, kind: "sequence", seq: 3 });
  } finally {
    opened.close();
  }
});

// Catches: a hash that is over a different member set than the one stored (the two must agree).
test("a row's hash is over its stored members", async () => {
  const opened = openSqliteState();
  try {
    const audit = createGrantAudit(opened.state.storage);
    const row = await audit.append(entryOf("e1"));
    const { seq: _seq, hash: _hash, ...members } = row;
    expect(await grantAuditHash({ ...members, maxCalls: 99 })).not.toBe(row.hash);
    expect(await grantAuditHash(members)).toBe(row.hash);
  } finally {
    opened.close();
  }
});
