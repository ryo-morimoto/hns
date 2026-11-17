/* oxlint-disable anti-slop/no-unsafe-dictionary-type -- the fixtures build call args and envelope values
   as the untrusted records a model sends; the verifier under test is what narrows them. */
import { expect, test } from "vitest";
import { digestCall, manifestHash, signingInput } from "./canonical.ts";
import { authorizeCall } from "./grant.ts";
import type { AuthorizeCallInput } from "./grant.ts";
import { isoTimestamp } from "../codecs.ts";
import type {
  CapabilityScope,
  GrantAlgorithm,
  SignedGrant,
  ToolCall,
  ToolManifest,
} from "./types.ts";

const NOW = new Date("2026-01-01T00:01:00.000Z");
const ACTIVE = { revision: 7, hash: "f".repeat(64) };

const MANIFEST: ToolManifest = {
  v: 1,
  toolId: "read_file",
  version: "1",
  descriptionHash: "a".repeat(64),
  parametersHash: "b".repeat(64),
  risk: "read",
  outputLimits: { maxBytes: 1024, maxLines: 100 },
};

interface Keys {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

async function ed25519Keys(): Promise<Keys> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

async function p256Keys(): Promise<Keys> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

function base64Url(bytes: ArrayBuffer): string {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const view = new Uint8Array(bytes);
  let out = "";
  for (let index = 0; index < view.length; index += 3) {
    const a = view[index] ?? 0;
    const b = view[index + 1];
    const c = view[index + 2];
    out += table[a >> 2];
    out += table[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) out += table[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) out += table[c & 0x3f];
  }
  return out;
}

async function sign(
  payload: SignedGrant["payload"],
  keys: Keys,
  algorithm: GrantAlgorithm,
): Promise<SignedGrant> {
  const grant: SignedGrant = { payload, signature: "" };
  const signature =
    algorithm === "Ed25519"
      ? await globalThis.crypto.subtle.sign(
          { name: "Ed25519" },
          keys.privateKey,
          signingInput(grant),
        )
      : await globalThis.crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          keys.privateKey,
          signingInput(grant),
        );
  return { payload, signature: base64Url(signature) };
}

function callOf(args: Readonly<Record<string, unknown>>): ToolCall {
  return { v: 1, callId: "tool:1:a", toolId: "read_file", toolVersion: "1", args };
}

function payloadOf(
  overrides: Partial<SignedGrant["payload"]> & { readonly scope?: CapabilityScope },
): SignedGrant["payload"] {
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
    maxCalls: 1000,
    maxBytes: 4096,
    nonce: "n1",
    alg: "Ed25519",
    keyId: "k1",
    ...overrides,
  };
}

async function inputFor(
  overrides: Partial<AuthorizeCallInput> & { readonly args?: Readonly<Record<string, unknown>> },
): Promise<AuthorizeCallInput> {
  const call = overrides.call ?? callOf(overrides.args ?? { path: "src/a.ts" });
  const digest = await digestCall(call);
  const { args: _args, ...rest } = overrides;
  return {
    grant: overrides.grant ?? (await signedGrant()),
    call,
    manifest: MANIFEST,
    key: keys.publicKey,
    now: NOW,
    callHash: digest.callHash,
    activePolicy: ACTIVE,
    ...rest,
  };
}

/** The manifest of a tool; bash carries the exec risk. */
function manifestFor(toolId: ToolManifest["toolId"]): ToolManifest {
  return toolId === "bash" ? { ...MANIFEST, toolId, risk: "exec" } : MANIFEST;
}

const keys = await ed25519Keys();
const otherKeys = await ed25519Keys();

async function signedGrant(
  overrides: Partial<SignedGrant["payload"]> = {},
  signKeys: Keys = keys,
  algorithm: GrantAlgorithm = "Ed25519",
): Promise<SignedGrant> {
  const payload = payloadOf({
    ...overrides,
    manifestHash:
      overrides.manifestHash ??
      (await manifestHash(manifestFor(overrides.toolId ?? MANIFEST.toolId))),
    alg: algorithm,
  });
  return sign(payload, signKeys, algorithm);
}

