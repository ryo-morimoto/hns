import assert from "node:assert/strict";
import { isoTimestamp, type IsoTimestamp } from "@hns/core";
import type { PolicyDocument, PolicyRevision, ToolPolicy } from "@hns/core/capability";
import type {
  PolicyActivation,
  PolicyActive,
  PolicyProposalInput,
  PolicyRepository,
  PolicySeed,
  ProposalTransition,
  StoredPolicyProposal,
} from "@hns/store";
import { expect, test } from "vitest";
import type { AgentPrincipal, HumanPrincipal } from "./principals.ts";
import type { PolicyFailureCode } from "./service.ts";
import { createPolicyService, type PolicyService } from "./service.ts";

const WORKSPACE = "ws-1";
/** Every refusal the service may answer; a new code must be added here by hand. */
const FAILURE_CODES: readonly PolicyFailureCode[] = [
  "approval_stale",
  "policy_denied",
  "unsupported",
];
const HUMAN: HumanPrincipal = { kind: "human", id: "human-1" };
const AGENT: AgentPrincipal = { kind: "agent", id: "agent-1" };

/**
 * An in-memory policy repository.
 *
 * @remarks
 * A fake, not a mock: it keeps rows and applies the same rules the SQL does (append-only
 * revisions, `ON CONFLICT DO NOTHING` on the seed, a compare-and-swap on the pointer, and a
 * pending-only status update), so the service is tested for what it decides rather than for the
 * calls it makes. The real SQL is the store's integration test.
 */
interface FakeRepository {
  /** The interface as it is handed to the service; the methods close over `state`. */
  readonly repository: PolicyRepository;
  readonly revisions: Map<string, PolicyRevision>;
  readonly proposals: Map<string, StoredPolicyProposal>;
  active: PolicyActive | undefined;
  /** Run before the next `activate`, so a test can move the pointer underneath a decision. */
  beforeActivate: (() => void) | undefined;
}

function fakeRepository(): FakeRepository {
  const revisions = new Map<string, PolicyRevision>();
  const proposals = new Map<string, StoredPolicyProposal>();
  let active: PolicyActive | undefined;
  let beforeActivate: (() => void) | undefined;
  const key = (workspaceId: string, revision: number): string =>
    workspaceId + "#" + String(revision);
  let tick = 0;
  const at = (): IsoTimestamp =>
    isoTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString());
  const repository: PolicyRepository = {
    async ensure(workspaceId: string, seed: PolicySeed): Promise<PolicyRevision> {
      const current = active;
      if (current !== undefined) {
        const found = revisions.get(key(workspaceId, current.revision));
        if (found === undefined) throw new Error("the active revision is missing");
        return found;
      }
      const revision: PolicyRevision = {
        workspaceId,
        revision: 1,
        hash: seed.hash,
        document: seed.document,
        createdAt: seed.createdAt,
        createdBy: seed.createdBy,
      };
      revisions.set(key(workspaceId, 1), revision);
      active = { workspaceId, revision: 1, hash: seed.hash, updatedAt: seed.createdAt };
      return revision;
    },
    async active(): Promise<PolicyActive | undefined> {
      return active;
    },
    async revision(workspaceId: string, revision: number): Promise<PolicyRevision | undefined> {
      return revisions.get(key(workspaceId, revision));
    },
    async revisions(workspaceId: string): Promise<PolicyRevision[]> {
      return [...revisions.values()]
        .filter((revision) => revision.workspaceId === workspaceId)
        .sort((left, right) => left.revision - right.revision);
    },
    async append(revision: PolicyRevision): Promise<boolean> {
      if (revisions.has(key(revision.workspaceId, revision.revision))) return false;
      revisions.set(key(revision.workspaceId, revision.revision), revision);
      return true;
    },
    async activate(activation: PolicyActivation): Promise<boolean> {
      beforeActivate?.();
      beforeActivate = undefined;
      const current = active;
      if (current === undefined || current.revision !== activation.baseRevision) return false;
      active = {
        workspaceId: activation.workspaceId,
        revision: activation.revision,
        hash: activation.hash,
        updatedAt: at(),
      };
      return true;
    },
    async createProposal(input: PolicyProposalInput): Promise<StoredPolicyProposal> {
      const created = at();
      const proposal: StoredPolicyProposal = {
        id: input.id,
        workspaceId: input.workspaceId,
        baseRevision: input.baseRevision,
        baseHash: input.baseHash,
        candidate: input.candidate,
        candidateHash: input.candidateHash,
        reviewToken: input.reviewToken,
        requestedBy: input.requestedBy,
        reason: input.reason,
        status: "pending",
        createdAt: created,
        updatedAt: created,
      };
      proposals.set(input.id, proposal);
      return proposal;
    },
    async proposal(id: string): Promise<StoredPolicyProposal | undefined> {
      return proposals.get(id);
    },
    async proposals(workspaceId: string, status?: "pending" | "approved" | "rejected") {
      return [...proposals.values()].filter(
        (proposal) =>
          proposal.workspaceId === workspaceId &&
          (status === undefined || proposal.status === status),
      );
    },
    async decideProposal(input: {
      readonly id: string;
      readonly status: "approved" | "rejected";
      readonly decidedBy: string;
      readonly decidedAt: IsoTimestamp;
      readonly decisionReason: string;
    }): Promise<ProposalTransition> {
      const proposal = proposals.get(input.id);
      if (proposal === undefined) return "missing";
      if (proposal.status !== "pending") return "not_pending";
      proposals.set(input.id, {
        ...proposal,
        status: input.status,
        decidedBy: input.decidedBy,
        decidedAt: input.decidedAt,
        decisionReason: input.decisionReason,
        updatedAt: input.decidedAt,
      });
      return "updated";
    },
  };
  return {
    repository,
    revisions,
    proposals,
    /** The active pointer as the fake holds it; writable so a test can move it underneath. */
    get active(): PolicyActive | undefined {
      return active;
    },
    set active(next: PolicyActive | undefined) {
      active = next;
    },
    /** Run before the next `activate`, so a test can move the pointer underneath a decision. */
    set beforeActivate(run: (() => void) | undefined) {
      beforeActivate = run;
    },
  };
}

