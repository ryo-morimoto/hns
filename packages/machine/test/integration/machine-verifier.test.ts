import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
// The manifests the issuer checks against are the agent's; the machine may not depend on
// `@hns/agent` (docs/packages.md, the oxlint boundary), so the test reaches it the way
// `mirror.test.ts` reaches the server's helpers: by path, from a test only.
import { WORKSPACE_TOOLS, manifestFor } from "../../../agent/src/capability.ts";
import { isoTimestamp } from "@hns/core";
import { manifestHash } from "@hns/core/capability";
import type { SignedGrant, ToolCall, ToolManifest } from "@hns/core/capability";
import { openStore } from "../../../store/src/index.ts";
import { createD1Harness } from "../../../store/test/integration/harness.ts";
import type { D1Harness } from "../../../store/test/integration/harness.ts";
import { controlPlanePublicKey, grantSigner } from "../../../server/src/capability/signing.ts";
import { createSqliteGrantRecorder, openGrantTables } from "../../../server/src/do/grant-store.ts";
import { createGrantPlane } from "../../../server/src/do/session-grants.ts";
import { createPolicyService } from "../../../server/src/policy/service.ts";
import { openSqliteState } from "../../../server/test/support/sqlite.ts";
import { GrantCounter } from "../../src/capability/counter.ts";
import { authorizeGrantedCall } from "../../src/capability/decision.ts";
import { enrolledGrantKeys } from "../../src/capability/keys.ts";
import { verifyGrant } from "../../src/capability/verify.ts";

/**
 * The real path of 0225: a grant the **production issuer** (0224) issues from a real D1 policy
 * revision, signed with the real control-plane key, and the **machine's own verifier** allows or
 * refuses — with `crypto.subtle`, from the public half a machine enrolls, and from the counter the
 * machine keeps on disk.
 *
 * @remarks
 * The unit suites use fixtures, which proves the checks in isolation. What only this can prove is that
 * the two halves agree end to end: the `keyId` the issuer writes is the one the machine's lookup
 * computes from the key the face serves; the `epoch` / `policyHash` the issuer signs are the active D1
 * revision's; the manifest the policy was for is the machine's manifest; the scope the policy set is
 * the scope the machine enforces; and a grant the issuer revoked (a run that ended) is refused as
 * `grant_revoked`, not as a stale one. The refusal cases are the same grant, one fact moved: the
 * clock, the revision, the budget, the path.
 *
 * The server's modules are imported by relative path, as `mirror.test.ts` does: 0225's product code
 * (`packages/machine/src/capability/`) imports nothing from `@hns/server`.
 */

/** The seed `HNS_CONTROL_PLANE_KEY` holds; its public half is what a machine enrolls. */
const SEED = Buffer.from(new Uint8Array(32).fill(13)).toString("base64url");

const MACHINE_ID = "machine-1";
const WORKSPACE_ID = "project-integration";

let harness: D1Harness;
let base = "";

beforeAll(async () => {
  harness = await createD1Harness();
  base = await mkdtemp(join(tmpdir(), "hns-machine-verifier-"));
});

afterAll(async () => {
  await harness.dispose();
  await rm(base, { recursive: true, force: true });
});

/** The control-plane key a machine enrolls: the public half of the issuer's seed (0148). */
async function enrolledKey(): Promise<Uint8Array> {
  const raw = await controlPlanePublicKey(SEED);
  if (raw === undefined) throw new Error("the seed has no public half");
  return raw;
}

/** One issued grant, and the revision it was issued under. */
interface Issued {
  readonly grant: SignedGrant;
  readonly manifest: ToolManifest;
  readonly revision: { readonly revision: number; readonly hash: string };
}

/**
 * Issue one grant through the production path: a real D1 policy revision, the real signer, the
 * Session's recorder over the object's SQLite shape.
 */