const ed25519Available = "Ed25519" in globalThis.crypto.subtle;

// Catches: a verifier that does not actually verify Ed25519 in WebCrypto (the Phase 1 default), so a
// grant signed by the control plane is refused, or one signed by anyone is accepted.
test.runIf(ed25519Available)(
  "an Ed25519 grant verifies with WebCrypto and is allowed",
  async () => {
    const decision = await authorizeCall(await inputFor({}));
    expect(decision).toStrictEqual({
      outcome: "allow",
      policyRevision: 7,
      policyHash: ACTIVE.hash,
      grantId: "g1",
    });
  },
);

// Catches: an ECDSA-P256 grant (the type Phase 2 will use) being refused by a verifier that only
// knows Ed25519, or its DER signature not being what WebCrypto verifies.
test("an ECDSA-P256 grant verifies with WebCrypto and is allowed", async () => {
  const p256 = await p256Keys();
  const grant = await signedGrant({}, p256, "ECDSA-P256");
  const decision = await authorizeCall(await inputFor({ grant, key: p256.publicKey }));
  expect(decision.outcome).toBe("allow");
});

// Catches: a forged signature, a signature over a different payload, a signature by another key, and
// a signature that is not even base64url.
test("a signature that does not verify is grant_invalid", async () => {
  const genuine = await signedGrant();
  const flipped =
    genuine.signature.slice(0, -2) +
    (genuine.signature.endsWith("A") ? "B" : "A") +
    genuine.signature.slice(-1);
  const cases: SignedGrant[] = [
    { payload: genuine.payload, signature: flipped },
    { payload: genuine.payload, signature: "not base64url!" },
    await signedGrant({}, otherKeys),
    {
      payload: { ...genuine.payload, scope: { kind: "read", roots: ["src"] } },
      signature: genuine.signature,
    },
  ];
  for (const grant of cases) {
    expect((await authorizeCall(await inputFor({ grant }))).outcome).toBe("deny");
    const decision = await authorizeCall(await inputFor({ grant }));
    // A payload edited after signing fails the signature; an unreadable signature fails the same way.
    expect(decision).toMatchObject({ outcome: "deny", code: "grant_invalid" });
  }
});

// Catches: alg confusion: a grant saying Ed25519 checked against a P-256 key (or the reverse) must be
// refused before the signature is even tried, not fall through to a generic failure.
test("a grant whose alg differs from the key is grant_algorithm_mismatch", async () => {
  const p256 = await p256Keys();
  const grant = await signedGrant({}, p256, "ECDSA-P256");
  const decision = await authorizeCall(await inputFor({ grant, key: keys.publicKey }));
  expect(decision).toMatchObject({ outcome: "deny", code: "grant_algorithm_mismatch" });
  const ed = await signedGrant();
  const reverse = await authorizeCall(await inputFor({ grant: ed, key: p256.publicKey }));
  expect(reverse).toMatchObject({ outcome: "deny", code: "grant_algorithm_mismatch" });
});

// Catches: an expired grant (expiresAt at or before now) or a grant issued in the future being used.
test("a grant outside its window is grant_expired", async () => {
  const expired = await signedGrant({
    issuedAt: isoTimestamp("2026-01-01T00:00:00.000Z"),
    expiresAt: isoTimestamp("2026-01-01T00:01:00.000Z"),
  });
  expect(await authorizeCall(await inputFor({ grant: expired }))).toMatchObject({
    outcome: "deny",
    code: "grant_expired",
  });
  const future = await signedGrant({
    issuedAt: isoTimestamp("2026-01-01T00:02:00.000Z"),
    expiresAt: isoTimestamp("2026-01-01T00:03:00.000Z"),
  });
  expect(await authorizeCall(await inputFor({ grant: future }))).toMatchObject({
    outcome: "deny",
    code: "grant_expired",
  });
});