/** A service and the fake it runs over. */
interface OpenService {
  readonly service: PolicyService;
  readonly fake: FakeRepository;
}

/** A service over a fresh fake, plus the fake for assertions. */
function open(options: { readonly bashSandbox?: boolean } = {}): OpenService {
  const fake = fakeRepository();
  let next = 0;
  const service = createPolicyService({
    policy: fake.repository,
    bashSandbox: options.bashSandbox ?? false,
    newId: () => {
      next += 1;
      return "proposal-" + String(next);
    },
  });
  return { service, fake };
}

/** The baseline a test edits: a mutable copy, so no contract type is loosened for tests. */
interface EditableDocument {
  v: 1;
  tools: {
    read_file?: ToolPolicy | undefined;
    write_file?: ToolPolicy | undefined;
    bash?: ToolPolicy | undefined;
  };
  egress: { enabled: boolean; hosts: { host: string; port: number }[] };
}

/** A baseline copy a test can edit, returned as the contract's document. */
function documentWith(edit: (document: EditableDocument) => void): PolicyDocument {
  const document: EditableDocument = {
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
  };
  edit(document);
  // SAFETY: only optional members may be left out; every present tool is a ToolPolicy and the
  // egress hosts are HostPorts, so the copy is a PolicyDocument by construction.
  return document as PolicyDocument;
}

/** A read scope that adds one root to the baseline's read_file. */
function withReadRoot(root: string): PolicyDocument {
  return documentWith((document) => {
    const read = document.tools.read_file;
    assert.ok(read !== undefined);
    document.tools.read_file = { ...read, scope: { kind: "read", roots: [".", root] } };
  });
}

test("a fresh workspace gets revision 1 of the documented baseline, and a second call is the same", async () => {
  const { service, fake } = open();
  const first = await service.ensure(WORKSPACE);
  expect(first.revision).toBe(1);
  expect(first.createdBy).toBe("system");
  expect(first.document).toStrictEqual({
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
  });
  const second = await service.ensure(WORKSPACE);
  expect(second).toStrictEqual(first);
  expect((await fake.repository.revisions(WORKSPACE)).length).toBe(1);
});

test("bash is on only with a sandbox and the envelope is network none, not writable", async () => {
  const sandboxed = open({ bashSandbox: true });
  const revision = await sandboxed.service.ensure(WORKSPACE);
  expect(revision.document.tools.bash).toStrictEqual({
    enabled: true,
    scope: { kind: "exec", network: "none", writable: false },
    grantTtlSeconds: 60,
    maxCallsPerGrant: 10,
  });
  const bare = open();
  expect((await bare.service.ensure(WORKSPACE)).document.tools.bash).toBeUndefined();
});

test("an agent proposes a pending revision and the active policy does not move", async () => {
  const { service, fake } = open();
  const before = await service.ensure(WORKSPACE);
  const result = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("docs"),
    reason: "read the docs",
  });
  assert.ok(result.ok);
  expect(result.proposal.status).toBe("pending");
  expect(result.proposal.requestedBy).toBe(AGENT.id);
  expect(result.proposal.baseRevision).toBe(1);
  expect(result.proposal.baseHash).toBe(before.hash);
  expect(result.diff.kind).toBe("expansion");
  expect(result.diff.added).toStrictEqual([{ kind: "read", value: "docs" }]);
  expect(fake.active).toStrictEqual({
    workspaceId: WORKSPACE,
    revision: 1,
    hash: before.hash,
    updatedAt: before.createdAt,
  });
  expect((await fake.repository.revisions(WORKSPACE)).length).toBe(1);
});

