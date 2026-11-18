import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import { manifestHash, policyHash, signingInput } from "@hns/core/capability";
import type {
  GrantPayload,
  PolicyDecision,
  PolicyDocument,
  SignedGrant,
  ToolCall,
  ToolManifest,
} from "@hns/core/capability";
import { GrantCounter } from "../../src/capability/counter.ts";
import { grantKeyId } from "../../src/capability/keys.ts";
import { setProbeSigningKey, unboundedCounter, verifyWith } from "./machine-verifier-probes.ts";

/**
 * Mutation probes for the machine verifier: each one removes exactly one check and requires the
 * product's assertion to fail (0225).
 *
 * @remarks
 * A verifier that passes its tests proves only that it says `allow` when it should. Each probe here
 * runs the product's own path with one check changed and compares it with the product's answer for
 * the **same** input: if the mutated verifier allows what the product refuses, the suite's assertion
 * for that case is what would have caught the regression; if the control does not refuse it either,
 * the probe says the case was not measuring that check at all.
 *
 * The four are the four ways a capability decision is usually broken: the signature is not verified,
 * the expiry is not checked, the scope is not compared, and the counter's bound is not enforced.
 */

const MACHINE_ID = "machine-1";
const NOW = new Date("2026-01-01T00:01:00.000Z");
const DOCUMENT: PolicyDocument = {
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
const MANIFEST: ToolManifest = {
  v: 1,
  toolId: "read_file",
  version: "1",
  descriptionHash: "a".repeat(64),
  parametersHash: "b".repeat(64),
  risk: "read",
  outputLimits: { maxBytes: 1024, maxLines: 100 },
};
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

interface Env {
  readonly raw: Uint8Array;
  readonly keyId: string;
  sign(payload: GrantPayload): Promise<SignedGrant>;
}

let env: Env | undefined;
let policyHashValue = "";
let manifestHashValue = "";
let base = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "hns-verifier-probes-"));
  policyHashValue = await policyHash(DOCUMENT);
  manifestHashValue = await manifestHash(MANIFEST);
  const seed = new Uint8Array(32).fill(5);
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
  if (jwk.x === undefined) throw new Error("no public half");
  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const raw = fromBase64Url(jwk.x);
  setProbeSigningKey(privateKey);
  env = {
    raw,
    keyId: await grantKeyId(raw),
    async sign(payload) {
      const signature = await globalThis.crypto.subtle.sign(
        { name: "Ed25519" },
        privateKey,
        signingInput({ payload, signature: "" }),
      );
      return { payload, signature: toBase64Url(signature) };
    },
  };
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** One grant payload; only the fields a probe bends are arguments. */
function payloadOf(overrides: Partial<GrantPayload> = {}): GrantPayload {
  if (env === undefined) throw new Error("the fixture is not ready");
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
    epoch: 3,
    policyHash: policyHashValue,
    maxCalls: 1,
    maxBytes: 1000,
    nonce: "n1",
    alg: "Ed25519",
    keyId: env.keyId,
    ...overrides,
  };
}

function callOf(path: string): ToolCall {
  return { v: 1, callId: "tool:1:a", toolId: "read_file", toolVersion: "1", args: { path } };
}

/** The code a decision carries; "allow" when it allows. */
function codeOf(decision: PolicyDecision): string {
  return decision.outcome === "allow" ? "allow" : decision.code;
}

/** The verification inputs for one grant, as the product's verifier takes them. */
function probeInput(
  grant: SignedGrant,
  options: { readonly call?: ToolCall; readonly now?: Date } = {},
) {
  if (env === undefined) throw new Error("the fixture is not ready");
  return {
    grant,
    call: options.call ?? callOf("src/a.ts"),
    manifest: MANIFEST,
    keys: env.raw,
    machineId: MACHINE_ID,
    now: options.now ?? NOW,
    activePolicy: { revision: 3, hash: policyHashValue },
  };
}

/** The product's answer and the mutant's answer for one input. */
async function pair(
  mutation: "signature" | "expiry" | "scope",
  grant: SignedGrant,
  options: { readonly call?: ToolCall; readonly now?: Date } = {},
): Promise<{ readonly product: string; readonly mutant: string }> {
  if (env === undefined) throw new Error("the fixture is not ready");
  const input = {
    grant,
    call: options.call ?? callOf("src/a.ts"),
    manifest: MANIFEST,
    keys: env.raw,
    machineId: MACHINE_ID,
    now: options.now ?? NOW,
    activePolicy: { revision: 3, hash: policyHashValue },
  };
  return {
    product: codeOf(await verifyWith({ mutation: "none" }, input)),
    mutant: codeOf(await verifyWith({ mutation }, input)),
  };
}

