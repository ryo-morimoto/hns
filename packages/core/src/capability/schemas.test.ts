import * as v from "valibot";
import { expect, test } from "vitest";
import {
  AuditEventSchema,
  CapabilityAtomSchema,
  CapabilityScopeSchema,
  DenialCodeSchema,
  GrantPayloadSchema,
  PolicyDecisionSchema,
  PolicyDocumentSchema,
  PolicyProposalSchema,
  PolicyRevisionSchema,
  SignedGrantSchema,
  ToolCallSchema,
  ToolManifestSchema,
} from "./schemas.ts";
import { isoTimestamp } from "../codecs.ts";
import type { GrantPayload, PolicyDocument, ToolCall, ToolManifest } from "./types.ts";

const MANIFEST: ToolManifest = {
  v: 1,
  toolId: "read_file",
  version: "1",
  descriptionHash: "a".repeat(64),
  parametersHash: "b".repeat(64),
  risk: "read",
  outputLimits: { maxBytes: 1024, maxLines: 100 },
};

const CALL: ToolCall = {
  v: 1,
  callId: "tool:1:a",
  toolId: "read_file",
  toolVersion: "1",
  args: { path: "a.txt" },
};

const PAYLOAD: GrantPayload = {
  v: 1,
  grantId: "g1",
  workspaceId: "w1",
  sessionId: "s1",
  machineId: "m1",
  toolId: "read_file",
  toolVersion: "1",
  manifestHash: "c".repeat(64),
  scope: { kind: "read", roots: ["."] },
  issuedAt: isoTimestamp("2026-01-01T00:00:00.000Z"),
  expiresAt: isoTimestamp("2026-01-01T00:01:00.000Z"),
  epoch: 3,
  policyHash: "b".repeat(64),
  maxCalls: 1000,
  maxBytes: 4096,
  nonce: "n1",
  alg: "Ed25519",
  keyId: "k1",
};

const DOCUMENT: PolicyDocument = {
  v: 1,
  tools: {
    read_file: {
      enabled: true,
      scope: { kind: "read", roots: ["."] },
      grantTtlSeconds: 60,
      maxCallsPerGrant: 1000,
    },
  },
  egress: { enabled: false, hosts: [] },
};

// Catches: an unknown key being carried along (a field the server adds and the machine ignores), so
// the hashed and signed bytes are not the ones the reader saw.
test("every strict schema rejects an unknown key", () => {
  const cases: ReadonlyArray<readonly [string, v.GenericSchema<unknown, unknown>, unknown]> = [
    ["manifest", ToolManifestSchema, { ...MANIFEST, extra: 1 }],
    [
      "manifest.outputLimits",
      ToolManifestSchema,
      { ...MANIFEST, outputLimits: { maxBytes: 1, maxLines: 1, x: 1 } },
    ],
    ["call", ToolCallSchema, { ...CALL, extra: 1 }],
    ["scope", CapabilityScopeSchema, { kind: "read", roots: ["."], extra: 1 }],
    ["payload", GrantPayloadSchema, { ...PAYLOAD, extra: 1 }],
    ["signedGrant", SignedGrantSchema, { payload: PAYLOAD, signature: "AA", extra: 1 }],
    ["document", PolicyDocumentSchema, { ...DOCUMENT, extra: 1 }],
    [
      "document.tools",
      PolicyDocumentSchema,
      {
        ...DOCUMENT,
        tools: { read_file: DOCUMENT.tools.read_file, bash2: DOCUMENT.tools.read_file },
      },
    ],
    ["egress", PolicyDocumentSchema, { ...DOCUMENT, egress: { enabled: false, hosts: [], x: 1 } }],
    ["atom", CapabilityAtomSchema, { kind: "read", value: "a", x: 1 }],
    [
      "decision.allow",
      PolicyDecisionSchema,
      { outcome: "allow", policyRevision: 1, policyHash: "d".repeat(64), x: 1 },
    ],
  ];
  for (const [name, schema, input] of cases) {
    expect(v.safeParse(schema, input).success, name).toBe(false);
  }
});

// Catches: a wrong type being coerced (a numeric epoch as "3", a boolean as "true").
test("a wrong type is a ValiError", () => {
  expect(() => v.parse(GrantPayloadSchema, { ...PAYLOAD, epoch: "3" })).toThrow(v.ValiError);
  expect(() => v.parse(GrantPayloadSchema, { ...PAYLOAD, maxCalls: -1 })).toThrow(v.ValiError);
  expect(() => v.parse(ToolCallSchema, { ...CALL, toolId: "shell" })).toThrow(v.ValiError);
  expect(() =>
    v.parse(CapabilityScopeSchema, { kind: "exec", network: "all", writable: false }),
  ).toThrow(v.ValiError);
  expect(() =>
    v.parse(PolicyDocumentSchema, {
      ...DOCUMENT,
      tools: { read_file: { ...DOCUMENT.tools.read_file, grantTtlSeconds: 61 } },
    }),
  ).toThrow(v.ValiError);
});

// Catches: a missing field defaulting, so a grant without an epoch or a call without args parses.
test("a missing field is a ValiError", () => {
  const { epoch: _epoch, ...withoutEpoch } = PAYLOAD;
  expect(() => v.parse(GrantPayloadSchema, withoutEpoch)).toThrow(v.ValiError);
  const { args: _args, ...withoutArgs } = CALL;
  expect(() => v.parse(ToolCallSchema, withoutArgs)).toThrow(v.ValiError);
});