test("a human approves and the active policy moves to the candidate at revision 2", async () => {
  const { service, fake } = open();
  const first = await service.ensure(WORKSPACE);
  const proposed = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("docs"),
    reason: "read the docs",
  });
  assert.ok(proposed.ok);
  const result = await service.decide(HUMAN, {
    proposalId: proposed.proposal.id,
    decision: "approve",
    reason: "ok",
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok("revision" in result);
  expect(result.revision.revision).toBe(2);
  expect(result.revision.hash).not.toBe(first.hash);
  expect(result.revision.hash).toBe(proposed.proposal.candidateHash);
  expect(result.revision.createdBy).toBe(HUMAN.id);
  expect(result.revision.document).toStrictEqual(proposed.proposal.candidate);
  expect(fake.active).toStrictEqual({
    workspaceId: WORKSPACE,
    revision: 2,
    hash: result.revision.hash,
    updatedAt: fake.active?.updatedAt,
  });
  expect(fake.active?.revision).toBe(2);
  expect((await fake.repository.proposal(proposed.proposal.id))?.status).toBe("approved");
});

test("a decision against a policy that moved is approval_stale and changes nothing", async () => {
  const { service, fake } = open();
  await service.ensure(WORKSPACE);
  const proposed = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("docs"),
    reason: "read the docs",
  });
  assert.ok(proposed.ok);
  const moved = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("src"),
    reason: "read src",
  });
  assert.ok(moved.ok);
  const approved = await service.decide(HUMAN, {
    proposalId: moved.proposal.id,
    decision: "approve",
    reason: "ok",
  });
  assert.ok(approved.ok);
  const stale = await service.decide(HUMAN, {
    proposalId: proposed.proposal.id,
    decision: "approve",
    reason: "ok",
  });
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.ok ? undefined : stale.code, "approval_stale");
  expect(FAILURE_CODES).toContain(stale.ok ? undefined : stale.code);
  expect(fake.active?.revision).toBe(2);
  expect((await fake.repository.revisions(WORKSPACE)).length).toBe(2);
  expect((await fake.repository.proposal(proposed.proposal.id))?.status).toBe("pending");
});

test("a compare-and-swap that loses the race is approval_stale, not a second revision", async () => {
  const { service, fake } = open();
  await service.ensure(WORKSPACE);
  const proposed = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("docs"),
    reason: "read the docs",
  });
  assert.ok(proposed.ok);
  // Another decision moves the pointer after the service has read it and before its swap.
  fake.beforeActivate = () => {
    const active = fake.active;
    assert.ok(active !== undefined);
    fake.active = { ...active, revision: active.revision + 1, hash: "0".repeat(64) };
  };
  const result = await service.decide(HUMAN, {
    proposalId: proposed.proposal.id,
    decision: "approve",
    reason: "ok",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ok ? undefined : result.code, "approval_stale");
  expect(fake.active?.hash).toBe("0".repeat(64));
  expect((await fake.repository.proposal(proposed.proposal.id))?.status).toBe("pending");
});

test("a review token that no longer matches its proposal is approval_stale", async () => {
  const { service, fake } = open();
  await service.ensure(WORKSPACE);
  const proposed = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("docs"),
    reason: "read the docs",
  });
  assert.ok(proposed.ok);
  fake.proposals.set(proposed.proposal.id, {
    ...proposed.proposal,
    reviewToken: "f".repeat(64),
    updatedAt: proposed.proposal.createdAt,
  });
  const result = await service.decide(HUMAN, {
    proposalId: proposed.proposal.id,
    decision: "approve",
    reason: "ok",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ok ? undefined : result.code, "approval_stale");
  expect(fake.active?.revision).toBe(1);
});

test("an agent cannot decide, even one built outside the type", async () => {
  const { service, fake } = open();
  await service.ensure(WORKSPACE);
  const proposed = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("docs"),
    reason: "read the docs",
  });
  assert.ok(proposed.ok);
  // The type says only a human may call this; the service must also refuse a value that crossed
  // the type (a test, a cast, a deserialized request).
  /* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion --
     The chain is the forgery under test: an agent value reaching the human-only call, which the
     service must refuse at run time even though the type forbids it. */
  const forged = AGENT as unknown as HumanPrincipal;
  const result = await service.decide(forged, {
    proposalId: proposed.proposal.id,
    decision: "approve",
    reason: "ok",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ok ? undefined : result.code, "policy_denied");
  expect(fake.active?.revision).toBe(1);
  expect((await fake.repository.proposal(proposed.proposal.id))?.status).toBe("pending");
});

