import { authorizeCall, digestCall, manifestHash, policyHash } from "@hns/core/capability";
import type {
  GrantPayload,
  PolicyDocument,
  SignedGrant,
  ToolCall,
  ToolManifest,
} from "@hns/core/capability";
import * as v from "valibot";
import { expect, test } from "vitest";
import { controlPlanePublicKey, grantSigner, type GrantSigner } from "../capability/signing.ts";
import type { GrantRecord } from "./grant-ledger.ts";
import {
  PolicySnapshotSchema,
  createGrantPlane,
  issueGrant,
  type GrantAttempt,
  type GrantIssue,
  type GrantRecorder,
} from "./session-grants.ts";

/**
 * The grant issuer (0224 C1–C3, C5–C7) with the real control-plane signer.
 *
 * @remarks
 * The signer is the production one over a raw seed (the keys C4 proves), so the signatures here are
 * the ones a machine verifies and the only fake is the recorder. Every assertion about "no grant"
 * reads the returned denial **and** the recorder's writes: a refusal that still wrote a grant would
 * pass a check of the return value alone.
 */

/** 32 bytes, base64url: the control-plane seed. */
const SEED = Buffer.from(new Uint8Array(32).fill(3)).toString("base64url");

const NOW = new Date("2026-11-18T00:00:00.000Z");

const READ_MANIFEST: ToolManifest = {
  v: 1,
  toolId: "read_file",
  version: "1",
  descriptionHash: "a".repeat(64),
  parametersHash: "b".repeat(64),
  risk: "read",
  outputLimits: { maxBytes: 256 * 1024, maxLines: 40_000 },
};

const BASH_MANIFEST: ToolManifest = {
  ...READ_MANIFEST,
  toolId: "bash",
  risk: "exec",
  outputLimits: { maxBytes: 50 * 1024, maxLines: 2_000 },
};

/** The default policy: read and write over the root, no bash, no egress. */
function policyDocument(overrides: Partial<PolicyDocument> = {}): PolicyDocument {
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
    ...overrides,
  };
}

/** A snapshot of the document at `revision`, with its real hash. */
async function snapshotOf(document: PolicyDocument, revision = 7) {
  return { revision, hash: await policyHash(document), document };
}

/** A request for one tool, with the real manifest hash; a test varies its members. */
type RequestOverrides = Partial<{
  workspaceId: string;
  toolId: string;
  toolVersion: string;
  manifestHash: string;
  maxBytes: number;
}>;

/** The request the issuer is given. */
export interface TestRequest {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly machineId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly manifestHash: string;
  readonly maxBytes: number;
}

async function requestOf(overrides: RequestOverrides = {}): Promise<TestRequest> {
  return {
    workspaceId: "w1",
    sessionId: "s1",
    machineId: "m1",
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: await manifestHash(READ_MANIFEST),
    maxBytes: 4096,
    ...overrides,
  };
}

/** The control-plane signer over the test seed. */
async function testSigner(): Promise<GrantSigner> {
  const result = await grantSigner({ seed: SEED });
  if (!result.ok) throw new Error("the test seed produced no signer");
  return result.signer;
}

const signer = await testSigner();

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type --
   These helpers pass deliberately ill-typed bodies to the issuer (the C7 rule) and operation arguments
   as the untrusted records a model sends; the issuer parses both. */
/** A call's arguments, as the contract's untrusted record. */
type TestArgs = Readonly<Record<string, unknown>>;

/** Issue one grant against `document` at `revision`, with the test clock. */
async function issue(
  request: unknown,
  document: PolicyDocument = policyDocument(),
  revision = 7,
  manifests: readonly ToolManifest[] = [READ_MANIFEST, BASH_MANIFEST],
) {
  return await issueGrant(
    { request, snapshot: await snapshotOf(document, revision), now: () => NOW.getTime(), signer },
    manifests,
  );
}

/** The manifest whose hash is the grant's. */
function manifestOfGrant(payload: GrantPayload): ToolManifest {
  const found = [READ_MANIFEST, BASH_MANIFEST].find(
    (manifest) => manifest.toolId === payload.toolId && manifest.version === payload.toolVersion,
  );
  if (found === undefined) throw new Error("no manifest for the grant");
  return found;
}

