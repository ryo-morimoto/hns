import { isoTimestamp } from "@hns/core";
import { authorizeCall, digestCall, manifestHash, signingInput } from "@hns/core/capability";
import type { GrantPayload, ToolCall, ToolManifest } from "@hns/core/capability";
import { expect, test } from "vitest";
import { controlPlanePublicKey, grantSigner, supportsGrantAlgorithm } from "./signing.ts";

/**
 * The control-plane signer (0224 C4): Ed25519 signatures that `authorizeCall` verifies, an
 * algorithm swap it refuses, and a `keyId` that identifies the key without giving it away.
 *
 * @remarks
 * These are the real keys and the real WebCrypto: the private half comes from a raw seed the way
 * `HNS_CONTROL_PLANE_KEY` does, the public half is derived exactly as the machine's verifier gets
 * it, and the grant is signed by the production signer. What a fake cannot prove is that the bytes
 * this module produces are the bytes `authorizeCall` checks.
 */

/** The control-plane seed a test uses: 32 distinct bytes, base64url. */
const SEED = Buffer.from(new Uint8Array(32).fill(7)).toString("base64url");

const NOW = new Date("2026-01-01T00:01:00.000Z");

const MANIFEST: ToolManifest = {
  v: 1,
  toolId: "read_file",
  version: "1",
  descriptionHash: "a".repeat(64),
  parametersHash: "b".repeat(64),
  risk: "read",
  outputLimits: { maxBytes: 1024, maxLines: 100 },
};

/** The active policy revision's hash, as the machine's control channel is told it. */
const ACTIVE_HASH = "f".repeat(64);

/** A payload the signer signs; only the fields a test reads vary. */
function payloadOf(overrides: Partial<GrantPayload> = {}): GrantPayload {
  return {
    v: 1,
    grantId: "g1",
    workspaceId: "w1",
    sessionId: "s1",
    machineId: "m1",
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: "c".repeat(64),
    scope: { kind: "read", roots: ["."] },
    issuedAt: isoTimestamp("2026-01-01T00:00:30.000Z"),
    expiresAt: isoTimestamp("2026-01-01T00:01:30.000Z"),
    epoch: 7,
    policyHash: ACTIVE_HASH,
    maxCalls: 10,
    maxBytes: 1024,
    nonce: "n1",
    alg: "Ed25519",
    keyId: "k1",
    ...overrides,
  };
}

/** The production signer over the test seed. */
async function signer() {
  const result = await grantSigner({ seed: SEED });
  if (!result.ok) throw new Error("the test seed produced no signer: " + result.code);
  return result.signer;
}

/** The manifest's hash: what a grant for it must name. */
async function manifestHashOf(manifest: ToolManifest): Promise<string> {
  return await manifestHash(manifest);
}

/** The machine's verifier key: the public half of the same seed. */
async function verifierKey(): Promise<CryptoKey> {
  const raw = await controlPlanePublicKey(SEED);
  if (raw === undefined) throw new Error("the test seed has no public half");
  return await crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "Ed25519" }, false, [
    "verify",
  ]);
}

// Catches: a signer whose bytes the contract's verifier does not accept (a different canonical
// form, a wrong key, a signature encoding the verifier refuses).
test("the control-plane signer produces grants authorizeCall allows", async () => {
  const key = await verifierKey();
  const grant = await signer();
  const manifest = { ...MANIFEST, toolId: "read_file" as const };
  const call: ToolCall = {
    v: 1,
    callId: "tool:1:a",
    toolId: "read_file",
    toolVersion: "1",
    args: { path: "src/a.ts" },
  };
  const payload = payloadOf({
    manifestHash: await manifestHash(manifest),
    keyId: grant.keyId,
  });
  const signed = { payload, signature: await (await signer()).sign(payload) };
  expect(signed.signature).toMatch(/^[\w-]+$/u);
  const decision = await authorizeCall({
    grant: signed,
    call,
    manifest,
    key,
    now: NOW,
    callHash: (await digestCall(call)).callHash,
    activePolicy: { revision: 7, hash: ACTIVE_HASH },
  });
  expect(decision).toMatchObject({ outcome: "allow", grantId: "g1" });
});

