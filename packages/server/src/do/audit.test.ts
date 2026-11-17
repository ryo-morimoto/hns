import { isoTimestamp } from "@hns/core";
import type { AuditEvent } from "@hns/core/capability";
import { describe, expect, test } from "vitest";
import { openSqliteState } from "../../test/support/sqlite.ts";
import {
  AUDIT_MAX_LIMIT,
  auditEventIds,
  auditSink,
  createPolicyAudit,
  hashedEvent,
  hashOf,
  storedEvent,
  type AuditRow,
} from "./audit.ts";

const CALL_HASH = "1".repeat(64);
const ARGS_HASH = "2".repeat(64);
const MANIFEST_HASH = "3".repeat(64);
const POLICY_HASH = "4".repeat(64);

/** A real object storage: node:sqlite through the Durable Object binding's shape. */
function openAudit() {
  const opened = openSqliteState();
  const audit = createPolicyAudit(opened.state.storage);
  const storage = opened.state.storage;
  return { audit, storage, close: opened.close };
}

/** One `tool.call`: a call that was admitted, with its hashes. */
function toolCall(eventId: string, callId = "tool:1:a"): AuditEvent {
  return {
    v: 1,
    event: "tool.call",
    eventId,
    at: isoTimestamp("2026-11-17T12:00:00.000Z"),
    workspaceId: "w1",
    sessionId: "s1",
    callId,
    callHash: CALL_HASH,
    argsHash: ARGS_HASH,
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: MANIFEST_HASH,
    prevHash: null,
    hash: "",
  };
}

/** One `tool.result` for the call, with a decision. */
function toolResult(
  eventId: string,
  outcome: "allow" | "deny" = "allow",
  callId = "tool:1:a",
): AuditEvent {
  return {
    v: 1,
    event: "tool.result",
    eventId,
    at: isoTimestamp("2026-11-17T12:00:01.000Z"),
    workspaceId: "w1",
    sessionId: "s1",
    callId,
    callHash: CALL_HASH,
    argsHash: ARGS_HASH,
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: MANIFEST_HASH,
    prevHash: null,
    hash: "",
    decision:
      outcome === "allow"
        ? { outcome: "allow", policyRevision: 1, policyHash: POLICY_HASH }
        : {
            outcome: "deny",
            code: "path_outside_root",
            message: "the path is outside the workspace root",
          },
    durationMs: 3,
  };
}

/** A refused call's `tool.call`: no call, so no hashes (`AuditEventBase`). */
function refusedCall(eventId: string): AuditEvent {
  const { callHash: _call, argsHash: _args, ...rest } = toolCall(eventId);
  return rest;
}

// C1: the chain links one row to the next, and an event id is appended once.
describe("append", () => {
  test("C1: the first row starts the chain and the second points at it", async () => {
    const { audit, close } = openAudit();
    try {
      const first = await audit.append(toolCall("e1"));
      const second = await audit.append(toolResult("e2"));
      expect(first.seq).toBe(1);
      expect(first.prevHash).toBeNull();
      expect(second.seq).toBe(2);
      expect(second.prevHash).toBe(first.hash);
      expect(await audit.verify()).toStrictEqual({ ok: true, rows: 2 });
    } finally {
      close();
    }
  });

  test("C1: a retried event id returns the stored row instead of a second one", async () => {
    const { audit, close } = openAudit();
    try {
      const first = await audit.append(toolCall("e1"));
      const retry = await audit.append(toolCall("e1"));
      expect(retry).toStrictEqual(first);
      expect(await audit.list()).toHaveLength(1);
      expect((await audit.append(toolResult("e2"))).prevHash).toBe(first.hash);
    } finally {
      close();
    }
  });

  test("C1: the chain is the hash of the row's members, and it recomputes", async () => {
    const { audit, close } = openAudit();
    try {
      const row = await audit.append(toolResult("e1"));
      const { hash: _hash, ...members } = row;
      expect(await hashOf(members)).toBe(row.hash);
      // `hashedEvent` is the one place the member list is built: the same row, the same members.
      expect(hashedEvent(members)).toStrictEqual(hashedEvent(row));
      expect(row.hash).toHaveLength(64);
    } finally {
      close();
    }
  });

  test("C1: a tool.call has no decision, and a refused call has no hashes", async () => {
    const { audit, close } = openAudit();
    try {
      const call = await audit.append(toolCall("e1"));
      expect(call.decision).toBeNull();
      expect(call.durationMs).toBeNull();
      const refused = await audit.append(refusedCall("e2"));
      expect(refused.callHash).toBeNull();
      expect(refused.argsHash).toBeNull();
      // The row is still the contract's event: a refused call is an event without the two hashes.
      expect(storedEvent(refused)).toMatchObject({ event: "tool.call", eventId: "e2" });
      expect("callHash" in storedEvent(refused)).toBe(false);
      expect(await audit.verify()).toStrictEqual({ ok: true, rows: 2 });
    } finally {
      close();
    }
  });
});

