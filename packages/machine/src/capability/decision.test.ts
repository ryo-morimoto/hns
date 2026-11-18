import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { isoTimestamp } from "@hns/core";
import { manifestHash, policyHash, signingInput } from "@hns/core/capability";
import type {
  GrantPayload,
  PolicyDocument,
  SignedGrant,
  ToolCall,
  ToolManifest,
} from "@hns/core/capability";
import { GrantCounter } from "./counter.ts";
import { authorizeGrantedCall, mayRetry } from "./decision.ts";
import { enrolledGrantKeys } from "./keys.ts";

/**
 * The one decision a caller makes: verify the grant, then spend its budget.
 *
 * @remarks
 * The two halves are tested apart (`verify.test.ts`, `counter.test.ts`); what this file adds is their
 * **order**, which is the property a caller relies on: a call that does not verify does not spend
 * the grant it was offered for, a call that verifies but has no budget left is refused without the
 * tool running, and an allowed call has its spend recorded before it runs. The counter is a real
 * directory, so "the spend happened" is read back from the machine's disk.
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
  readonly keys: ReturnType<typeof enrolledGrantKeys>;
  readonly keyId: string;
  sign(payload: GrantPayload): Promise<SignedGrant>;
}

let env: Env | undefined;
let policyHashValue = "";
let manifestHashValue = "";
let base = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "hns-grant-decision-"));
  policyHashValue = await policyHash(DOCUMENT);
  manifestHashValue = await manifestHash(MANIFEST);
  const seed = new Uint8Array(32).fill(3);
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
  const raw = fromBase64Url(jwk.x);
  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const { grantKeyId } = await import("./keys.ts");
  env = {
    keys: enrolledGrantKeys({ publicKeys: async () => [raw] }),
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

function callOf(path: string): ToolCall {
  return { v: 1, callId: "tool:1:a", toolId: "read_file", toolVersion: "1", args: { path } };
}

async function grantOf(overrides: Partial<GrantPayload> = {}): Promise<SignedGrant> {
  if (env === undefined) throw new Error("the fixture is not ready");
  return await env.sign({
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
    maxCalls: 2,
    maxBytes: 1000,
    nonce: "n1",
    alg: "Ed25519",
    keyId: env.keyId,
    ...overrides,
  });
}

let directories = 0;

async function counter(): Promise<GrantCounter> {
  directories += 1;
  return new GrantCounter(join(base, String(directories), "grants"));
}

async function decide(
  grant: SignedGrant,
  options: {
    readonly counter?: GrantCounter;
    readonly bytes?: number;
    readonly call?: ToolCall;
    readonly now?: Date;
  } = {},
) {
  if (env === undefined) throw new Error("the fixture is not ready");
  return await authorizeGrantedCall({
    grant,
    call: options.call ?? callOf("src/a.ts"),
    manifest: MANIFEST,
    keys: env.keys,
    counter: options.counter ?? (await counter()),
    machineId: MACHINE_ID,
    now: options.now ?? NOW,
    activePolicy: { revision: 3, hash: policyHashValue },
    bytes: options.bytes ?? 10,
  });
}
// The control: a grant that verifies and has budget is allowed, and the spend is on disk.
test("an allowed call spends the grant before it runs", async () => {
  const counterOne = await counter();
  const result = await decide(await grantOf(), { counter: counterOne });
  expect(result.decision).toMatchObject({ outcome: "allow", grantId: "g1" });
  expect(await counterOne.read("g1")).toMatchObject({ calls: 1, bytes: 10 });
});

// A refused verification spends nothing: the next call of the same grant still has its budget.
test("a call that does not verify does not spend the grant", async () => {
  const counterOne = await counter();
  const expired = await decide(await grantOf(), {
    counter: counterOne,
    now: new Date("2026-01-01T00:02:00.000Z"),
  });
  expect(expired.decision).toMatchObject({ outcome: "deny", code: "grant_expired" });
  expect(await counterOne.read("g1")).toBeUndefined();
  const outside = await decide(await grantOf(), {
    counter: counterOne,
    call: callOf("../etc/passwd"),
  });
  expect(outside.decision.outcome).toBe("deny");
  expect(await counterOne.read("g1")).toBeUndefined();
  // The grant still has both calls.
  expect((await decide(await grantOf(), { counter: counterOne })).decision.outcome).toBe("allow");
  expect((await decide(await grantOf(), { counter: counterOne })).decision.outcome).toBe("allow");
  const third = await decide(await grantOf(), { counter: counterOne });
  expect(third.decision).toMatchObject({ outcome: "deny", code: "counter_exhausted" });
  // The exhausted grant is still named in the answer, so an audit row can.
  expect(third.grant?.payload.grantId).toBe("g1");
});

// A call that is allowed but cannot pay for itself is refused, and nothing is written.
test("a call whose output does not fit the remaining bytes is counter_exhausted", async () => {
  const counterOne = await counter();
  const result = await decide(await grantOf({ maxBytes: 50 }), { counter: counterOne, bytes: 51 });
  expect(result.decision).toMatchObject({ outcome: "deny", code: "counter_exhausted" });
  expect(await counterOne.read("g1")).toBeUndefined();
});

// The scope is decided before the budget: a scope refusal reads as the scope's, not as exhaustion.
test("the scope is refused before the budget is consulted", async () => {
  const counterOne = await counter();
  const grant = await grantOf({ maxCalls: 1, scope: { kind: "read", roots: ["src"] } });
  expect((await decide(grant, { counter: counterOne })).decision.outcome).toBe("allow");
  // Both the scope and the budget would refuse; the scope is the answer.
  expect(
    (await decide(grant, { counter: counterOne, call: callOf("docs/a.md") })).decision,
  ).toMatchObject({
    outcome: "deny",
    code: "path_outside_root",
  });
});

test("only a state that can move is retryable", () => {
  expect(mayRetry({ outcome: "allow", policyRevision: 3, policyHash: "f".repeat(64) })).toBe(false);
  expect(mayRetry({ outcome: "deny", code: "grant_expired", message: "x" })).toBe(true);
  expect(mayRetry({ outcome: "deny", code: "epoch_stale", message: "x" })).toBe(true);
  expect(mayRetry({ outcome: "deny", code: "counter_exhausted", message: "x" })).toBe(false);
  expect(mayRetry({ outcome: "deny", code: "grant_invalid", message: "x" })).toBe(false);
});