// Catches: a grant issued under a policy revision the machine has already passed, so a revoked
// capability keeps working until its TTL.
test("a grant older than the last epoch is epoch_stale", async () => {
  const grant = await signedGrant({ epoch: 6 });
  const decision = await authorizeCall(await inputFor({ grant, lastEpoch: 7 }));
  expect(decision).toMatchObject({ outcome: "deny", code: "epoch_stale" });
  const equal = await authorizeCall(await inputFor({ grant, lastEpoch: 6 }));
  expect(equal.outcome).toBe("allow");
});

// Catches: a grant for one manifest / tool / version being used for another.
test("a manifest, tool, or version mismatch is manifest_mismatch", async () => {
  const otherManifest: ToolManifest = { ...MANIFEST, outputLimits: { maxBytes: 2, maxLines: 100 } };
  const decision = await authorizeCall(await inputFor({ manifest: otherManifest }));
  expect(decision).toMatchObject({ outcome: "deny", code: "manifest_mismatch" });
  const versionGrant = await signedGrant({ toolVersion: "2" });
  expect(await authorizeCall(await inputFor({ grant: versionGrant }))).toMatchObject({
    outcome: "deny",
    code: "manifest_mismatch",
  });
  const toolGrant = await signedGrant({ toolId: "write_file" });
  expect(await authorizeCall(await inputFor({ grant: toolGrant }))).toMatchObject({
    outcome: "deny",
    code: "manifest_mismatch",
  });
});

// Catches: a path outside the granted roots running (a sibling that shares a prefix, "..", an
// absolute path), and a glob being read as a match instead of fail closed.
test("a read outside the roots is path_outside_root; an unknown path is unsupported", async () => {
  const grant = await signedGrant({ scope: { kind: "read", roots: ["src"] } });
  for (const path of ["docs/a.md", "srcx/a.ts"]) {
    expect(await authorizeCall(await inputFor({ grant, args: { path } })), path).toMatchObject({
      outcome: "deny",
      code: "path_outside_root",
    });
  }
  for (const path of ["src/a/*", "**/a", "../etc/passwd", "/etc/passwd"]) {
    expect(await authorizeCall(await inputFor({ grant, args: { path } })), path).toMatchObject({
      outcome: "deny",
      code: "unsupported",
    });
  }
  expect(await authorizeCall(await inputFor({ grant, args: { path: "src/a.ts" } }))).toMatchObject({
    outcome: "allow",
  });
  const noPath = await authorizeCall(await inputFor({ grant, args: { content: "x" } }));
  expect(noPath).toMatchObject({ outcome: "deny", code: "scope_exceeded" });
});

// Catches: an exec call escaping its envelope (proxy egress when only none is granted, a writable
// run when the scope is read-only) or an envelope shape this contract does not know being allowed.
test("an exec outside its envelope is command_not_allowed, egress_denied, or unsupported", async () => {
  const call = (envelope: Readonly<Record<string, unknown>>): ToolCall => ({
    v: 1,
    callId: "tool:2:b",
    toolId: "bash",
    toolVersion: "1",
    args: { command: "ls", envelope },
  });
  const manifest: ToolManifest = { ...MANIFEST, toolId: "bash", version: "1", risk: "exec" };
  const grant = await signedGrant({
    toolId: "bash",
    scope: { kind: "exec", network: "none", writable: false },
  });
  const at = async (toolCall: ToolCall) =>
    authorizeCall({
      grant,
      call: toolCall,
      manifest,
      key: keys.publicKey,
      now: NOW,
      callHash: (await digestCall(toolCall)).callHash,
      activePolicy: ACTIVE,
    });
  expect(await at(call({ network: "none" }))).toMatchObject({ outcome: "allow" });
  expect(await at(call({ network: "proxy" }))).toMatchObject({
    outcome: "deny",
    code: "egress_denied",
  });
  expect(await at(call({ writable: true }))).toMatchObject({
    outcome: "deny",
    code: "command_not_allowed",
  });
  expect(await at(call({ writable: false }))).toMatchObject({ outcome: "allow" });
  expect(await at(call({ network: "all" }))).toMatchObject({
    outcome: "deny",
    code: "unsupported",
  });
  expect(await at(call({ network: "none", writable: false }))).toMatchObject({
    outcome: "deny",
    code: "unsupported",
  });
  const noCommand: ToolCall = {
    v: 1,
    callId: "tool:2:c",
    toolId: "bash",
    toolVersion: "1",
    args: { envelope: { network: "none" } },
  };
  expect(await at(noCommand)).toMatchObject({ outcome: "deny", code: "command_not_allowed" });
  const noEnvelope: ToolCall = {
    v: 1,
    callId: "tool:2:d",
    toolId: "bash",
    toolVersion: "1",
    args: { command: "ls" },
  };
  expect(await at(noEnvelope)).toMatchObject({ outcome: "deny", code: "scope_exceeded" });
});

