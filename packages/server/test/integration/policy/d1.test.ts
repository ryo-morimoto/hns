import { isoTimestamp } from "@hns/core";
import type { PolicyDocument } from "@hns/core/capability";
import { afterAll, beforeAll, expect, test } from "vitest";
import { openStore, type Store } from "../../../../store/src/index.ts";
import { createD1Harness, type D1Harness } from "../../../../store/test/integration/harness.ts";
import type { AgentPrincipal, HumanPrincipal } from "../../../src/policy/principals.ts";
import { baselineDocument } from "../../../src/policy/revisions.ts";
import { createPolicyService, type PolicyService } from "../../../src/policy/service.ts";

/**
 * The policy service on the real D1 SQLite (workerd).
 *
 * @remarks
 * The unit tests prove what the service decides over a fake; this suite proves the SQL that backs
 * it — the seed's `ON CONFLICT`, the append-only revision key, the compare-and-swap on the
 * pointer, the pending-only status update, and the diff over a stored document read back from D1.
 * `docs/procedures/testing.md`: the persistence is under test, so the database is real.
 */

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

const WORKSPACE = "ws-policy";
const HUMAN: HumanPrincipal = { kind: "human", id: "human-1" };
const AGENT: AgentPrincipal = { kind: "agent", id: "agent-1" };

/** A service over the opened store, with a fixed clock and a counting id source. */
function serviceOver(store: Store, bashSandbox = false): PolicyService {
  let proposals = 0;
  return createPolicyService({
    policy: store.policy,
    bashSandbox,
    now: () => isoTimestamp("2026-01-01T00:00:00.000Z"),
    newId: () => {
      proposals += 1;
      return "proposal-" + String(proposals);
    },
  });
}

/** The baseline with one extra read root. */
function wider(): ReturnType<typeof baselineDocument> {
  const document = baselineDocument({ bashSandbox: false });
  const read = document.tools.read_file;
  if (read === undefined) throw new Error("the baseline should have read_file");
  return {
    ...document,
    tools: {
      ...document.tools,
      read_file: { ...read, scope: { kind: "read", roots: [".", "docs"] } },
    },
  };
}

const withStore = async (run: (store: Store) => Promise<void>): Promise<void> => {
  await harness.reset();
  // SAFETY: harness.db is the binding miniflare's D1 exposes, which is what openStore binds.
  const store = await openStore({ d1: harness.db });
  try {
    await run(store);
  } finally {
    await store.close();
  }
};

test("the real D1 keeps one revision 1 across two concurrent ensures", async () => {
  await withStore(async (store) => {
    const service = serviceOver(store);
    const [first, second] = await Promise.all([
      service.ensure(WORKSPACE),
      service.ensure(WORKSPACE),
    ]);
    expect(first).toStrictEqual(second);
    expect(first.revision).toBe(1);
    expect(await store.policy.revisions(WORKSPACE)).toHaveLength(1);
    const active = await store.policy.active(WORKSPACE);
    expect(active).toStrictEqual({
      workspaceId: WORKSPACE,
      revision: 1,
      hash: first.hash,
      updatedAt: first.createdAt,
    });
  });
});