// Control: the product allows an honest grant, and each mutant is not disturbed by it — the
// probes' refusals are about the check they break, not about the fixture.
test("control: the product allows an honest grant and the mutants do not disturb it", async () => {
  if (env === undefined) throw new Error("the fixture is not ready");
  const honest = await env.sign(payloadOf());
  expect((await pair("expiry", honest)).product).toBe("allow");
  expect((await pair("scope", honest)).product).toBe("allow");
  // The expiry and scope mutants allow the honest grant too: they only widen a decision.
  expect((await pair("expiry", honest)).mutant).toBe("allow");
  expect((await pair("scope", honest)).mutant).toBe("allow");
});

// Mutation 1: the signature is not verified. The product refuses the forged grant; the mutant,
// which keeps every other step, decides it and allows it.
test("probe: a verifier that trusts the grant's key is caught", async () => {
  if (env === undefined) throw new Error("the fixture is not ready");
  // A grant signed by a key the machine never enrolled: the attacker's, not the control plane's.
  const attacker = await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ]);
  const payload = payloadOf();
  const signature = await globalThis.crypto.subtle.sign(
    { name: "Ed25519" },
    attacker.privateKey,
    signingInput({ payload, signature: "" }),
  );
  const forged = { payload, signature: toBase64Url(signature) };
  const answers = {
    product: codeOf(await verifyWith({ mutation: "none" }, { ...probeInput(forged) })),
    // The mutant verifies with the attacker's own key, which is what trusting the grant's key means.
    mutant: codeOf(
      await verifyWith({ mutation: "signature", key: attacker.publicKey }, probeInput(forged)),
    ),
  };
  // The product refuses: the enrolled key does not verify it.
  expect(answers.product).toBe("grant_invalid");
  // The mutant, which trusts the key that signed the grant, allows it.
  expect(answers.mutant).toBe("allow");
});

// Mutation 2: expiresAt (and issuedAt) are not checked. The product refuses it at the late clock;
// the mutant, whose payload the check would have refused, allows it.
test("probe: a verifier that ignores expiresAt is caught", async () => {
  if (env === undefined) throw new Error("the fixture is not ready");
  const grant = await env.sign(payloadOf());
  const late = new Date("2026-01-01T00:05:00.000Z");
  const answers = await pair("expiry", grant, { now: late });
  expect(answers.product).toBe("grant_expired");
  expect(answers.mutant).toBe("allow");
});

// Mutation 3: the scope is not compared. The product refuses a path outside the grant's root; the
// mutant, whose roots cover the workspace, allows it.
test("probe: a verifier that ignores the scope is caught", async () => {
  if (env === undefined) throw new Error("the fixture is not ready");
  const rooted = await env.sign(payloadOf({ scope: { kind: "read", roots: ["src"] } }));
  const answers = await pair("scope", rooted, { call: callOf("docs/a.md") });
  expect(answers.product).toBe("path_outside_root");
  expect(answers.mutant).toBe("allow");
});

// Mutation 4: the counter does not enforce maxCalls. The mutated counter is the product's own class
// with its bound removed, so the file layout, the lock, and the version are the product's.
test("probe: a counter that ignores maxCalls is caught", async () => {
  const spend = {
    grantId: "g1",
    maxCalls: 1,
    maxBytes: 1000,
    bytes: 10,
    now: NOW.getTime(),
  };
  const product = new GrantCounter(join(base, "product-counter"));
  expect((await product.consume(spend)).outcome).toBe("allow");
  expect(await product.consume(spend)).toMatchObject({
    outcome: "deny",
    decision: { code: "counter_exhausted" },
  });
  // The mutant spends the same grant twice and reports two calls.
  const mutant = unboundedCounter(join(base, "mutant-counter"));
  expect((await mutant.consume(spend)).outcome).toBe("allow");
  const second = await mutant.consume(spend);
  expect(second).toMatchObject({ outcome: "allow", spend: { calls: 2 } });
});
