import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import { canonicalize, manifestHash } from "@hns/core/capability";
import type { GrantPayload, SignedGrant, ToolCall, ToolManifest } from "@hns/core/capability";
import type { GrantedCallPayload } from "@hns/workspace/protocol";
import { GrantCounter } from "../../src/capability/counter.ts";
import { enrolledGrantKeys, grantKeyId } from "../../src/capability/keys.ts";
import { runGrantedCall, type GrantedCallOutcome } from "../../src/granted.ts";
import { resolveLimits } from "../../src/limits.ts";

/**
 * The granted call's refusals, each the case a skipped check would let through (0226).
 *
 * @remarks
 * Each test presents the machine with the one input an implementation that forgot a check would
 * run, and fixes that the product refuses it and runs nothing:
 *
 * 1. **no grant at all** — a request with no authorization: refused `grant_invalid`.
 * 2. **no active policy presented** — the control channel gave the machine nothing: refused
 *    `policy_denied` (fail closed), so an allow is never recorded against no revision.
 * 3. **a revoked grant** — inside its life but revoked by its issuer: refused `grant_revoked`.
 *
 * The grant is the production shape, signed by the test's own Ed25519 key (a machine enrolls its
 * public half), so the only difference between an allowed call and each refusal is the check.
 */

/** The machine's response bounds, as a machine's agent resolves them. */
const LIMITS = resolveLimits({});

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
  callId: "tool:1:probe",
  toolId: "read_file",
  toolVersion: "1",
  args: { path: "a.txt" },
};

/** The machine's key pair: the signer for the fixture grant and the enrolled public half. */
async function machineKeys() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
  const raw: Uint8Array<ArrayBuffer> = new Uint8Array(exported);
  const sign = async (bytes: Uint8Array): Promise<string> => {
    // A fresh ArrayBuffer-backed view: WebCrypto's BufferSource does not take a typed array over an
    // ArrayBufferLike storage.
    const message = new Uint8Array(bytes.byteLength);
    message.set(bytes);
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message);
    return Buffer.from(new Uint8Array(signature)).toString("base64url");
  };
  return {
    sign,
    keyId: await grantKeyId(raw),
    keys: enrolledGrantKeys({ publicKeys: async () => [raw] }),
  };
}

/** A signed grant for the fixture's call, over the root. */
async function signedGrant(
  sign: (bytes: Uint8Array) => Promise<string>,
  keyId: string,
): Promise<SignedGrant> {
  const now = Date.now();
  const payload: GrantPayload = {
    v: 1,
    grantId: "grant-probe",
    workspaceId: "w1",
    sessionId: "s1",
    machineId: "m1",
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: await manifestHash(MANIFEST),
    scope: { kind: "read", roots: ["."] },
    issuedAt: isoTimestamp(new Date(now - 5_000).toISOString()),
    expiresAt: isoTimestamp(new Date(now + 55_000).toISOString()),
    epoch: 1,
    policyHash: "c".repeat(64),
    maxCalls: 10,
    maxBytes: 4096,
    nonce: "n1",
    alg: "Ed25519",
    keyId,
  };
  return { payload, signature: await sign(new TextEncoder().encode(canonicalize(payload))) };
}

/** One call the product runs, and the fixture a probe builds its requests from. */
interface Fixture {
  readonly root: string;
  readonly grant: SignedGrant;
  readonly keys: ReturnType<typeof enrolledGrantKeys>;
  readonly counter: GrantCounter;
}

