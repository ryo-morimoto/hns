import { expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import { deny, policyHash } from "@hns/core/capability";
import type {
  AuditEvent,
  PolicyDocument,
  SignedGrant,
  ToolCall,
  ToolManifest,
} from "@hns/core/capability";
import type { GrantedAnswer } from "@hns/workspace/protocol";
import type { PolicyAudit } from "./audit.ts";
import type { MachineFiles } from "./machine.ts";
import * as v from "valibot";
import type { JsonValue } from "@hns/core";
import { PolicySnapshotBodySchema } from "@hns/workspace/protocol";
import type { PolicySnapshot } from "./session-grants.ts";
import type { PolicyDecision as AuditDecision } from "@hns/core/capability";
import { createToolPath, type GrantIssuer, type GrantedCallRequest } from "./session-tools.ts";

/**
 * The object's granted tool path (0226 C7, C8, C9 on the object's side).
 *
 * @remarks
 * The machine is the object's own port, faked here so a test can say what a machine answers; the
 * audit is a sink that records every event the path appends (its table and chain are 0222's suite).
 * What is proved is everything the object adds around the machine: the snapshot must move forward
 * and be hash-checked, a grant is issued for the run and relayed to the machine, a revoked grant
 * never reaches the machine, and the call's decision is written whichever way it settled.
 */

const NOW = Date.parse("2026-11-18T00:00:00.000Z");

const MANIFEST: ToolManifest = {
  v: 1,
  toolId: "read_file",
  version: "1",
  descriptionHash: "a".repeat(64),
  parametersHash: "b".repeat(64),
  risk: "read",
  outputLimits: { maxBytes: 4096, maxLines: 100 },
};

const CALL: ToolCall = {
  v: 1,
  callId: "tool:1:call-1",
  toolId: "read_file",
  toolVersion: "1",
  args: { path: "a.txt" },
};

const GRANT: SignedGrant = {
  payload: {
    v: 1,
    grantId: "grant-1",
    workspaceId: "w1",
    sessionId: "s1",
    machineId: "m1",
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: "c".repeat(64),
    scope: { kind: "read", roots: ["."] },
    issuedAt: isoTimestamp("2026-11-18T00:00:00.000Z"),
    expiresAt: isoTimestamp("2026-11-18T00:01:00.000Z"),
    epoch: 1,
    policyHash: "d".repeat(64),
    maxCalls: 10,
    maxBytes: 4096,
    nonce: "nonce-1",
    alg: "Ed25519",
    keyId: "key-1",
  },
  signature: "signature-1",
};

const ALLOW: GrantedAnswer = {
  decision: { outcome: "allow", policyRevision: 1, policyHash: "d".repeat(64), grantId: "grant-1" },
  grantId: "grant-1",
  result: { kind: "read", content: "b3V0", version: "sha256:x", size: 3 },
};

/** The policy the snapshot carries: read and write over the root. */
function document(): PolicyDocument {
  return {
    v: 1,
    tools: {
      read_file: {
        enabled: true,
        scope: { kind: "read", roots: ["."] },
        grantTtlSeconds: 60,
        maxCallsPerGrant: 10,
      },
      write_file: {
        enabled: true,
        scope: { kind: "write", roots: ["."] },
        grantTtlSeconds: 60,
        maxCallsPerGrant: 10,
      },
    },
    egress: { enabled: false, hosts: [] },
  };
}

/** A snapshot of the document at `revision`, with the real hash. */
async function snapshot(revision: number): Promise<PolicySnapshot> {
  const doc = document();
  return { revision, hash: await policyHash(doc), document: doc };
}

/** The snapshot as the RPC body carries it: the same JSON, as the state's parser takes it. */
function payloadOf(snapshot: PolicySnapshot): Readonly<Record<string, JsonValue>> {
  return v.parse(PolicySnapshotBodySchema, snapshot);
}

/** What one test's object is made of. */
interface Fixture {
  readonly path: ReturnType<typeof createToolPath>;
  readonly audits: AuditEvent[];
  readonly issued: { readonly call: ToolCall; readonly runId: string }[];
  readonly relayed: { readonly body: unknown; readonly signature: string | null }[];
  readonly machineAnswer: { current: GrantedAnswer };
  readonly revoked: Set<string>;
  readonly requests: { readonly url: string; readonly headers: Headers }[];
}

/** The machine port: the granted path does not use it (it relays over `fetch`). */
function idleMachine(): MachineFiles {
  const unused = (): never => {
    throw new Error("the granted path relays over fetch, not through the machine port");
  };
  return {
    write: async () => unused(),
    read: async () => unused(),
    checkpoint: async () => unused(),
  };
}

/** One object over a recording audit, a fake issuer, and a `fetch` that stands for the machine. */
function fixture(): Fixture {
  const audits: AuditEvent[] = [];
  const issued: { call: ToolCall; runId: string }[] = [];
  const relayed: { body: unknown; signature: string | null }[] = [];
  const requests: { url: string; headers: Headers }[] = [];
  const revoked = new Set<string>();
  const machineAnswer = { current: ALLOW };
  const audit: PolicyAudit = {
    append: async (event) => {
      audits.push(event);
      return rowOf(event, audits.length);
    },
    list: async () => [],
    verify: async () => ({ ok: true, rows: 0 }),
  };
  const issuer: GrantIssuer = {
    async issue(input) {
      issued.push({ call: { ...CALL, toolId: input.request.toolId }, runId: input.runId });
      return { ok: true, grant: GRANT };
    },
  };
  let eventId = 0;
  const path = createToolPath({
    workspaceId: "w1",
    sessionId: "s1",
    issuer,
    audit,
    machine: idleMachine(),
    agentUrl: "http://127.0.0.1:8788",
    controlPlaneKey: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"),
    machineId: "m1",
    manifests: async () => [MANIFEST],
    revoked: async (grantId) => revoked.has(grantId),
    grantOf: async () => undefined,
    now: () => NOW,
    eventId: () => {
      eventId += 1;
      return "a" + String(eventId);
    },
    fetch: async (url, init) => {
      const target = url instanceof URL ? url.href : url instanceof Request ? url.url : url;
      requests.push({ url: target, headers: new Headers(init?.headers) });
      const body = new TextDecoder().decode(v.parse(v.instance(Uint8Array), init?.body));
      relayed.push({
        body: JSON.parse(body),
        signature: new Headers(init?.headers).get("x-hns-signature"),
      });
      return new Response(JSON.stringify({ ok: true, op: "tool", result: machineAnswer.current }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { path, audits, issued, relayed, machineAnswer, revoked, requests };
}

/** A stored row for an appended event; the fields the audit keeps are the event's own. */
function rowOf(event: AuditEvent, seq: number) {
  return {
    v: 1 as const,
    seq,
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
    prevHash: null,
    hash: "h" + String(seq),
  };
}

/** An event's decision, when it is a result (the contract puts it on `tool.result` only). */
function decisionOf(event: AuditEvent | undefined): AuditDecision | undefined {
  if (event === undefined) return undefined;
  return "decision" in event ? event.decision : undefined;
}

/** The request the agent sends for one call. */
const REQUEST: GrantedCallRequest = { call: CALL, manifest: MANIFEST, bytes: 4096 };

// C7: an allowed call writes tool.call, relays the call with its grant, and writes tool.result.
test("C7: an allowed call is audited around the relay, with its grant", async () => {
  const f = fixture();
  await expect(f.path.state.admitTurn(payloadOf(await snapshot(1)))).resolves.toMatchObject({
    ok: true,
  });
  const outcome = await f.path.relay("run-1", REQUEST);
  expect(outcome).toMatchObject({ ok: true });
  expect(f.issued).toStrictEqual([{ call: { ...CALL, toolId: "read_file" }, runId: "run-1" }]);
  // The relayed body is the granted call: the grant, the call, the manifest, and the policy.
  expect(f.relayed).toHaveLength(1);
  expect(f.relayed[0]?.body).toMatchObject({
    op: "tool",
    authorization: { payload: { grantId: "grant-1" } },
    call: { callId: "tool:1:call-1" },
    manifest: { toolId: "read_file" },
    activePolicy: { revision: 1 },
    bytes: 4096,
  });
  // The request is signed with the control-plane key: a signature header, and a machine route.
  // The relay goes to the machine's configured origin and its one route.
  expect(f.requests[0]?.url).toBe("http://127.0.0.1:8788/rpc");
  expect(f.relayed[0]?.signature).not.toBeNull();
  const rows = f.audits;
  expect(rows.map((row) => row.event)).toStrictEqual(["tool.call", "tool.result"]);
  for (const row of rows) expect(row.grantId).toBe("grant-1");
  expect(rows.at(-1)?.event).toBe("tool.result");
});

// C4: the machine's denial is the recorded decision and the answer the agent gets.
test("C4: a denial from the machine is the decision and the answer", async () => {
  const f = fixture();
  await f.path.state.admitTurn(payloadOf(await snapshot(1)));
  f.machineAnswer.current = { decision: deny("scope_exceeded", "outside the scope") };
  const outcome = await f.path.relay("run-1", REQUEST);
  if (!outcome.ok) throw new Error("the relay should answer");
  expect(outcome.answer.decision).toMatchObject({ outcome: "deny", code: "scope_exceeded" });
  const result = f.audits.at(-1);
  expect(result?.event).toBe("tool.result");
  expect(decisionOf(result)).toMatchObject({ outcome: "deny", code: "scope_exceeded" });
});

// C9: a grant the ledger says is revoked never reaches the machine.
test("C9: a revoked grant is refused before the machine, as grant_revoked", async () => {
  const f = fixture();
  await f.path.state.admitTurn(payloadOf(await snapshot(1)));
  f.revoked.add("grant-1");
  const outcome = await f.path.relay("run-1", REQUEST);
  if (!outcome.ok) throw new Error("the relay should answer");
  expect(outcome.answer.decision).toMatchObject({ outcome: "deny", code: "grant_revoked" });
  expect(f.relayed).toHaveLength(0);
  expect(decisionOf(f.audits.at(-1))).toMatchObject({
    outcome: "deny",
    code: "grant_revoked",
  });
});

// C8: no snapshot means no decision, so nothing is issued or relayed.
test("C8: a turn with no snapshot relays nothing", async () => {
  const f = fixture();
  const outcome = await f.path.relay("run-1", REQUEST);
  expect(outcome).toMatchObject({ ok: false, code: "invalid_request" });
  expect(f.issued).toHaveLength(0);
  expect(f.relayed).toHaveLength(0);
});

// The snapshot must be the revision it names, and it must move forward; the same revision is fine.
test("the snapshot is hash-checked and refuses to move back", async () => {
  const f = fixture();
  const two = await snapshot(2);
  // A document swapped beside its revision number is not that revision.
  expect(await f.path.state.admitTurn(payloadOf({ ...two, hash: "e".repeat(64) }))).toMatchObject({
    ok: false,
    code: "invalid_request",
  });
  expect(await f.path.state.admitTurn(payloadOf(two))).toMatchObject({ ok: true });
  // The same revision again (a retried send) is idempotent.
  expect(await f.path.state.admitTurn(payloadOf(two))).toMatchObject({ ok: true });
  // An older revision is refused.
  expect(await f.path.state.admitTurn(payloadOf(await snapshot(1)))).toMatchObject({
    ok: false,
    code: "epoch_stale",
  });
});

// A run's token belongs to one run, and dies with its run.
test("a run's token is its own, and a closed run relays nothing", async () => {
  const f = fixture();
  const token = f.path.state.mint("run-1");
  expect(token.length).toBeGreaterThan(0);
  expect(f.path.state.check("run-1", token)).toBe(true);
  expect(f.path.state.check("run-2", token)).toBe(false);
  expect(f.path.state.check("run-1", crypto.randomUUID())).toBe(false);
  expect(f.path.state.check("run-1", null)).toBe(false);
  f.path.state.forget("run-1");
  expect(f.path.state.check("run-1", token)).toBe(false);
});