// Catches: a hash that is not the lowercase hex this module writes being accepted as one, so two
// spellings of one manifest hash reach a comparison.
test("a hash is 64 lowercase hex characters", () => {
  expect(() =>
    v.parse(ToolManifestSchema, { ...MANIFEST, descriptionHash: "A".repeat(64) }),
  ).toThrow(v.ValiError);
  expect(() =>
    v.parse(ToolManifestSchema, { ...MANIFEST, descriptionHash: "a".repeat(63) }),
  ).toThrow(v.ValiError);
  expect(() => v.parse(SignedGrantSchema, { payload: PAYLOAD, signature: "a b" })).toThrow(
    v.ValiError,
  );
});

// Catches: a scope variant losing its discriminant or a decision variant widening to a free string.
test("scope, atom, and decision variants accept exactly their kinds", () => {
  for (const scope of [
    { kind: "read", roots: ["."] },
    { kind: "write", roots: ["src"] },
    { kind: "exec", network: "none", writable: false },
    { kind: "exact", callHash: "e".repeat(64) },
  ] as const) {
    expect(v.parse(CapabilityScopeSchema, scope)).toStrictEqual(scope);
  }
  expect(v.safeParse(CapabilityScopeSchema, { kind: "admin", roots: ["."] }).success).toBe(false);
  expect(v.safeParse(PolicyDecisionSchema, { outcome: "maybe" }).success).toBe(false);
  expect(v.safeParse(DenialCodeSchema, "nope").success).toBe(false);
});

// Catches: a proposal, revision, or audit event whose optional fields are checked as required (or
// the reverse).
test("a policy revision, proposal, and audit event parse with and without their optional fields", () => {
  const revision = {
    workspaceId: "w1",
    revision: 1,
    hash: "f".repeat(64),
    document: DOCUMENT,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: "human-1",
  };
  expect(v.parse(PolicyRevisionSchema, revision)).toStrictEqual(revision);
  expect(() => v.parse(PolicyRevisionSchema, { ...revision, revision: 0 })).toThrow(v.ValiError);

  const proposal = {
    id: "p1",
    workspaceId: "w1",
    baseRevision: 1,
    baseHash: "f".repeat(64),
    candidate: DOCUMENT,
    candidateHash: "e".repeat(64),
    reviewToken: "d".repeat(64),
    requestedBy: "agent",
    reason: "why",
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  expect(v.parse(PolicyProposalSchema, proposal)).toStrictEqual(proposal);
  expect(
    v.parse(PolicyProposalSchema, { ...proposal, status: "approved", decidedBy: "human-1" }),
  ).toMatchObject({
    status: "approved",
    decidedBy: "human-1",
  });
  expect(v.safeParse(PolicyProposalSchema, { ...proposal, status: "merged" }).success).toBe(false);

  const base = {
    v: 1,
    eventId: "e1",
    at: "2026-01-01T00:00:00.000Z",
    workspaceId: "w1",
    sessionId: "s1",
    callId: "tool:1:a",
    callHash: "1".repeat(64),
    argsHash: "2".repeat(64),
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: "3".repeat(64),
    prevHash: null,
    hash: "4".repeat(64),
  };
  expect(v.parse(AuditEventSchema, { ...base, event: "tool.call" })).toMatchObject({
    event: "tool.call",
  });
  expect(
    v.parse(AuditEventSchema, {
      ...base,
      event: "tool.result",
      decision: { outcome: "allow", policyRevision: 1, policyHash: "5".repeat(64) },
      durationMs: 7,
    }),
  ).toMatchObject({ event: "tool.result", durationMs: 7 });
  expect(v.safeParse(AuditEventSchema, { ...base, event: "tool.result" }).success).toBe(false);
});

// Catches: a refused call's row being unparseable, or an absent hash read as an empty one.
test("an audit event carries the call's hashes, or none when the call was refused", () => {
  const base = {
    v: 1,
    eventId: "e1",
    at: "2026-01-01T00:00:00.000Z",
    workspaceId: "w1",
    sessionId: "s1",
    callId: "tool:1:a",
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: "3".repeat(64),
    prevHash: null,
    hash: "4".repeat(64),
  };
  const callHash = "1".repeat(64);
  const argsHash = "2".repeat(64);
  // A call that was admitted names its hashes.
  expect(
    v.parse(AuditEventSchema, { ...base, callHash, argsHash, event: "tool.call" }),
  ).toMatchObject({
    callHash,
    argsHash,
  });
  // A refused call never became one: the members are absent, not "".
  const refused = v.parse(AuditEventSchema, {
    ...base,
    event: "tool.result",
    decision: { outcome: "deny", code: "path_outside_root", message: "outside" },
    durationMs: 0,
  });
  expect("callHash" in refused).toBe(false);
  expect("argsHash" in refused).toBe(false);
  // A present hash is still a hash: "" and a short value are refused.
  expect(
    v.safeParse(AuditEventSchema, { ...base, callHash: "", argsHash, event: "tool.call" }).success,
  ).toBe(false);
  expect(
    v.safeParse(AuditEventSchema, {
      ...base,
      callHash: "1".repeat(63),
      argsHash,
      event: "tool.call",
    }).success,
  ).toBe(false);
});