async function issue(
  request: {
    readonly toolId?: "read_file" | "bash";
    readonly maxBytes?: number;
  } = {},
): Promise<{
  readonly issued: Issued;
  readonly revoke: () => Promise<boolean>;
  readonly close: () => void;
}> {
  await harness.reset();
  const store = await openStore({ d1: harness.db });
  try {
    const service = createPolicyService({ policy: store.policy, bashSandbox: true });
    const active = await service.ensure(WORKSPACE_ID);
    const signer = await grantSigner({ seed: SEED });
    if (!signer.ok) throw new Error("the seed produced no signer: " + signer.code);
    const state = openSqliteState();
    const tables = openGrantTables(state.state.storage);
    const plane = createGrantPlane({
      signer: signer.signer,
      recorder: createSqliteGrantRecorder({
        ledger: tables.ledger,
        audit: tables.audit,
        transaction: (run) => state.state.storage.transaction(run),
        eventId: () => crypto.randomUUID(),
      }),
      workspaceId: WORKSPACE_ID,
      sessionId: WORKSPACE_ID,
      now: () => Date.now(),
      eventId: () => crypto.randomUUID(),
    });
    const manifests = await Promise.all(
      WORKSPACE_TOOLS.map(async (tool) => (await manifestFor(tool)).manifest),
    );
    const toolId = request.toolId ?? "read_file";
    const manifest = manifests.find((candidate) => candidate.toolId === toolId);
    if (manifest === undefined) throw new Error("no manifest for " + toolId);
    const result = await plane.request({
      request: {
        workspaceId: WORKSPACE_ID,
        sessionId: WORKSPACE_ID,
        machineId: MACHINE_ID,
        toolId,
        toolVersion: manifest.version,
        manifestHash:
          request.toolId === undefined
            ? await hashOf(manifests, "read_file")
            : await hashOf(manifests, toolId),
        maxBytes: request.maxBytes ?? 4096,
      },
      snapshot: { revision: active.revision, hash: active.hash, document: active.document },
      requestedBy: { kind: "human", id: "person" },
      manifests,
    });
    if (!result.ok) throw new Error("the issuer refused: " + result.decision.code);
    return {
      issued: {
        grant: result.grant,
        manifest,
        revision: { revision: active.revision, hash: active.hash },
      },
      revoke: async () =>
        await tables.ledger.revoke(
          result.grant.payload.grantId,
          isoTimestamp(new Date().toISOString()),
        ),
      close: () => state.close(),
    };
  } finally {
    await store.close();
  }
}

/** The manifest hash of one tool, from the agent's own manifest builder. */
async function hashOf(manifests: readonly ToolManifest[], toolId: string): Promise<string> {
  const manifest = manifests.find((candidate) => candidate.toolId === toolId);
  if (manifest === undefined) throw new Error("no manifest for " + toolId);
  return await manifestHash(manifest);
}

/** A read call of one path. */
function readCall(path: string): ToolCall {
  return { v: 1, callId: "tool:1:a", toolId: "read_file", toolVersion: "1", args: { path } };
}

/** The machine's verifier, over the enrolled key and a fresh state directory. */
async function machine() {
  const raw = await enrolledKey();
  return {
    keys: enrolledGrantKeys({ publicKeys: async () => [raw] }),
    counter: new GrantCounter(join(base, crypto.randomUUID(), "grants")),
  };
}

// C1 through the real issuer: the grant the production issuer signs is allowed by the machine's
// verifier, and its call is spent from the machine's own counter.
test("C1: a grant the production issuer signs is allowed by the machine's verifier", async () => {
  const session = await issue();
  try {
    const { keys, counter } = await machine();
    const result = await authorizeGrantedCall({
      grant: session.issued.grant,
      call: readCall("README.md"),
      manifest: session.issued.manifest,
      keys,
      counter,
      machineId: MACHINE_ID,
      now: new Date(),
      activePolicy: session.issued.revision,
      bytes: 1024,
    });
    expect(result.decision).toMatchObject({
      outcome: "allow",
      grantId: session.issued.grant.payload.grantId,
      policyRevision: session.issued.revision.revision,
      policyHash: session.issued.revision.hash,
    });
    // The issuer wrote the active revision's hash into the grant, and the machine spent one call.
    expect(session.issued.grant.payload.policyHash).toBe(session.issued.revision.hash);
    expect(await counter.read(session.issued.grant.payload.grantId)).toMatchObject({
      calls: 1,
      bytes: 1024,
    });
  } finally {
    session.close();
  }
});

// C3: the same grant, after its window.
test("C3: the same grant past expiresAt is grant_expired", async () => {
  const session = await issue();
  try {
    const { keys } = await machine();
    const expiry = Date.parse(session.issued.grant.payload.expiresAt) + 1;
    const result = await verifyGrant({
      grant: session.issued.grant,
      call: readCall("README.md"),
      manifest: session.issued.manifest,
      keys,
      machineId: MACHINE_ID,
      now: new Date(expiry),
      activePolicy: session.issued.revision,
    });
    expect(result.decision).toMatchObject({ outcome: "deny", code: "grant_expired" });
  } finally {
    session.close();
  }
});