// Catches: an exact grant allowing a different call, or the same call after its args changed (the
// same callId and tool, another argsHash).
test("an exact grant allows its callHash and nothing else", async () => {
  const call = callOf({ path: "notes.md" });
  const target = await digestCall(call);
  const grant = await signedGrant({
    scope: { kind: "exact", callHash: target.callHash },
    maxCalls: 1,
  });
  expect(
    await authorizeCall(await inputFor({ grant, call, callHash: target.callHash })),
  ).toMatchObject({
    outcome: "allow",
  });
  const sameCallAnotherArgs = callOf({ path: "secrets.md" });
  const other = await digestCall(sameCallAnotherArgs);
  expect(
    await authorizeCall(
      await inputFor({ grant, call: sameCallAnotherArgs, callHash: other.callHash }),
    ),
  ).toMatchObject({
    outcome: "deny",
    code: "scope_exceeded",
  });
});

// Catches: the call hash the caller computed differing from the call it is about to run (the judged
// and executed calls diverge).
test("a callHash that is not the call is refused", async () => {
  const decision = await authorizeCall(await inputFor({ callHash: "9".repeat(64) }));
  expect(decision).toMatchObject({ outcome: "deny", code: "scope_exceeded" });
});

// Catches: a grant or call that is not of this contract being accepted (an extra key, a missing key,
// a wrong type), or an allow without the policy revision it must be audited against.
test("a malformed grant is grant_invalid and an allow without a policy is refused", async () => {
  const genuine = await signedGrant();
  // A grant with an unknown key, as an untrusted body would carry it. SAFETY: the grant value is
  // handed to authorizeCall as untrusted input on purpose, so its shape is not promised here.
  const extra = { ...genuine, extra: 1 } as SignedGrant;
  const decision = await authorizeCall(await inputFor({ grant: extra }));
  expect(decision).toMatchObject({ outcome: "deny", code: "grant_invalid" });
  const noPolicy = await authorizeCall(await inputFor({ activePolicy: undefined }));
  expect(noPolicy).toMatchObject({ outcome: "deny", code: "policy_denied" });
  const invalidNow = await authorizeCall(await inputFor({ now: new Date("nope") }));
  expect(invalidNow).toMatchObject({ outcome: "deny", code: "grant_invalid" });
});

// Catches: an argument the canonical form cannot represent (a float) being hashed into a stable
// identity instead of being refused.
test("an args value with no canonical form is unsupported", async () => {
  const call = callOf({ path: "a.txt", size: 1.5 });
  const digest = await digestCall(callOf({ path: "a.txt" }));
  const decision = await authorizeCall({
    grant: await signedGrant(),
    call,
    manifest: MANIFEST,
    key: keys.publicKey,
    now: NOW,
    callHash: digest.callHash,
    activePolicy: ACTIVE,
  });
  expect(decision).toMatchObject({ outcome: "deny", code: "unsupported" });
});
