import { afterAll, beforeAll, expect, test } from "vitest";
import { openStore } from "../../../store/src/index.ts";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { WORKSPACE_TOOLS, manifestFor } from "@hns/agent";
import { authorizeCall, digestCall, type SignedGrant, type ToolCall } from "@hns/core/capability";
import { controlPlanePublicKey, grantSigner } from "../../src/capability/signing.ts";
import { createSqliteGrantRecorder, openGrantTables } from "../../src/do/grant-store.ts";
import { createGrantPlane } from "../../src/do/session-grants.ts";
import { createPolicyService } from "../../src/policy/service.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";

/**
 * The real path of 0224: a policy revision in a real D1, issued into a grant by the production issuer,
 * signed with the real control-plane key, and allowed by the contract's own verifier with WebCrypto.
 *
 * @remarks
 * What a fake cannot prove and this does: the snapshot the issuer gets is the revision D1 stores for
 * this workspace (revision and hash, not a hand-built object), the signature is the one a machine
 * verifies with the public half it enrolls with, and the grant's scope is the policy's own scope. A
 * run's grant is then revoked through the Session's tables and refused as `grant_revoked`, not as
 * `grant_expired`, by the same verifier. The Session object itself is exercised by
 * `session-do.test.ts`; here the plane runs over the object's SQLite shape with the production
 * recorder, which is everything the object adds on top of it.
 */

/** 32 bytes, base64url: the control-plane seed `HNS_CONTROL_PLANE_KEY` would hold. */
const SEED = Buffer.from(new Uint8Array(32).fill(11)).toString("base64url");

/** One workerd for the file: starting it per test is what a 30-second test timeout cannot afford. */
let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

/** Run one test against a reset database. */
async function withHarness(run: (harness: D1Harness) => Promise<void>): Promise<void> {
  await run(harness);
}