/** Run one probe against a fresh ROOT, key, and counter. */
async function withFixture<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "hns-granted-probe-"));
  try {
    const root = join(base, "root");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "a.txt"), "v1", "utf8");
    const { sign, keyId, keys } = await machineKeys();
    return await run({
      root,
      grant: await signedGrant(sign, keyId),
      keys,
      counter: new GrantCounter(join(base, "grants")),
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

/** The request members a probe keeps: the call, the manifest, the policy, and the bytes. */
// oxlint-disable-next-line anti-slop/no-known-value-widening -- the wire's members, named here so a
// probe can drop one.
function body(): ProbedCall {
  return {
    op: "tool",
    call: CALL,
    manifest: MANIFEST,
    activePolicy: { revision: 1, hash: "c".repeat(64) },
    bytes: 1024,
  };
}

/** The production request: the body above with the grant the issuer signed. */
function request(grant: SignedGrant): GrantedCallPayload {
  return { ...body(), authorization: grant };
}

/**
 * A call body as the wire carries it: its members are checked by the machine, so a probe can
 * present one that lacks a member the product's own type would promise.
 */
type ProbedCall = GrantedCallPayload;

/** The production call, on the fixture. */
async function productCall(
  fixture: Fixture,
  revokedGrants?: ReadonlySet<string>,
): Promise<GrantedCallOutcome> {
  return await runGrantedCall({
    request: request(fixture.grant),
    keys: fixture.keys,
    counter: fixture.counter,
    machineId: "m1",
    now: new Date(),
    root: fixture.root,
    identity: undefined,
    signal: new AbortController().signal,
    limits: LIMITS,
    exec: { ready: false, reason: "no shell in this probe" },
    revokedGrants,
  });
}

// The product's path allows the fixture's call: the refusals below are about what it stops.
test("the product's path allows the fixture's call", async () => {
  await withFixture(async (fixture) => {
    const outcome = await productCall(fixture);
    if (outcome.kind === "denied") throw new Error(JSON.stringify(outcome.decision));
    expect(outcome.kind).toBe("allowed");
    // The machine read the file: a refusal would have left it unread and the counter unspent.
    expect(await fixture.counter.read(fixture.grant.payload.grantId)).toMatchObject({ calls: 1 });
  });
});

// A call presented with no grant at all is refused, and nothing runs.
test("a call without a grant is refused and runs nothing", async () => {
  await withFixture(async (fixture) => {
    // The body as a machine would receive it from an implementation that forgot to ask: no grant.
    const probed: ProbedCall = body();
    const outcome = await runGrantedCall({
      request: probed,
      keys: fixture.keys,
      counter: fixture.counter,
      machineId: "m1",
      now: new Date(),
      root: fixture.root,
      identity: undefined,
      signal: new AbortController().signal,
      limits: LIMITS,
      exec: { ready: false, reason: "no shell in this probe" },
    });
    expect(outcome.kind).toBe("denied");
    expect(outcome.decision).toMatchObject({ outcome: "deny", code: "grant_invalid" });
    expect(await fixture.counter.read(fixture.grant.payload.grantId)).toBeUndefined();
  });
});

// A grant presented with no active policy is refused (fail closed), and nothing runs.
test("a grant with no active policy presented is refused, and runs nothing", async () => {
  await withFixture(async (fixture) => {
    const whole = body();
    const probed: ProbedCall = {
      op: whole.op,
      call: whole.call,
      manifest: whole.manifest,
      bytes: whole.bytes,
      authorization: fixture.grant,
    };
    const outcome = await runGrantedCall({
      request: probed,
      keys: fixture.keys,
      counter: fixture.counter,
      machineId: "m1",
      now: new Date(),
      root: fixture.root,
      identity: undefined,
      signal: new AbortController().signal,
      limits: LIMITS,
      exec: { ready: false, reason: "no shell in this probe" },
    });
    expect(outcome.kind).toBe("denied");
    expect(outcome.decision).toMatchObject({ outcome: "deny", code: "policy_denied" });
    expect(await fixture.counter.read(fixture.grant.payload.grantId)).toBeUndefined();
  });
});

// A grant its issuer revoked is refused inside its life, and nothing runs.
test("a revoked grant is refused and runs nothing", async () => {
  await withFixture(async (fixture) => {
    const outcome = await productCall(fixture, new Set([fixture.grant.payload.grantId]));
    expect(outcome.kind).toBe("denied");
    expect(outcome.decision).toMatchObject({ outcome: "deny", code: "grant_revoked" });
    expect(await fixture.counter.read(fixture.grant.payload.grantId)).toBeUndefined();
  });
});