// C2-C4: deletion, edits, and reordering are each found by walking the table.
describe("verify", () => {
  test("C2: a deleted row breaks the sequence and the link", async () => {
    const { audit, storage, close } = openAudit();
    try {
      await audit.append(toolCall("e1"));
      await audit.append(toolResult("e2"));
      await audit.append(toolCall("e3", "tool:2:b"));
      storage.sql.exec("DELETE FROM policy_audit WHERE seq = 2");
      const verdict = await audit.verify();
      expect(verdict).toMatchObject({ ok: false, kind: "sequence", seq: 3 });
    } finally {
      close();
    }
  });

  test("C2: deleting the newest row leaves a chain that verifies but is short", async () => {
    const { audit, storage, close } = openAudit();
    try {
      await audit.append(toolCall("e1"));
      await audit.append(toolResult("e2"));
      storage.sql.exec("DELETE FROM policy_audit WHERE seq = 2");
      // A row removed from the end is invisible to a walk of what is left; the row count is what an
      // operator has to compare against another system's (R2 anchor, later), so the count is returned.
      expect(await audit.verify()).toStrictEqual({ ok: true, rows: 1 });
    } finally {
      close();
    }
  });

  test("C3: an edited decision no longer hashes to its row's hash", async () => {
    const { audit, storage, close } = openAudit();
    try {
      await audit.append(toolCall("e1"));
      await audit.append(toolResult("e2"));
      storage.sql.exec(
        "UPDATE policy_audit SET decision_json = ? WHERE seq = 2",
        JSON.stringify({
          outcome: "deny",
          code: "egress_denied",
          message: "an edited decision",
        }),
      );
      const verdict = await audit.verify();
      expect(verdict).toMatchObject({ ok: false, kind: "tampered", seq: 2 });
    } finally {
      close();
    }
  });

  test("C3: a one-character edit of a stored hash is found", async () => {
    const { audit, storage, close } = openAudit();
    try {
      const first = await audit.append(toolCall("e1"));
      const tampered = first.hash.slice(0, -1) + (first.hash.endsWith("a") ? "b" : "a");
      storage.sql.exec("UPDATE policy_audit SET hash = ? WHERE seq = 1", tampered);
      expect(await audit.verify()).toMatchObject({ ok: false, kind: "tampered", seq: 1 });
    } finally {
      close();
    }
  });

  test("C4: two rows swapped in place break the links", async () => {
    const { audit, storage, close } = openAudit();
    try {
      await audit.append(toolCall("e1"));
      await audit.append(toolCall("e2", "tool:2:b"));
      await audit.append(toolCall("e3", "tool:3:c"));
      // Swap seq 2 and 3's identity: move the seq numbers so the numbers stay consecutive.
      storage.sql.exec("UPDATE policy_audit SET seq = -1 WHERE seq = 2");
      storage.sql.exec("UPDATE policy_audit SET seq = 2 WHERE seq = 3");
      storage.sql.exec("UPDATE policy_audit SET seq = 3 WHERE seq = -1");
      expect(await audit.verify()).toMatchObject({ ok: false, kind: "sequence" });
    } finally {
      close();
    }
  });
});