// Catches: an algorithm swap that still verifies, or a signer that signs with a second key.
test("a grant whose alg is swapped is grant_algorithm_mismatch", async () => {
  const grant = await signer();
  const payload = payloadOf({ manifestHash: await manifestHashOf(MANIFEST) });
  const signature = await grant.sign(payload);
  const key = await verifierKey();
  const call: ToolCall = {
    v: 1,
    callId: "tool:1:a",
    toolId: "read_file",
    toolVersion: "1",
    args: { path: "a" },
  };
  const decision = await authorizeCall({
    grant: { payload: { ...payload, alg: "ECDSA-P256" }, signature },
    call,
    manifest: MANIFEST,
    key,
    now: NOW,
    callHash: (await digestCall(call)).callHash,
    activePolicy: { revision: 7, hash: ACTIVE_HASH },
  });
  expect(decision).toMatchObject({ outcome: "deny", code: "grant_algorithm_mismatch" });
});

// Catches: a grant signed by something other than the seed (another key, or a signature over other
// bytes) being accepted.
test("a signature over other bytes is grant_invalid", async () => {
  const grant = await signer();
  const payload = payloadOf({ manifestHash: await manifestHashOf(MANIFEST) });
  const signature = await grant.sign({ ...payload, maxCalls: 11 });
  const key = await verifierKey();
  const call: ToolCall = {
    v: 1,
    callId: "tool:1:a",
    toolId: "read_file",
    toolVersion: "1",
    args: { path: "a" },
  };
  const decision = await authorizeCall({
    grant: { payload, signature },
    call,
    manifest: MANIFEST,
    key,
    now: NOW,
    callHash: (await digestCall(call)).callHash,
    activePolicy: { revision: 7, hash: "f".repeat(64) },
  });
  expect(decision).toMatchObject({ outcome: "deny", code: "grant_invalid" });
});

// Catches: a keyId that names the public key (a distribution channel the contract forbids), or one
// that cannot tell two keys apart.
test("the keyId is a fingerprint of the key, stable and distinct per key", async () => {
  const first = await signer();
  const again = await signer();
  const other = await grantSigner({
    seed: Buffer.from(new Uint8Array(32).fill(8)).toString("base64url"),
  });
  if (!other.ok) throw new Error("the second seed produced no signer");
  expect(first.keyId).toBe(again.keyId);
  expect(first.keyId).not.toBe(other.signer.keyId);
  expect(first.keyId).toMatch(/^[0-9a-f]{32}$/u);
  const publicText = Buffer.from((await controlPlanePublicKey(SEED)) ?? new Uint8Array()).toString(
    "base64url",
  );
  expect(first.keyId).not.toContain(publicText);
  expect(first.alg).toBe("Ed25519");
});

// Catches: a missing or malformed secret issuing a grant anyway, instead of failing closed.
test("a seed that is not a 32-byte base64url key is unavailable", async () => {
  for (const seed of [
    "",
    "not base64url!",
    Buffer.from(new Uint8Array(31)).toString("base64url"),
  ]) {
    const result = await grantSigner({ seed });
    expect(result.ok).toBe(false);
    if (result.ok) continue;
    expect(result.code).toBe("unavailable");
    expect(result.message).not.toContain(seed.length === 0 ? "never" : seed);
  }
});

// Catches: a runtime that cannot sign (no Ed25519) reporting support, so a caller would rely on it.
test("the runtime supports Ed25519, or says so honestly", async () => {
  const supported = await supportsGrantAlgorithm("Ed25519");
  // Node 24 and Workers both sign with Ed25519, though Node 24's `SubtleCrypto` type index does not
  // name it: the assertion is that the probe agrees with one that actually signs, not with a table.
  const generated = await globalThis.crypto.subtle
    .generateKey({ name: "Ed25519" }, false, ["sign", "verify"])
    .then(() => true)
    .catch(() => false);
  expect(supported).toBe(generated);
  expect(supported).toBe(true);
  expect(await supportsGrantAlgorithm("ECDSA-P256")).toBe(false);
});

/** The signature is over exactly the contract's signing input, checked by re-signing. */
test("the signature is over JCS(payload)", async () => {
  const grant = await signer();
  const payload = payloadOf();
  const signature = await grant.sign(payload);
  const raw = await controlPlanePublicKey(SEED);
  if (raw === undefined) throw new Error("the test seed has no public half");
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(raw),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const padded = signature.replace(/-/gu, "+").replace(/_/gu, "/");
  const bytes = Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
  expect(
    await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      bytes,
      signingInput({ payload, signature }),
    ),
  ).toBe(true);
});