test("a real D1 policy revision issues a grant the contract's verifier allows", async () => {
  await withHarness(async (harness) => {
    await harness.reset();
    const store = await openStore({ d1: harness.db });
    try {
      // The workspace's revision 1, from the production policy service, with bash on (a sandbox).
      const service = createPolicyService({ policy: store.policy, bashSandbox: true });
      const active = await service.ensure("project-1");
      expect(active.revision).toBe(1);
      const signer = await grantSigner({ seed: SEED });
      if (!signer.ok) throw new Error("the test seed produced no signer");

      const state = openSqliteState();
      try {
        const tables = openGrantTables(state.state.storage);
        const ids = { counter: 0 };
        const plane = createGrantPlane({
          signer: signer.signer,
          recorder: createSqliteGrantRecorder({
            ledger: tables.ledger,
            audit: tables.audit,
            transaction: (run) => state.state.storage.transaction(run),
            eventId: () => "grant:event:" + String((ids.counter += 1)),
          }),
          workspaceId: "project-1",
          sessionId: "project-1",
          now: () => Date.now(),
          eventId: () => "grant:event:" + String((ids.counter += 1)),
        });
        const manifests = await Promise.all(
          WORKSPACE_TOOLS.map(async (tool) => (await manifestFor(tool)).manifest),
        );
        const identity = await manifestFor(WORKSPACE_TOOLS[0]!);
        const read = manifests.find((manifest) => manifest.toolId === "read_file");
        if (read === undefined) throw new Error("no read_file manifest");
        const issued = await plane.request({
          request: {
            workspaceId: "project-1",
            sessionId: "project-1",
            machineId: "machine-1",
            toolId: "read_file",
            toolVersion: read.version,
            manifestHash: identity.manifestHash,
            maxBytes: 4096,
          },
          snapshot: { revision: active.revision, hash: active.hash, document: active.document },
          requestedBy: { kind: "human", id: "person" },
          manifests,
        });
        if (!issued.ok) throw new Error("refused: " + issued.decision.code);

        // The machine's verifier: the public half of the seed, as GET /api/machines/keys serves it.
        const raw = await controlPlanePublicKey(SEED);
        if (raw === undefined) throw new Error("the seed has no public half");
        const key = await crypto.subtle.importKey(
          "raw",
          new Uint8Array(raw),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        const call: ToolCall = {
          v: 1,
          callId: "tool:1:a",
          toolId: "read_file",
          toolVersion: read.version,
          args: { path: "README.md" },
        };
        const now = new Date();
        const decision = await authorizeCall({
          grant: issued.grant,
          call,
          manifest: read,
          key,
          now,
          callHash: (await digestCall(call)).callHash,
          activePolicy: { revision: active.revision, hash: active.hash },
        });
        expect(decision).toMatchObject({
          outcome: "allow",
          grantId: issued.grant.payload.grantId,
          policyRevision: 1,
          policyHash: active.hash,
        });
        // The grant's scope is the D1 revision's scope, and its epoch is that revision.
        expect(issued.grant.payload.scope).toStrictEqual({ kind: "read", roots: ["."] });
        expect(issued.grant.payload.epoch).toBe(active.revision);
        expect(issued.grant.payload.keyId).toBe(signer.signer.keyId);
        // The ledger and the issuance audit both have the grant, and the audit chain verifies.
        expect(await tables.ledger.get(issued.grant.payload.grantId)).toMatchObject({
          grantId: issued.grant.payload.grantId,
          machineId: "machine-1",
        });
        expect(await tables.audit.verify()).toStrictEqual({ ok: true, rows: 1 });
        const [row] = await tables.audit.entries();
        expect(row).toMatchObject({ event: "grant.issued", grantId: issued.grant.payload.grantId });

        // A later revision moves the epoch: the same request under revision 2 carries epoch 2, and
        // the first grant is stale for a machine that has accepted the second.
        const next = await service.propose(
          { kind: "agent", id: "agent:1" },
          {
            workspaceId: "project-1",
            candidate: {
              ...active.document,
              tools: {
                ...active.document.tools,
                read_file: {
                  enabled: true,
                  scope: { kind: "read", roots: ["src"] },
                  grantTtlSeconds: 60,
                  maxCallsPerGrant: 10,
                },
              },
            },
            reason: "narrow the read root",
          },
        );
        if (!next.ok) throw new Error("the proposal was refused");
        const decided = await service.decide(
          { kind: "human", id: "person" },
          {
            proposalId: next.proposal.id,
            decision: "approve",
            reason: "ok",
          },
        );
        if (!decided.ok) throw new Error("the approval was refused");
        const second = (await service.current("project-1")).active;
        expect(second.revision).toBe(2);
        const issuedAgain = await plane.request({
          request: {
            workspaceId: "project-1",
            sessionId: "project-1",
            machineId: "machine-1",
            toolId: "read_file",
            toolVersion: read.version,
            manifestHash: issued.grant.payload.manifestHash,
            maxBytes: 4096,
          },
          snapshot: { revision: second.revision, hash: second.hash, document: second.document },
          requestedBy: { kind: "human", id: "person" },
          manifests,
        });
        if (!issuedAgain.ok) throw new Error("refused: " + issuedAgain.decision.code);
        expect(issuedAgain.grant.payload.epoch).toBe(2);
        expect(issuedAgain.grant.payload.scope).toStrictEqual({ kind: "read", roots: ["src"] });
        const narrowed = await authorizeCall({
          grant: issuedAgain.grant,
          call: { ...call, args: { path: "srv/a.ts" } },
          manifest: read,
          key,
          now: new Date(issuedAgain.grant.payload.issuedAt),
          callHash: (await digestCall({ ...call, args: { path: "srv/a.ts" } })).callHash,
          activePolicy: { revision: 2, hash: second.hash },
        });
        expect(narrowed).toMatchObject({ outcome: "deny", code: "path_outside_root" });
      } finally {
        state.close();
      }
    } finally {
      await store.close();
    }
  });
});

test("a run's grant is revoked when the run ends", async () => {
  await withHarness(async (harness) => {
    await harness.reset();
    const store = await openStore({ d1: harness.db });
    try {
      const service = createPolicyService({ policy: store.policy, bashSandbox: false });
      const active = await service.ensure("project-2");
      const signer = await grantSigner({ seed: SEED });
      if (!signer.ok) throw new Error("no signer");
      const state = openSqliteState();
      try {
        const tables = openGrantTables(state.state.storage);
        const plane = createGrantPlane({
          signer: signer.signer,
          recorder: createSqliteGrantRecorder({
            ledger: tables.ledger,
            audit: tables.audit,
            transaction: (run) => state.state.storage.transaction(run),
            eventId: () => crypto.randomUUID(),
          }),
          workspaceId: "project-2",
          sessionId: "project-2",
          now: () => Date.now(),
          eventId: () => crypto.randomUUID(),
        });
        const manifests = await Promise.all(
          WORKSPACE_TOOLS.map(async (tool) => (await manifestFor(tool)).manifest),
        );
        const read = manifests.find((manifest) => manifest.toolId === "read_file");
        if (read === undefined) throw new Error("no manifest");
        const identity = await manifestFor(WORKSPACE_TOOLS[0]!);
        const issued = await plane.request({
          request: {
            workspaceId: "project-2",
            sessionId: "project-2",
            machineId: "machine-2",
            toolId: "read_file",
            toolVersion: read.version,
            manifestHash: identity.manifestHash,
            maxBytes: 1024,
          },
          snapshot: { revision: active.revision, hash: active.hash, document: active.document },
          requestedBy: { kind: "agent", id: "agent:1", runId: "42" },
          manifests,
        });
        if (!issued.ok) throw new Error("refused: " + issued.decision.code);
        expect(await plane.boundTo("42")).toHaveLength(1);
        const revoked = await plane.revokeRun("42");
        expect(revoked).toStrictEqual([issued.grant.payload.grantId]);
        expect(await plane.boundTo("42")).toStrictEqual([]);
        const raw = await controlPlanePublicKey(SEED);
        if (raw === undefined) throw new Error("no public half");
        const key = await crypto.subtle.importKey(
          "raw",
          new Uint8Array(raw),
          { name: "Ed25519" },
          false,
          ["verify"],
        );
        const call: ToolCall = {
          v: 1,
          callId: "tool:2:b",
          toolId: "read_file",
          toolVersion: read.version,
          args: { path: "a" },
        };
        const grant: SignedGrant = issued.grant;
        const base = {
          grant,
          call,
          manifest: read,
          key,
          now: new Date(),
          callHash: (await digestCall(call)).callHash,
          activePolicy: { revision: active.revision, hash: active.hash },
        };
        expect(await authorizeCall({ ...base, revokedGrants: new Set(revoked) })).toMatchObject({
          outcome: "deny",
          code: "grant_revoked",
        });
        // Without revocation information the contract does not invent one: the grant is still live.
        expect((await authorizeCall(base)).outcome).toBe("allow");
        // The revocation is in the ledger, and the issuance audit is unchanged (issued, once).
        const record = await tables.ledger.get(issued.grant.payload.grantId);
        expect(record?.revokedAt).toBeTypeOf("string");
        expect(await tables.audit.verify()).toStrictEqual({ ok: true, rows: 1 });
      } finally {
        state.close();
      }
    } finally {
      await store.close();
    }
  });
});