// Catches: an approval that moves the pointer without matching the revision it was built on.
test("an agent proposal becomes an approved revision on the real D1, and the hash changes", async () => {
  await withStore(async (store) => {
    const service = serviceOver(store);
    const before = await service.ensure(WORKSPACE);
    const proposed = await service.propose(AGENT, {
      workspaceId: WORKSPACE,
      candidate: wider(),
      reason: "read the docs",
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.proposal.status).toBe("pending");
    expect(proposed.diff.kind).toBe("expansion");
    expect((await store.policy.active(WORKSPACE))?.revision).toBe(1);
    expect(await store.policy.revisions(WORKSPACE)).toHaveLength(1);

    const decided = await service.decide(HUMAN, {
      proposalId: proposed.proposal.id,
      decision: "approve",
      reason: "ok",
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok || !("revision" in decided)) return;
    expect(decided.revision.revision).toBe(2);
    expect(decided.revision.hash).not.toBe(before.hash);
    expect(decided.revision.hash).toBe(proposed.proposal.candidateHash);
    expect(decided.revision.createdBy).toBe(HUMAN.id);
    const active = await store.policy.active(WORKSPACE);
    expect(active?.revision).toBe(2);
    expect(active?.hash).toBe(decided.revision.hash);
    expect(active?.workspaceId).toBe(WORKSPACE);
    expect(await store.policy.revisions(WORKSPACE)).toHaveLength(2);
    const stored = await store.policy.proposal(proposed.proposal.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.decidedBy).toBe(HUMAN.id);
  });
});

// Catches: a compare-and-swap that does not check the revision it read, so a second approval lands.
test("a stale approval on the real D1 reports approval_stale and moves nothing", async () => {
  await withStore(async (store) => {
    const service = serviceOver(store);
    await service.ensure(WORKSPACE);
    const first = await service.propose(AGENT, {
      workspaceId: WORKSPACE,
      candidate: wider(),
      reason: "read the docs",
    });
    const second = await service.propose(AGENT, {
      workspaceId: WORKSPACE,
      candidate: {
        ...wider(),
        egress: { enabled: true, hosts: [{ host: "api.example", port: 443 }] },
      },
      reason: "reach a host",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const approved = await service.decide(HUMAN, {
      proposalId: second.proposal.id,
      decision: "approve",
      reason: "ok",
    });
    expect(approved.ok).toBe(true);
    const stale = await service.decide(HUMAN, {
      proposalId: first.proposal.id,
      decision: "approve",
      reason: "ok",
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe("approval_stale");
    expect((await store.policy.active(WORKSPACE))?.revision).toBe(2);
    expect(await store.policy.revisions(WORKSPACE)).toHaveLength(2);
    expect((await store.policy.proposal(first.proposal.id))?.status).toBe("pending");
  });
});

test("an agent principal cannot approve on the real D1", async () => {
  await withStore(async (store) => {
    const service = serviceOver(store);
    await service.ensure(WORKSPACE);
    const proposed = await service.propose(AGENT, {
      workspaceId: WORKSPACE,
      candidate: wider(),
      reason: "read the docs",
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    /* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion --
       The chain is the forgery under test: an agent value reaching the human-only call. */
    const forged = AGENT as unknown as HumanPrincipal;
    const decided = await service.decide(forged, {
      proposalId: proposed.proposal.id,
      decision: "approve",
      reason: "ok",
    });
    expect(decided.ok).toBe(false);
    if (decided.ok) return;
    expect(decided.code).toBe("policy_denied");
    expect((await store.policy.active(WORKSPACE))?.revision).toBe(1);
    expect((await store.policy.proposal(proposed.proposal.id))?.status).toBe("pending");
  });
});

test("a glob candidate is unsupported on the real D1 and cannot be approved", async () => {
  await withStore(async (store) => {
    const service = serviceOver(store);
    await service.ensure(WORKSPACE);
    const document = baselineDocument({ bashSandbox: false });
    const read = document.tools.read_file;
    if (read === undefined) throw new Error("the baseline should have read_file");
    // The glob is the candidate's point: it is a string the contract accepts and the atom algebra
    // cannot compare, which is exactly the `unsupported` case.
    const candidate: PolicyDocument = {
      ...document,
      tools: {
        ...document.tools,
        read_file: { ...read, scope: { kind: "read", roots: ["a/*"] } },
      },
    };
    const proposed = await service.propose(AGENT, {
      workspaceId: WORKSPACE,
      candidate,
      reason: "a glob",
    });
    expect(proposed.ok).toBe(false);
    if (proposed.ok) return;
    expect(proposed.code).toBe("unsupported");
    expect(await store.policy.proposals(WORKSPACE)).toHaveLength(0);
    expect(await store.policy.revisions(WORKSPACE)).toHaveLength(1);
  });
});
