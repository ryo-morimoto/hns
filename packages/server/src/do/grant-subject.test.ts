import { isoTimestamp } from "@hns/core";
import { expect, test } from "vitest";
import { createGrantAudit } from "./grant-audit.ts";
import {
  GRANT_INTERNAL_HEADER,
  GRANT_SUBJECT_HEADER,
  checkRequester,
  grantInternalToken,
  sameToken,
} from "./grant-subject.ts";

/**
 * The grant route's binding (0224, NB7): only the Worker may call it, and the requester must be the
 * person (or that person's agent) the Worker verified.
 *
 * @remarks
 * The route is reachable only through the `SESSION` binding, which is a deployment fact and not
 * something this code can rely on. These tests pin the two fences that do not depend on it: the
 * token the Worker derives from the session secret, and the subject the requester must match.
 */

// Catches: a route that accepts a caller which does not know the session secret, a token that is the
// secret itself, or a token that drifts between the Worker's derivation and the object's.
test("the caller token is derived from the secret, and only the same derivation matches", async () => {
  const token = await grantInternalToken("a-session-secret-of-32-characters!!");
  const again = await grantInternalToken("a-session-secret-of-32-characters!!");
  const other = await grantInternalToken("another-session-secret-of-32-chars!");
  expect(token).toBe(again);
  expect(token).not.toBe(other);
  expect(token).toMatch(/^[0-9a-f]{64}$/u);
  expect(token).not.toContain("a-session-secret");
  expect(await grantInternalToken(undefined)).toBeUndefined();
  expect(await grantInternalToken("")).toBeUndefined();
  expect(sameToken(token, again)).toBe(true);
  expect(sameToken(token, other)).toBe(false);
  expect(sameToken(undefined, again)).toBe(false);
  expect(sameToken(again, undefined)).toBe(false);
  expect(sameToken(token?.slice(1), again)).toBe(false);
});

// Catches: a body that names another person (or another agent) being accepted, so a caller could ask
// for a grant for someone else's workspace and have the ledger record the wrong principal.
test("the requester must be the verified subject, or an agent of it", () => {
  expect(checkRequester({ kind: "human", id: "owner" }, "owner")).toBe("ok");
  expect(checkRequester({ kind: "agent", id: "agent-1" }, "agent:agent-1")).toBe("ok");
  expect(checkRequester({ kind: "agent", id: "agent-2" }, "agent:agent-1")).toBe(
    "subject_mismatch",
  );
  expect(checkRequester({ kind: "human", id: "someone" }, "owner")).toBe("subject_mismatch");
  expect(checkRequester({ kind: "agent", id: "agent-1" }, "owner")).toBe("agent_for_human");
  // A run is a property of the agent's requester, not another identity.
  expect(checkRequester({ kind: "agent", id: "agent-1", runId: "4" }, "agent:agent-1")).toBe("ok");
});

// Catches: the headers being renamed on one side only (the route would refuse every real call).
test("the header names are the ones the Worker and the object share", () => {
  expect(GRANT_INTERNAL_HEADER).toBe("x-hns-session-token");
  expect(GRANT_SUBJECT_HEADER).toBe("x-hns-subject");
});

// Catches: the issuance audit accepting the revocation-failure event while its chain verifier does
// not read it back (the row would be written and then be unverifiable).
test("the issuance audit records a revocation failure and the chain still verifies", async () => {
  const { openSqliteState } = await import("../../test/support/sqlite.ts");
  const opened = openSqliteState();
  try {
    const audit = createGrantAudit(opened.state.storage);
    await audit.append({
      v: 1,
      eventId: "e1",
      at: isoTimestamp("2026-11-18T00:00:00.000Z"),
      event: "grant.issued",
      workspaceId: "w",
      sessionId: "w",
      grantId: "g1",
      toolId: "read_file",
      toolVersion: "1",
      manifestHash: "a".repeat(64),
      machineId: "m",
      scopeJson: '{"kind":"read","roots":["."]}',
      epoch: 1,
      maxCalls: 1,
      maxBytes: 10,
      expiresAt: isoTimestamp("2026-11-18T00:01:00.000Z"),
      requestedByKind: "agent",
      requestedBy: "agent-1",
      runId: "9",
      outcome: "issued",
      code: null,
    });
    const row = await audit.append({
      v: 1,
      eventId: "e2",
      at: isoTimestamp("2026-11-18T00:00:30.000Z"),
      event: "grant.revoke_failed",
      workspaceId: "w",
      sessionId: "w",
      grantId: "g1",
      toolId: "read_file",
      toolVersion: "1",
      manifestHash: "a".repeat(64),
      machineId: "m",
      scopeJson: null,
      epoch: null,
      maxCalls: null,
      maxBytes: null,
      expiresAt: null,
      requestedByKind: "agent",
      requestedBy: "agent-1",
      runId: "9",
      outcome: "refused",
      code: "grant_invalid",
    });
    expect(row.event).toBe("grant.revoke_failed");
    expect(await audit.verify()).toStrictEqual({ ok: true, rows: 2 });
  } finally {
    opened.close();
  }
});