// C3: the policy moved to revision 2, so the revision-1 grant is stale.
test("C3: a grant from a superseded revision is epoch_stale", async () => {
  const session = await issue();
  try {
    const { keys } = await machine();
    // The machine is told the new revision (as 0226's control channel carries it); the grant still
    // names revision 1 and revision 1's document.
    const result = await verifyGrant({
      grant: session.issued.grant,
      call: readCall("README.md"),
      manifest: session.issued.manifest,
      keys,
      machineId: MACHINE_ID,
      now: new Date(),
      activePolicy: { revision: session.issued.revision.revision + 1, hash: "d".repeat(64) },
      lastEpoch: session.issued.revision.revision + 1,
    });
    expect(result.decision).toMatchObject({ outcome: "deny", code: "epoch_stale" });
  } finally {
    session.close();
  }
});

// C6: the issuer's maxCalls bounds the machine: the last call is the last, through the counter.
test("C6: the grant's maxCalls is exhausted on the machine's own counter", async () => {
  const session = await issue();
  try {
    const { keys, counter } = await machine();
    const maxCalls = session.issued.grant.payload.maxCalls;
    expect(maxCalls).toBe(10);
    const calls = Array.from(
      { length: maxCalls + 1 },
      async () =>
        await authorizeGrantedCall({
          grant: session.issued.grant,
          call: readCall("README.md"),
          manifest: session.issued.manifest,
          keys,
          counter,
          machineId: MACHINE_ID,
          now: new Date(),
          activePolicy: session.issued.revision,
          bytes: 1,
        }),
    );
    const results = await Promise.all(calls);
    // Exactly the budget's worth of calls are allowed, and the rest are exhausted — which ones is
    // the lock's business, not the test's.
    expect(results.filter((result) => result.decision.outcome === "allow")).toHaveLength(maxCalls);
    const refused = results.filter((result) => result.decision.outcome === "deny");
    expect(refused).toHaveLength(1);
    expect(refused[0]?.decision).toMatchObject({ outcome: "deny", code: "counter_exhausted" });
    expect(await counter.read(session.issued.grant.payload.grantId)).toMatchObject({
      calls: maxCalls,
    });
  } finally {
    session.close();
  }
});

// C5: a call outside the revision's scope. The default policy's read root is the workspace root,
// so the refusal a policy can produce is an absolute path, which is not comparable at all.
test("C5: a call outside the revision's scope is refused", async () => {
  const session = await issue();
  try {
    const { keys } = await machine();
    expect(session.issued.grant.payload.scope).toStrictEqual({ kind: "read", roots: ["."] });
    const result = await verifyGrant({
      grant: session.issued.grant,
      call: readCall("/etc/passwd"),
      manifest: session.issued.manifest,
      keys,
      machineId: MACHINE_ID,
      now: new Date(),
      activePolicy: session.issued.revision,
    });
    // An absolute path is not a path of this contract: the scope cannot contain it.
    expect(result.decision).toMatchObject({ outcome: "deny", code: "unsupported" });
  } finally {
    session.close();
  }
});

// Revocation: a grant bound to a run the issuer ended is grant_revoked, not grant_expired.
test("a grant the issuer revoked is grant_revoked, not grant_expired", async () => {
  const session = await issue();
  try {
    const { keys } = await machine();
    expect(await session.revoke()).toBe(true);
    const result = await verifyGrant({
      grant: session.issued.grant,
      call: readCall("README.md"),
      manifest: session.issued.manifest,
      keys,
      machineId: MACHINE_ID,
      // A late clock too: the revocation is the fact, not the expiry.
      now: new Date(Date.parse(session.issued.grant.payload.expiresAt) + 60_000),
      activePolicy: session.issued.revision,
      revokedGrants: new Set([session.issued.grant.payload.grantId]),
    });
    expect(result.decision).toMatchObject({ outcome: "deny", code: "grant_revoked" });
  } finally {
    session.close();
  }
});

// The machine's key is the one the issuer names: the grant's keyId is the enrolled key's id.
test("the issuer's keyId is the key the machine enrolled", async () => {
  const session = await issue();
  try {
    const { keys } = await machine();
    const keyId = session.issued.grant.payload.keyId;
    expect(await keys.publicKey(keyId, "Ed25519")).toMatchObject({ ok: true });
    // A machine that enrolled another deployment's key has no key for this grant.
    const foreign = await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]);
    const exported = await globalThis.crypto.subtle.exportKey("raw", foreign.publicKey);
    const other = enrolledGrantKeys({ publicKeys: async () => [new Uint8Array(exported)] });
    expect(await other.publicKey(keyId, "Ed25519")).toMatchObject({
      ok: false,
      code: "grant_invalid",
    });
  } finally {
    session.close();
  }
});