/** The machine's verifier key: the public half of the test seed. */
async function verifierKey(): Promise<CryptoKey> {
  const raw = await controlPlanePublicKey(SEED);
  if (raw === undefined) throw new Error("no public half");
  return await crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "Ed25519" }, false, [
    "verify",
  ]);
}

/** Run the contract's verifier over a grant the way a machine does. */
async function authorize(grant: SignedGrant, args: TestArgs) {
  const call: ToolCall = {
    v: 1,
    callId: "tool:1:a",
    toolId: grant.payload.toolId,
    toolVersion: grant.payload.toolVersion,
    args,
  };
  return await authorizeCall({
    grant,
    call,
    manifest: manifestOfGrant(grant.payload),
    key: await verifierKey(),
    now: new Date(NOW.getTime() + 1000),
    callHash: (await digestCall(call)).callHash,
    activePolicy: { revision: grant.payload.epoch, hash: grant.payload.policyHash },
  });
}

/** The code a refusal carries; "issued" when it was not one. */
function codeOf(result: GrantIssue): string {
  return result.ok ? "issued" : result.decision.code;
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

// C1: the default policy's read_file grant signs, verifies, and carries the policy's scope.
test("C1: a read_file grant under the default policy verifies and carries the read root", async () => {
  const issued = await issue(await requestOf());
  if (!issued.ok) throw new Error("refused: " + issued.decision.code);
  const payload = issued.grant.payload;
  expect(payload.scope).toStrictEqual({ kind: "read", roots: ["."] });
  expect(payload.epoch).toBe(7);
  expect(payload.maxCalls).toBe(10);
  expect(payload.maxBytes).toBe(4096);
  expect(payload.alg).toBe("Ed25519");
  expect(payload.keyId).toBe(signer.keyId);
  expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(60_000);
  expect(await authorize(issued.grant, { path: "src/a.ts" })).toMatchObject({ outcome: "allow" });
  // The policy's scope is what bounds the call: a path outside every root is refused.
  expect(await authorize(issued.grant, { path: "../etc/passwd" })).toMatchObject({
    outcome: "deny",
    code: "unsupported",
  });
});

// C2: a tool the policy turned off is refused, and nothing is issued.
test("C2: bash in a policy without bash is tool_disabled", async () => {
  const issued = await issue(
    await requestOf({ toolId: "bash", manifestHash: await manifestHash(BASH_MANIFEST) }),
  );
  expect(codeOf(issued)).toBe("tool_disabled");
  expect(issued.ok ? undefined : issued.decision.policyRevision).toBe(7);
  // A request naming a tool the revision does not carry at all is refused the same way.
  const absent = await issue(await requestOf({ toolId: "bash", manifestHash: "c".repeat(64) }));
  expect(codeOf(absent)).toBe("tool_disabled");
});

// C3: the grant is for the request's manifest, not another one.
test("C3: a request with another tool's manifestHash is manifest_mismatch", async () => {
  const otherTool = await issue(
    await requestOf({ manifestHash: await manifestHash(BASH_MANIFEST) }),
  );
  expect(codeOf(otherTool)).toBe("manifest_mismatch");
  const unknown = await issue(await requestOf({ manifestHash: "d".repeat(64) }));
  expect(codeOf(unknown)).toBe("manifest_mismatch");
  // The same tool at another version is another contract.
  const version = await issue(await requestOf({ toolVersion: "2" }));
  expect(codeOf(version)).toBe("manifest_mismatch");
});

// The Worker carries no tool table: a request with no version is answered with the one the
// contracts declare, and the same request with it is issued.
test("a request with no tool version is answered with the version its contracts declare", async () => {
  const manifest = await manifestHash(BASH_MANIFEST);
  const bashPolicy = policyDocument({
    tools: {
      read_file: {
        enabled: true,
        scope: { kind: "read", roots: ["."] },
        grantTtlSeconds: 60,
        maxCallsPerGrant: 10,
      },
      bash: {
        enabled: true,
        scope: { kind: "exec", network: "none", writable: false },
        grantTtlSeconds: 60,
        maxCallsPerGrant: 10,
      },
    },
  });
  const missing = await issue(
    await requestOf({ toolId: "bash", manifestHash: manifest, toolVersion: "" }),
    bashPolicy,
  );
  expect(missing.ok).toBe(false);
  if (missing.ok) return;
  expect(missing.decision.code).toBe("grant_invalid");
  expect(missing.toolVersion).toBe(BASH_MANIFEST.version);
  const hinted = await issue(
    await requestOf({
      toolId: "bash",
      manifestHash: manifest,
      toolVersion: missing.toolVersion ?? "",
    }),
    bashPolicy,
  );
  expect(hinted.ok).toBe(true);
});

// C5: the epoch is the snapshot's revision, whatever the other numbers are.
test("C5: epoch is the snapshot's revision", async () => {
  for (const revision of [1, 2, 99]) {
    const issued = await issue(await requestOf(), policyDocument(), revision);
    if (!issued.ok) throw new Error("refused: " + issued.decision.code);
    expect(issued.grant.payload.epoch).toBe(revision);
  }
});

// C6: two requests with the same body are two grants.
test("C6: the same request twice gets a different grantId and nonce", async () => {
  const request = await requestOf();
  const first = await issue(request);
  const second = await issue(request);
  if (!first.ok || !second.ok) throw new Error("refused");
  expect(first.grant.payload.grantId).not.toBe(second.grant.payload.grantId);
  expect(first.grant.payload.nonce).not.toBe(second.grant.payload.nonce);
  expect(first.grant.payload.grantId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

// C7: a body that is not a request issues nothing.
test("C7: a malformed request is refused and no grant exists", async () => {
  const valid = await requestOf();
  const invalid: TestRequest & { readonly extra?: number } = { ...valid, extra: 1 };
  const emptyMachine: TestRequest = { ...valid, machineId: "" };
  const negative: TestRequest = { ...valid, maxBytes: -1 };
  const unknownTool: TestRequest = { ...valid, toolId: "exec" };
  const badHash: TestRequest = { ...valid, manifestHash: "nothex" };
  const bodies: readonly unknown[] = [
    {},
    emptyMachine,
    invalid,
    negative,
    unknownTool,
    badHash,
    null,
    [],
    "request",
  ];
  for (const body of bodies) expect(codeOf(await issue(body))).toBe("grant_invalid");
  // A snapshot that is not one, or is not the revision it names, issues nothing either.
  const wrongHash = await issueGrant(
    {
      request: valid,
      snapshot: { revision: 7, hash: "e".repeat(64), document: policyDocument() },
      now: () => NOW.getTime(),
      signer,
    },
    [READ_MANIFEST],
  );
  expect(codeOf(wrongHash)).toBe("grant_invalid");
  const wider = policyDocument({ egress: { enabled: true, hosts: [{ host: "x", port: 1 }] } });
  const swapped = await issueGrant(
    {
      request: valid,
      snapshot: { revision: 7, hash: await policyHash(policyDocument()), document: wider },
      now: () => NOW.getTime(),
      signer,
    },
    [READ_MANIFEST],
  );
  expect(codeOf(swapped)).toBe("grant_invalid");
});

// NB1: the issuer verifies its own signature before it answers. A signer whose signature its own
// key does not accept is a defect, and a grant that fails it is withheld.
test("a signer whose signature does not verify issues no grant", async () => {
  const lying: GrantSigner = {
    alg: signer.alg,
    keyId: signer.keyId,
    sign: (payload) => signer.sign(payload),
    verify: async () => false,
  };
  const issued = await issueGrant(
    {
      request: await requestOf(),
      snapshot: await snapshotOf(policyDocument()),
      now: () => NOW.getTime(),
      signer: lying,
    },
    [READ_MANIFEST, BASH_MANIFEST],
  );
  expect(issued.ok).toBe(false);
  if (issued.ok) return;
  expect(issued.decision.code).toBe("grant_invalid");
  // A signer that throws rather than answering is the same refusal, not a thrown request.
  const failing: GrantSigner = {
    alg: signer.alg,
    keyId: signer.keyId,
    sign: async () => {
      throw new Error("no key");
    },
    verify: async () => true,
  };
  const thrown = await issueGrant(
    {
      request: await requestOf(),
      snapshot: await snapshotOf(policyDocument()),
      now: () => NOW.getTime(),
      signer: failing,
    },
    [READ_MANIFEST],
  );
  expect(thrown.ok ? "issued" : thrown.decision.code).toBe("grant_invalid");
});

// NB2: a request can only lower the manifest's output bound, never raise it.
test("a maxBytes above the manifest's bound is clamped to it", async () => {
  const issued = await issue(await requestOf({ maxBytes: 999_999_999 }));
  if (!issued.ok) throw new Error("refused: " + issued.decision.code);
  expect(issued.grant.payload.maxBytes).toBe(READ_MANIFEST.outputLimits.maxBytes);
  const lowered = await issue(await requestOf({ maxBytes: 1_024 }));
  if (!lowered.ok) throw new Error("refused: " + lowered.decision.code);
  expect(lowered.grant.payload.maxBytes).toBe(1_024);
});

// NB3: a caller that does not care about the byte bound does not send one, and gets the manifest's.
test("an absent maxBytes is the manifest's own bound", async () => {
  const request = await requestOf();
  const { maxBytes: _maxBytes, ...withoutBound } = request;
  const issued = await issue(withoutBound);
  if (!issued.ok) throw new Error("refused: " + issued.decision.code);
  expect(issued.grant.payload.maxBytes).toBe(READ_MANIFEST.outputLimits.maxBytes);
});

// The bounds: an exact scope, an empty byte bound, an algorithm the signer is not, a scope that
// does not fit its tool.
test("an exact scope is unsupported, an empty bound issues nothing, and alg is the signer's", async () => {
  const exact = policyDocument({
    tools: {
      read_file: {
        enabled: true,
        scope: { kind: "exact", callHash: "f".repeat(64) },
        grantTtlSeconds: 60,
        maxCallsPerGrant: 1,
      },
    },
  });
  expect(codeOf(await issue(await requestOf(), exact))).toBe("unsupported");
  expect(codeOf(await issue(await requestOf({ maxBytes: 0 })))).toBe("grant_invalid");
  const request = await requestOf();
  const ecdsa = await issueGrant(
    {
      request,
      snapshot: await snapshotOf(policyDocument()),
      now: () => NOW.getTime(),
      signer,
      algorithm: "ECDSA-P256",
    },
    [READ_MANIFEST],
  );
  expect(codeOf(ecdsa)).toBe("grant_algorithm_mismatch");
  // A policy pairing a file tool with an exec scope can never allow a call: no grant.
  const paired = policyDocument({
    tools: {
      read_file: {
        enabled: true,
        scope: { kind: "exec", network: "none", writable: false },
        grantTtlSeconds: 60,
        maxCallsPerGrant: 1,
      },
    },
  });
  expect(codeOf(await issue(request, paired))).toBe("unsupported");
});

// The snapshot schema is strict: an unknown key is refused rather than ignored.
test("the snapshot schema is strict", async () => {
  const snapshot = await snapshotOf(policyDocument());
  expect(v.safeParse(PolicySnapshotSchema, { ...snapshot, extra: 1 }).success).toBe(false);
  expect(v.safeParse(PolicySnapshotSchema, snapshot).success).toBe(true);
});

// NB6: a revocation that throws is named and recorded, never swallowed, and the other grants of the
// run are still revoked.
test("a revocation that fails is recorded as grant.revoke_failed", async () => {
  const recorded: string[] = [];
  const attempts: GrantAttempt[] = [];
  const stored: GrantRecord[] = [];
  const recorder: GrantRecorder = {
    async record(attempt) {
      attempts.push(attempt);
      if (!attempt.issue.ok) return undefined;
      const payload = attempt.issue.grant.payload;
      stored.push({
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
      });
      return stored[stored.length - 1];
    },
    async revoke() {
      throw new Error("the ledger is gone");
    },
    async boundTo(runId) {
      return stored.filter(
        (record) => record.requestedBy.runId === runId && record.revokedAt === undefined,
      );
    },
    async lastFor(runId) {
      return stored.findLast((record) => record.requestedBy.runId === runId);
    },
    async recordRevokeFailure(attempt) {
      recorded.push(
        "grant.revoke_failed:" +
          String(attempt.issue.ok ? undefined : attempt.issue.request?.manifestHash),
      );
    },
  };
  const plane = createGrantPlane({
    signer,
    recorder,
    workspaceId: "w1",
    sessionId: "s1",
    now: () => NOW.getTime(),
    eventId: () => crypto.randomUUID(),
  });
  const issued = await plane.request({
    request: await requestOf(),
    snapshot: await snapshotOf(policyDocument()),
    requestedBy: { kind: "agent", id: "agent:1", runId: "9" },
    manifests: [READ_MANIFEST],
  });
  if (!issued.ok) throw new Error("refused");
  const outcome = await plane.revokeRun("9");
  expect(outcome.revoked).toStrictEqual([]);
  expect(outcome.failed).toStrictEqual([issued.grant.payload.grantId]);
  expect(recorded).toStrictEqual(["grant.revoke_failed:" + issued.grant.payload.manifestHash]);
});

// The plane: what it records, and what a run's end revokes.
test("the plane records every attempt and revokes a run's grants when the run ends", async () => {
  const attempts: GrantAttempt[] = [];
  const stored: GrantRecord[] = [];
  const recorder: GrantRecorder = {
    async record(attempt) {
      attempts.push(attempt);
      if (!attempt.issue.ok) return undefined;
      const payload = attempt.issue.grant.payload;
      const record: GrantRecord = {
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
      stored.push(record);
      return record;
    },
    async revoke(grantId, at) {
      const index = stored.findIndex((record) => record.grantId === grantId);
      const found = stored[index];
      if (found === undefined || found.revokedAt !== undefined) return false;
      stored[index] = { ...found, revokedAt: at };
      return true;
    },
    async boundTo(runId) {
      return stored.filter(
        (record) => record.requestedBy.runId === runId && record.revokedAt === undefined,
      );
    },
    async lastFor(runId) {
      return stored.findLast((record) => record.requestedBy.runId === runId);
    },
    async recordRevokeFailure() {},
  };
  const plane = createGrantPlane({
    signer,
    recorder,
    workspaceId: "w1",
    sessionId: "s1",
    now: () => NOW.getTime(),
    eventId: () => crypto.randomUUID(),
  });
  const request = await requestOf();
  const run = await plane.request({
    request,
    snapshot: await snapshotOf(policyDocument()),
    requestedBy: { kind: "agent", id: "agent:1", runId: "12" },
    manifests: [READ_MANIFEST],
  });
  const refused = await plane.request({
    request: { ...request, toolId: "bash" },
    snapshot: await snapshotOf(policyDocument()),
    requestedBy: { kind: "agent", id: "agent:1", runId: "12" },
    manifests: [READ_MANIFEST, BASH_MANIFEST],
  });
  expect(refused.ok).toBe(false);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.issue.ok).toBe(false);
  if (!run.ok) throw new Error("refused");
  expect(await plane.boundTo("12")).toHaveLength(1);
  const revoked = await plane.revokeRun("12");
  expect(revoked).toStrictEqual({ revoked: [run.grant.payload.grantId], failed: [] });
  expect(await plane.revokeRun("12")).toStrictEqual({ revoked: [], failed: [] });
  // The revoked grant is refused as revoked, not as expired, by the contract's verifier.
  const call: ToolCall = {
    v: 1,
    callId: "tool:1:a",
    toolId: "read_file",
    toolVersion: "1",
    args: { path: "a" },
  };
  expect(
    await authorizeCall({
      grant: run.grant,
      call,
      manifest: READ_MANIFEST,
      key: await verifierKey(),
      now: new Date(NOW.getTime() + 1000),
      callHash: (await digestCall(call)).callHash,
      revokedGrants: new Set(revoked.revoked),
      activePolicy: { revision: 7, hash: "f".repeat(64) },
    }),
  ).toMatchObject({ outcome: "deny", code: "grant_revoked" });
});
