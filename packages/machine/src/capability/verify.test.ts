/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- the attack corpus below builds call args
   as the untrusted records a model sends; the verifier under test is what narrows them. */
import { expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import { digestCall, manifestHash, policyHash, signingInput } from "@hns/core/capability";
import type {
  GrantPayload,
  PolicyDocument,
  SignedGrant,
  ToolCall,
  ToolId,
  ToolManifest,
} from "@hns/core/capability";
import { enrolledGrantKeys } from "./keys.ts";
import type { GrantKeys } from "./keys.ts";
import { verifyGrant } from "./verify.ts";
import type { VerifyGrantInput } from "./verify.ts";

/**
 * The machine verifier against a fixed Ed25519 grant and an attack corpus (C1–C5).
 *
 * @remarks
 * Phase 1 signs `Ed25519` only, and these grants are signed with `node:crypto`'s `KeyObject` the
 * way a control plane would and verified by `crypto.subtle.verify` — the runtime a machine actually
 * has. The attack corpus is the contract's: one byte flipped, another algorithm named, a time before
 * and after the window, an older epoch, another manifest or version, a path outside the root, an
 * exec envelope the grant does not carry, and an `exact` grant for another call. Every one must be a
 * `deny` with the contract's code, and the allowed case is the control that proves the corpus is
 * being tested rather than a verifier that refuses everything.
 */

/** The machine the fixtures run as. */
const MACHINE_ID = "machine-1";

/** The clock every fixture is judged at. */
const NOW = new Date("2026-01-01T00:01:00.000Z");

/** A policy revision's hash, and the revision itself; the grant is issued under it. */
const POLICY_DOCUMENT: PolicyDocument = {
  v: 1,
  tools: {
    read_file: {
      enabled: true,
      scope: { kind: "read", roots: ["."] },
      grantTtlSeconds: 60,
      maxCallsPerGrant: 10,
    },
  },
  egress: { enabled: false, hosts: [] },
};

const READ_MANIFEST: ToolManifest = {
  v: 1,
  toolId: "read_file",
  version: "1",
  descriptionHash: "a".repeat(64),
  parametersHash: "b".repeat(64),
  risk: "read",
  outputLimits: { maxBytes: 1024, maxLines: 100 },
};

const BASH_MANIFEST: ToolManifest = {
  v: 1,
  toolId: "bash",
  version: "1",
  descriptionHash: "a".repeat(64),
  parametersHash: "b".repeat(64),
  risk: "exec",
  outputLimits: { maxBytes: 1024, maxLines: 100 },
};
/** The Ed25519 PKCS#8 prefix, up to the 32-byte seed. */
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** Unpadded base64url of some bytes. */
function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Decode unpadded base64url. */
function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** One control-plane key: the raw public half the machine enrolls, and the half a test signs with. */
interface ControlPlaneKey {
  readonly rawPublicKey: Uint8Array;
  readonly privateKey: CryptoKey;
}

/** A control-plane key pair from a seed, imported the way `HNS_CONTROL_PLANE_KEY` is (0224). */
async function controlPlaneKey(seed: Uint8Array): Promise<ControlPlaneKey> {
  const der = new Uint8Array(PKCS8_PREFIX.byteLength + seed.byteLength);
  der.set(PKCS8_PREFIX);
  der.set(seed, PKCS8_PREFIX.byteLength);
  const extractable = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", extractable);
  if (jwk.x === undefined) throw new Error("the fixture key has no public half");
  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { rawPublicKey: fromBase64Url(jwk.x), privateKey };
}

/** The `keyId` of a raw key, as 0224's `grantSigner` computes it. */
async function keyIdOf(raw: Uint8Array): Promise<string> {
  const { grantKeyId } = await import("./keys.ts");
  return await grantKeyId(raw);
}

/** A policy revision the grant is issued under; its hash is the document's. */
const ACTIVE_POLICY = { revision: 3, hash: "" };

/** What one fixture is built against. */
interface Fixture {
  readonly keys: GrantKeys;
  readonly keyId: string;
  /** The manifest the grant is made for: this machine's read_file contract. */
  readonly manifest: ToolManifest;
  /** Sign one payload with the control plane's private half, as the issuer does. */
  sign(payload: GrantPayload): Promise<SignedGrant>;
}

let fixtureKeys: Fixture | undefined;

/** Build the fixture once: the control-plane key, its `keyId`, and the active policy's hash. */
async function fixture(): Promise<Fixture> {
  if (fixtureKeys !== undefined) return fixtureKeys;
  ACTIVE_POLICY.hash = await policyHash(POLICY_DOCUMENT);
  const key = await controlPlaneKey(new Uint8Array(32).fill(7));
  const built: Fixture = {
    keys: enrolledGrantKeys({ publicKeys: async () => [key.rawPublicKey] }),
    keyId: await keyIdOf(key.rawPublicKey),
    manifest: READ_MANIFEST,
    async sign(payload) {
      const signature = await globalThis.crypto.subtle.sign(
        { name: "Ed25519" },
        key.privateKey,
        signingInput({ payload, signature: "" }),
      );
      return { payload, signature: toBase64Url(signature) };
    },
  };
  fixtureKeys = built;
  return built;
}

/** A payload the fixture's control plane signs; only the fields a test bends are arguments. */
async function payloadOf(overrides: Partial<GrantPayload> = {}): Promise<GrantPayload> {
  const manifestHashValue = await manifestHash(READ_MANIFEST);
  return {
    v: 1,
    grantId: "g1",
    workspaceId: "w1",
    sessionId: "s1",
    machineId: MACHINE_ID,
    toolId: "read_file",
    toolVersion: "1",
    manifestHash: manifestHashValue,
    scope: { kind: "read", roots: ["."] },
    issuedAt: isoTimestamp("2026-01-01T00:00:30.000Z"),
    expiresAt: isoTimestamp("2026-01-01T00:01:30.000Z"),
    epoch: ACTIVE_POLICY.revision,
    policyHash: ACTIVE_POLICY.hash,
    maxCalls: 10,
    maxBytes: 4096,
    nonce: "n1",
    alg: "Ed25519",
    keyId: "",
    ...overrides,
  };
}

/** One call of a tool. */
function callOf(
  toolId: ToolId,
  toolVersion: string,
  args: Readonly<Record<string, unknown>>,
): ToolCall {
  return { v: 1, callId: "tool:1:a", toolId, toolVersion, args };
}

/** What a verification is given; every fixture starts from the allowed case. */
async function inputFor(overrides: {
  readonly grant?: unknown;
  readonly call?: ToolCall;
  readonly manifest?: ToolManifest;
  readonly keys?: GrantKeys;
  readonly now?: Date;
  readonly activePolicy?: { readonly revision: number; readonly hash: string } | undefined;
  readonly lastEpoch?: number;
  readonly revokedGrants?: ReadonlySet<string>;
  readonly machineId?: string;
}): Promise<VerifyGrantInput> {
  const fixed = await fixture();
  const base = overrides.call ?? callOf("read_file", "1", { path: "src/a.ts" });
  return {
    grant: overrides.grant ?? (await fixed.sign(await payloadOf({ keyId: fixed.keyId }))),
    call: base,
    manifest: overrides.manifest ?? fixed.manifest,
    keys: overrides.keys ?? fixed.keys,
    machineId: overrides.machineId ?? MACHINE_ID,
    now: overrides.now ?? NOW,
    activePolicy: "activePolicy" in overrides ? overrides.activePolicy : ACTIVE_POLICY,
    lastEpoch: overrides.lastEpoch,
    revokedGrants: overrides.revokedGrants,
  };
}

/** The code of a refusal, or "allow". */
async function codeOf(input: VerifyGrantInput): Promise<string> {
  const result = await verifyGrant(input);
  return result.decision.outcome === "allow" ? "allow" : result.decision.code;
}

// C1: the control. A grant from the issuer, a call inside it, and the policy it was issued under.
test("C1: a verify grant with a matching call is allowed", async () => {
  const fixed = await fixture();
  const result = await verifyGrant(await inputFor({}));
  expect(result.decision).toStrictEqual({
    outcome: "allow",
    grantId: "g1",
    policyRevision: ACTIVE_POLICY.revision,
    policyHash: ACTIVE_POLICY.hash,
  });
  // The parsed grant comes back with the allow, so a counter can read its bounds from the verified value.
  expect(result.grant?.payload.grantId).toBe("g1");
  expect(result.grant?.payload.maxCalls).toBe(10);
  expect(fixed.keyId).toHaveLength(32);
});

// C2: one byte of the signature changed, and another algorithm named.
test("C2: a forged signature is grant_invalid", async () => {
  const fixed = await fixture();
  const grant = await fixed.sign(await payloadOf({ keyId: fixed.keyId }));
  const bytes = fromBase64Url(grant.signature);
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  expect(await codeOf(await inputFor({ grant: { ...grant, signature: toBase64Url(bytes) } }))).toBe(
    "grant_invalid",
  );
  // A payload changed after signing is the same refusal: the signature is over JCS(payload).
  expect(
    await codeOf(
      await inputFor({ grant: { ...grant, payload: { ...grant.payload, maxCalls: 11 } } }),
    ),
  ).toBe("grant_invalid");
});

test("C2: an algorithm the machine has no key for is grant_algorithm_mismatch", async () => {
  const fixed = await fixture();
  // The grant names another algorithm, but the key that would verify it does not exist here.
  const grant = { ...(await fixed.sign(await payloadOf({ keyId: fixed.keyId }))), signature: "AA" };
  const ecdsa = { ...grant, payload: { ...grant.payload, alg: "ECDSA-P256" as const } };
  expect(await codeOf(await inputFor({ grant: ecdsa }))).toBe("grant_algorithm_mismatch");
});

// C3: the grant's lifetime, and the epoch.
test("C3: a grant past expiresAt is grant_expired", async () => {
  const fixed = await fixture();
  const grant = await fixed.sign(await payloadOf({ keyId: fixed.keyId }));
  expect(await codeOf(await inputFor({ grant, now: new Date("2026-01-01T00:01:30.000Z") }))).toBe(
    "grant_expired",
  );
  expect(await codeOf(await inputFor({ grant, now: new Date("2026-01-01T00:01:29.999Z") }))).toBe(
    "allow",
  );
  // Issued in the future is the same refusal: a machine's clock is part of the check.
  expect(await codeOf(await inputFor({ grant, now: new Date("2026-01-01T00:00:29.999Z") }))).toBe(
    "grant_expired",
  );
});

test("C3: a grant under an older epoch is epoch_stale", async () => {
  const fixed = await fixture();
  const older = await fixed.sign(await payloadOf({ keyId: fixed.keyId, epoch: 2 }));
  expect(await codeOf(await inputFor({ grant: older, lastEpoch: 3 }))).toBe("epoch_stale");
  // The policy the control channel names is newer than the grant's too.
  expect(await codeOf(await inputFor({ grant: older }))).toBe("epoch_stale");
  // The right epoch with another document's hash is the same stale revision.
  const otherDocument = await fixed.sign(
    await payloadOf({ keyId: fixed.keyId, policyHash: "e".repeat(64) }),
  );
  expect(await codeOf(await inputFor({ grant: otherDocument }))).toBe("epoch_stale");
});

// C4: the manifest, tool, and version the grant was made for.
test("C4: another manifest, tool, or version is manifest_mismatch", async () => {
  const fixed = await fixture();
  const grant = await fixed.sign(
    await payloadOf({ keyId: fixed.keyId, manifestHash: await manifestHash(fixed.manifest) }),
  );
  const wider: ToolManifest = { ...READ_MANIFEST, outputLimits: { maxBytes: 4096, maxLines: 100 } };
  expect(await codeOf(await inputFor({ grant, manifest: wider }))).toBe("manifest_mismatch");
  const version = await fixed.sign(await payloadOf({ keyId: fixed.keyId, toolVersion: "2" }));
  expect(await codeOf(await inputFor({ grant: version }))).toBe("manifest_mismatch");
  const bashGrant = await fixed.sign(await payloadOf({ keyId: fixed.keyId, toolId: "bash" }));
  expect(
    await codeOf(
      await inputFor({
        grant: bashGrant,
        call: callOf("bash", "1", { command: "true", envelope: { network: "none" } }),
        manifest: BASH_MANIFEST,
      }),
    ),
  ).toBe("manifest_mismatch");
});

// C5: the scope's envelope: a path outside the root, an exec envelope, and an exact call hash.
test("C5: a call outside the grant's scope is scope_exceeded or its own code", async () => {
  const fixed = await fixture();
  const readGrant = await fixed.sign(await payloadOf({ keyId: fixed.keyId }));
  expect(
    await codeOf(
      await inputFor({ grant: readGrant, call: callOf("read_file", "1", { path: "../x" }) }),
    ),
  ).toBe("unsupported");
  const rooted = await fixed.sign(
    await payloadOf({ keyId: fixed.keyId, scope: { kind: "read", roots: ["src"] } }),
  );
  expect(
    await codeOf(
      await inputFor({ grant: rooted, call: callOf("read_file", "1", { path: "docs/a.md" }) }),
    ),
  ).toBe("path_outside_root");
  // bash: the grant's envelope is network none, writable false.
  const bashGrant = await fixed.sign(
    await payloadOf({
      keyId: fixed.keyId,
      toolId: "bash",
      manifestHash: await manifestHash(BASH_MANIFEST),
      scope: { kind: "exec", network: "none", writable: false },
    }),
  );
  const exec = async (envelope: Readonly<Record<string, unknown>>) =>
    await codeOf(
      await inputFor({
        grant: bashGrant,
        call: callOf("bash", "1", { command: "true", envelope }),
        manifest: BASH_MANIFEST,
      }),
    );
  expect(await exec({ network: "none" })).toBe("allow");
  expect(await exec({ network: "proxy" })).toBe("egress_denied");
  expect(await exec({ writable: true })).toBe("command_not_allowed");
  // exact: the grant is for one callHash.
  const exactCall = callOf("read_file", "1", { path: "src/a.ts" });
  const exactHash = (await digestCall(exactCall)).callHash;
  const exactGrant = await fixed.sign(
    await payloadOf({ keyId: fixed.keyId, scope: { kind: "exact", callHash: exactHash } }),
  );
  expect(await codeOf(await inputFor({ grant: exactGrant, call: exactCall }))).toBe("allow");
  expect(
    await codeOf(
      await inputFor({ grant: exactGrant, call: callOf("read_file", "1", { path: "src/b.ts" }) }),
    ),
  ).toBe("scope_exceeded");
});

// The machine's own rules, which the contract's shared verifier does not carry.
test("a grant addressed to another machine is grant_invalid", async () => {
  const fixed = await fixture();
  const grant = await fixed.sign(await payloadOf({ keyId: fixed.keyId, machineId: "machine-2" }));
  expect(await codeOf(await inputFor({ grant }))).toBe("grant_invalid");
});

test("a machine with no key for the grant's keyId refuses it", async () => {
  const fixed = await fixture();
  const other = await controlPlaneKey(new Uint8Array(32).fill(8));
  const grant = await fixed.sign(await payloadOf({ keyId: await keyIdOf(other.rawPublicKey) }));
  expect(await codeOf(await inputFor({ grant }))).toBe("grant_invalid");
  // An empty enrollment answers nothing, which refuses every grant.
  expect(
    await codeOf(
      await inputFor({
        grant: await fixed.sign(await payloadOf({ keyId: fixed.keyId })),
        keys: enrolledGrantKeys({ publicKeys: async () => [] }),
      }),
    ),
  ).toBe("grant_invalid");
});

test("without an active policy revision nothing is allowed", async () => {
  const fixed = await fixture();
  const grant = await fixed.sign(await payloadOf({ keyId: fixed.keyId }));
  expect(await codeOf(await inputFor({ grant, activePolicy: undefined }))).toBe("policy_denied");
});

test("a revoked grant is grant_revoked, not grant_expired", async () => {
  const fixed = await fixture();
  const grant = await fixed.sign(await payloadOf({ keyId: fixed.keyId }));
  // Revoked and expired: the revocation is the fact the audit must read.
  const late = new Date("2026-01-01T00:02:00.000Z");
  expect(await codeOf(await inputFor({ grant, now: late, revokedGrants: new Set(["g1"]) }))).toBe(
    "grant_revoked",
  );
});

test("a grant that is not a signed grant is grant_invalid", async () => {
  expect(await codeOf(await inputFor({ grant: { payload: {}, signature: "AA" } }))).toBe(
    "grant_invalid",
  );
  const fixed = await fixture();
  const grant = await fixed.sign(await payloadOf({ keyId: fixed.keyId }));
  // An unknown key (a field the server adds and the machine ignores) is not this contract's grant.
  expect(
    await codeOf(await inputFor({ grant: { ...grant, payload: { ...grant.payload, extra: 1 } } })),
  ).toBe("grant_invalid");
});