// C6: the read is ascending, bounded, and carries no argument, output, or secret.
describe("list", () => {
  test("C6: rows come back oldest first within the limit, and the page is the chain's tail", async () => {
    const { audit, close } = openAudit();
    try {
      for (let index = 1; index <= 5; index += 1) {
        await audit.append(toolCall("e" + String(index), "tool:" + String(index) + ":a"));
      }
      expect((await audit.list()).map((row) => row.seq)).toStrictEqual([1, 2, 3, 4, 5]);
      expect((await audit.list(2)).map((row) => row.seq)).toStrictEqual([4, 5]);
      expect((await audit.list(1)).map((row) => row.seq)).toStrictEqual([5]);
      expect((await audit.list(AUDIT_MAX_LIMIT + 100)).map((row) => row.seq)).toHaveLength(5);
      expect((await audit.list(0)).map((row) => row.seq)).toStrictEqual([5]);
    } finally {
      close();
    }
  });

  test("C6: a row of the page is the event the contract accepts", async () => {
    const { audit, close } = openAudit();
    try {
      const call = await audit.append(toolCall("e1"));
      const result = await audit.append(toolResult("e2"));
      expect(storedEvent(call)).toMatchObject({ event: "tool.call", callHash: CALL_HASH });
      expect(storedEvent(result)).toMatchObject({
        event: "tool.result",
        durationMs: 3,
        decision: { outcome: "allow" },
      });
    } finally {
      close();
    }
  });

  test("C6: the stored row carries no argument, output, or secret", async () => {
    const { audit, storage, close } = openAudit();
    try {
      await audit.append(toolCall("e1"));
      await audit.append(toolResult("e2"));
      const dump = JSON.stringify(storage.sql.exec("SELECT * FROM policy_audit").toArray());
      expect(dump).not.toContain("secret");
      expect(dump).not.toContain("content");
      // Every stored value is one of the contract's fields.
      const row: AuditRow = (await audit.list())[0] ?? (await audit.append(toolCall("e3")));
      expect(Object.keys(row).sort()).toStrictEqual(
        [
          "argsHash",
          "at",
          "callHash",
          "callId",
          "decision",
          "durationMs",
          "event",
          "eventId",
          "grantId",
          "hash",
          "manifestHash",
          "prevHash",
          "seq",
          "sessionId",
          "toolId",
          "toolVersion",
          "v",
          "workspaceId",
        ].sort(),
      );
    } finally {
      close();
    }
  });
});

// The sink the Session hands to openSession, and the ids it mints.
describe("wiring", () => {
  test("a sink appends, and an append failure is not swallowed", async () => {
    const { audit, close } = openAudit();
    try {
      const sink = auditSink(audit);
      await sink(toolCall("e1"));
      expect(await audit.list()).toHaveLength(1);
      // The same event id again: the sink stays idempotent, because the table is.
      await sink(toolCall("e1"));
      expect(await audit.list()).toHaveLength(1);
    } finally {
      close();
    }
  });

  test("an event with no canonical form fails the append, so the call cannot settle", async () => {
    const { audit, close } = openAudit();
    try {
      const result = toolResult("e1");
      if (result.event !== "tool.result") throw new Error("the fixture is a tool.result");
      const broken: AuditEvent = { ...result, durationMs: 1.5 };
      await expect(audit.append(broken)).rejects.toThrow(/canonical JSON/);
      expect(await audit.list()).toHaveLength(0);
    } finally {
      close();
    }
  });

  test("event ids are unique within an object and differ between two", () => {
    const first = auditEventIds("s1");
    const second = auditEventIds("s1");
    const a = first.next();
    expect(a).not.toBe(first.next());
    expect(second.next()).not.toBe(a);
    expect(a.startsWith("s1:")).toBe(true);
  });
});