test("the diff is expansion, narrowing, or mixed by which roots a candidate adds and removes", async () => {
  const { service } = open();
  await service.ensure(WORKSPACE);
  const narrower = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: documentWith((document) => {
      const read = document.tools.read_file;
      const write = document.tools.write_file;
      assert.ok(read !== undefined);
      assert.ok(write !== undefined);
      document.tools.read_file = { ...read, scope: { kind: "read", roots: ["src"] } };
      document.tools.write_file = { ...write, scope: { kind: "write", roots: ["src"] } };
    }),
    reason: "only inside src",
  });
  assert.ok(narrower.ok);
  // `src` is a child of `.`, but an atom is a string: the diff is a set difference over roots, not
  // containment (`docs/capability.md` §6). Only the run-time allow check uses `isUnder`.
  expect(narrower.diff).toStrictEqual({
    kind: "mixed",
    added: [
      { kind: "read", value: "src" },
      { kind: "write", value: "src" },
    ],
    removed: [
      { kind: "read", value: "." },
      { kind: "write", value: "." },
    ],
  });
  const both = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: documentWith((document) => {
      const read = document.tools.read_file;
      assert.ok(read !== undefined);
      document.tools.read_file = { ...read, scope: { kind: "read", roots: ["src"] } };
      document.egress = { enabled: true, hosts: [{ host: "api.example", port: 443 }] };
    }),
    reason: "read src and reach one host",
  });
  assert.ok(both.ok);
  expect(both.diff).toStrictEqual({
    kind: "mixed",
    added: [
      { kind: "egress", value: "api.example:443" },
      { kind: "read", value: "src" },
    ],
    removed: [{ kind: "read", value: "." }],
  });
});

test("a candidate the algebra cannot compare is unsupported and is not stored", async () => {
  const { service, fake } = open();
  await service.ensure(WORKSPACE);
  const result = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("a/*"),
    reason: "a glob",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ok ? undefined : result.code, "unsupported");
  expect(fake.proposals.size).toBe(0);
});

test("an equal candidate is refused rather than moved", async () => {
  const { service, fake } = open();
  const active = await service.ensure(WORKSPACE);
  const result = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: active.document,
    reason: "same",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ok ? undefined : result.code, "unsupported");
  expect(fake.proposals.size).toBe(0);
});

test("a stored proposal whose diff is unsupported cannot be approved", async () => {
  const { service, fake } = open();
  const active = await service.ensure(WORKSPACE);
  // A proposal written by an older build, or by hand, for a candidate this algebra cannot compare.
  const proposed = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("docs"),
    reason: "read the docs",
  });
  assert.ok(proposed.ok);
  fake.proposals.set(proposed.proposal.id, {
    ...proposed.proposal,
    candidate: withReadRoot("a/*"),
    updatedAt: proposed.proposal.createdAt,
  });
  const result = await service.decide(HUMAN, {
    proposalId: proposed.proposal.id,
    decision: "approve",
    reason: "ok",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ok ? undefined : result.code, "unsupported");
  expect(fake.active?.revision).toBe(1);
  expect(fake.active?.hash).toBe(active.hash);
  expect((await fake.repository.revisions(WORKSPACE)).length).toBe(1);
  expect((await fake.repository.proposal(proposed.proposal.id))?.status).toBe("pending");
});

test("a rejection closes the proposal and leaves the active policy alone", async () => {
  const { service, fake } = open();
  const before = await service.ensure(WORKSPACE);
  const proposed = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("docs"),
    reason: "read the docs",
  });
  assert.ok(proposed.ok);
  const result = await service.decide(HUMAN, {
    proposalId: proposed.proposal.id,
    decision: "reject",
    reason: "no",
  });
  assert.ok(result.ok);
  expect("revision" in result).toBe(false);
  const stored = await fake.repository.proposal(proposed.proposal.id);
  expect(stored?.status).toBe("rejected");
  expect(stored?.decidedBy).toBe(HUMAN.id);
  expect(stored?.decisionReason).toBe("no");
  expect(fake.active?.revision).toBe(1);
  expect(fake.active?.hash).toBe(before.hash);
  const again = await service.decide(HUMAN, {
    proposalId: proposed.proposal.id,
    decision: "approve",
    reason: "ok",
  });
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.ok ? undefined : again.code, "approval_stale");
});

test("a proposal for a workspace without an active policy cannot be decided", async () => {
  const { service, fake } = open();
  await service.ensure(WORKSPACE);
  const proposed = await service.propose(AGENT, {
    workspaceId: WORKSPACE,
    candidate: withReadRoot("docs"),
    reason: "read the docs",
  });
  assert.ok(proposed.ok);
  fake.active = undefined;
  const result = await service.decide(HUMAN, {
    proposalId: proposed.proposal.id,
    decision: "approve",
    reason: "ok",
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.ok ? undefined : result.code, "approval_stale");
});
