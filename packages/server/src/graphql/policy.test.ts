import { execute, parse } from "graphql";
import type { JsonValue } from "@hns/core";
import { expect, test, vi } from "vitest";
import type {
  PolicyDiff,
  PolicyDocument,
  PolicyProposal,
  PolicyRevision,
} from "@hns/core/capability";
import { isoTimestamp } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import { createContext } from "./context.ts";
import { buildGraphQLSchema, buildSchemaSdl } from "./schema.ts";
import type { PolicyFace, PolicyProposalRead, PolicyRevisionsRead } from "./policy/face.ts";
import { envWith } from "../../test/support/edge.ts";

/**
 * The policy Query and Mutation fields over a fake service.
 *
 * @remarks
 * The unit layer proves the **face**: which principal may call what, which code each refusal
 * answers with, and what a resolver does before the service sees the call. The real SQL is the
 * integration suite (test/integration/graphql-policy.test.ts).
 */

const WORKSPACE = "ws-policy";
const WORKSPACE_ID = toGlobalId("Project", WORKSPACE);
const HUMAN = "owner";
const AGENT = "agent:agent-1";

const schema = buildGraphQLSchema();

/** The variables one document takes; the values are JSON, as the handler parses them. */
type ExecutionVariables = Record<string, JsonValue>;

const TOOL = { enabled: true, grantTtlSeconds: 60, maxCallsPerGrant: 10 } as const;

const DOCUMENT: PolicyDocument = {
  v: 1,
  tools: {
    read_file: { ...TOOL, scope: { kind: "read", roots: ["."] } },
    write_file: { ...TOOL, scope: { kind: "write", roots: ["."] } },
  },
  egress: { enabled: false, hosts: [] },
};

const REVISION: PolicyRevision = {
  workspaceId: WORKSPACE,
  revision: 1,
  hash: "a".repeat(64),
  document: DOCUMENT,
  createdAt: isoTimestamp("2026-01-01T00:00:00.000Z"),
  createdBy: "system",
};

/** The baseline with `docs` added to the read roots: an expansion. */
const WIDER: PolicyDocument = {
  ...DOCUMENT,
  tools: {
    ...DOCUMENT.tools,
    read_file: { ...TOOL, scope: { kind: "read", roots: [".", "docs"] } },
  },
};

const EXPANSION: PolicyDiff = {
  kind: "expansion",
  added: [{ kind: "read", value: "docs" }],
  removed: [],
};

const PROPOSAL: PolicyProposal = {
  id: "p-1",
  workspaceId: WORKSPACE,
  baseRevision: 1,
  baseHash: "a".repeat(64),
  candidate: WIDER,
  candidateHash: "b".repeat(64),
  reviewToken: "c".repeat(64),
  requestedBy: "agent-1",
  reason: "read the docs",
  status: "pending",
  createdAt: isoTimestamp("2026-01-01T00:00:01.000Z"),
};

const PROPOSAL_READ: PolicyProposalRead = { proposal: PROPOSAL, diff: EXPANSION };

const REVISIONS: PolicyRevisionsRead = { active: 1, revisions: [REVISION] };

/** A policy face over fakes; each test overrides the operations it is about. */
function fakeFace(overrides: Partial<PolicyFace> = {}): PolicyFace {
  return {
    activeDocument: vi.fn(() => Promise.resolve({ ok: true as const, value: DOCUMENT })),
    revisions: vi.fn(() => Promise.resolve({ ok: true as const, value: REVISIONS })),
    proposals: vi.fn(() => Promise.resolve({ ok: true as const, value: [PROPOSAL_READ] })),
    propose: vi.fn(() => Promise.resolve({ ok: true as const, value: PROPOSAL_READ })),
    decide: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { kind: "rejected" as const, proposal: PROPOSAL, diff: EXPANSION },
      }),
    ),
    ...overrides,
  };
}

/** Execute one document with a session subject and a fake face. */
async function run(
  subject: string,
  query: string,
  policy: PolicyFace,
  variables: ExecutionVariables = {},
): Promise<{ readonly data: unknown; readonly errors: readonly unknown[] | undefined }> {
  const context = createContext({
    env: envWith(),
    requestId: "test",
    session: { subject, expiresAt: 0 },
    reads: {
      project: (projectId) =>
        Promise.resolve(
          projectId === WORKSPACE
            ? {
                id: projectId,
                name: "p",
                workspace_root: "p",
                agent_cwd: "p",
                egress: "inherit",
                created_at: "2026-01-01T00:00:00.000Z",
              }
            : undefined,
        ),
    },
    policy,
    maxRows: 100,
    maxRowsPerList: 50,
  });
  const result = await execute({
    schema,
    document: parse(query),
    contextValue: context,
    variableValues: variables,
  });
  return { data: result.data, errors: result.errors };
}

const REVISIONS_QUERY =
  "query R($workspaceId: ID!, $first: Int) { policyRevisions(workspaceId: $workspaceId, first: $first) { __typename ... on PolicyRevisionList { revisions { id workspaceId revision hash active createdBy document { readRoots writeRoots bash network } } } ... on PolicyFailure { code message } } }";

const PROPOSALS_QUERY =
  "query P($workspaceId: ID!, $status: PolicyProposalStatus) { policyProposals(workspaceId: $workspaceId, status: $status) { __typename ... on PolicyProposalList { proposals { id baseRevision reviewToken status requestedBy reason candidate { readRoots } diff { kind added { atomKind value } removed { atomKind value } } } } ... on PolicyFailure { code message } } }";

const PROPOSE =
  "mutation Propose($input: PolicyProposalInput!) { proposePolicy(input: $input) { __typename ... on ProposePolicyPayload { proposal { id status requestedBy diff { kind added { atomKind value } } } } ... on PolicyFailure { code message } } }";

const DECIDE =
  "mutation Decide($input: DecidePolicyInput!) { decidePolicy(input: $input) { __typename ... on DecidePolicyPayload { proposal { id status decidedBy } revision { revision hash active } proposalStale } ... on PolicyFailure { code message } } }";

/** The proposal input a client sends: the baseline with `docs` added to the read roots. */
const PROPOSE_INPUT = {
  workspaceId: WORKSPACE_ID,
  readRoots: [".", "docs"],
  writeRoots: ["."],
  bash: false,
  network: false,
  reason: "read the docs",
};

/** The decision input a human sends: the proposal and the token it displayed. */
const DECIDE_INPUT = {
  proposalId: toGlobalId("PolicyProposal", PROPOSAL.id),
  reviewToken: PROPOSAL.reviewToken,
  approve: true,
  reason: "ok",
};

// C1: Catches: a default revision missing from the list, or an active flag that is false on it.
test("policyRevisions returns the default revision as active", async () => {
  const { data } = await run(HUMAN, REVISIONS_QUERY, fakeFace(), { workspaceId: WORKSPACE_ID });
  expect(data).toMatchObject({
    policyRevisions: {
      __typename: "PolicyRevisionList",
      revisions: [
        {
          revision: 1,
          active: true,
          createdBy: "system",
          document: { readRoots: ["."], writeRoots: ["."], bash: false, network: false },
        },
      ],
    },
  });
});

// C2: Catches: a proposal reported as active, or a face that never shows the pending state.
test("an agent proposePolicy returns a pending proposal and the diff", async () => {
  const face = fakeFace();
  const { data } = await run(AGENT, PROPOSE, face, { input: PROPOSE_INPUT });
  expect(data).toMatchObject({
    proposePolicy: {
      __typename: "ProposePolicyPayload",
      proposal: { status: "PENDING", requestedBy: "agent-1", diff: { kind: "EXPANSION" } },
    },
  });
  expect(face.propose).toHaveBeenCalledTimes(1);
});

// C3: Catches: an approval that does not return the revision it made active.
test("a human decidePolicy returns the activated revision", async () => {
  const approved: PolicyRevision = {
    ...REVISION,
    revision: 2,
    hash: "b".repeat(64),
    createdBy: "owner",
  };
  const face = fakeFace({
    decide: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          kind: "approved" as const,
          revision: approved,
          proposal: { ...PROPOSAL, status: "approved" as const, decidedBy: "owner" },
          diff: EXPANSION,
          proposalStale: false,
        },
      }),
    ),
  });
  const { data } = await run(HUMAN, DECIDE, face, { input: DECIDE_INPUT });
  expect(data).toMatchObject({
    decidePolicy: {
      __typename: "DecidePolicyPayload",
      proposal: { status: "APPROVED", decidedBy: "owner" },
      revision: { revision: 2, active: true },
      proposalStale: false,
    },
  });
});

// C4: Catches: the service's stale refusal mapped to a code a client would treat as retryable.
test("a stale decision is approval_stale", async () => {
  const face = fakeFace({
    decide: vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        code: "approval_stale" as const,
        message: "the active policy moved since the proposal",
      }),
    ),
  });
  const { data } = await run(HUMAN, DECIDE, face, { input: DECIDE_INPUT });
  expect(data).toMatchObject({
    decidePolicy: { __typename: "PolicyFailure", code: "APPROVAL_STALE" },
  });
});

// C5: Catches: an agent that reaches the service at all; the principal is refused at the face.
test("an agent decidePolicy is policy_denied and never calls the service", async () => {
  const face = fakeFace();
  const { data } = await run(AGENT, DECIDE, face, { input: DECIDE_INPUT });
  expect(data).toMatchObject({
    decidePolicy: { __typename: "PolicyFailure", code: "POLICY_DENIED" },
  });
  expect(face.decide).not.toHaveBeenCalled();
});

// C6: Catches: a proposal the atom algebra cannot compare being stored as pending, or a glob the
// face hands to the service instead of refusing. Every glob the contract knows must be refused —
// a rule that only knew `*` and `?` would answer invalid_request for a brace expansion.
test.each(["a/*", "a/{b,c}", "a/[bc]", "a/?.txt"])(
  "a glob proposal (%s) is unsupported and never reaches the service",
  async (root) => {
    const face = fakeFace();
    const proposed = await run(AGENT, PROPOSE, face, {
      input: { ...PROPOSE_INPUT, readRoots: [root] },
    });
    expect(proposed.data).toMatchObject({
      proposePolicy: { __typename: "PolicyFailure", code: "UNSUPPORTED" },
    });
    expect(face.propose).not.toHaveBeenCalled();
  },
);

// Catches: a root the contract refuses for another reason (a `..` segment, an absolute path) being
// reported as invalid_request, which would tell a client its request was malformed.
test.each(["a/..", "/etc"])(
  "a root the contract cannot compare (%s) is unsupported",
  async (root) => {
    const face = fakeFace();
    const { data } = await run(AGENT, PROPOSE, face, {
      input: { ...PROPOSE_INPUT, writeRoots: [root] },
    });
    expect(data).toMatchObject({
      proposePolicy: { __typename: "PolicyFailure", code: "UNSUPPORTED" },
    });
    expect(face.propose).not.toHaveBeenCalled();
  },
);

// Catches: the size bound being off by one at the edge it documents — 1,024 characters is the
// longest root the input promises to accept.
test("a 1,024-character root is accepted and 1,025 is invalid_request", async () => {
  const face = fakeFace();
  const accepted = await run(AGENT, PROPOSE, face, {
    input: { ...PROPOSE_INPUT, readRoots: [".".padEnd(1_024, "a")] },
  });
  expect(accepted.data).toMatchObject({ proposePolicy: { __typename: "ProposePolicyPayload" } });
  const refused = await run(AGENT, PROPOSE, face, {
    input: { ...PROPOSE_INPUT, readRoots: [".".padEnd(1_025, "a")] },
  });
  expect(refused.data).toMatchObject({
    proposePolicy: { __typename: "PolicyFailure", code: "INVALID_REQUEST" },
  });
});

// B2: Catches: `[]` meaning "disable the tool" rather than "keep the active roots" — the UI then has
// no way to say "change nothing here", and the candidate silently narrows the policy.
test("an empty root list keeps the active roots and sends an equal candidate", async () => {
  const face = fakeFace();
  const { data } = await run(AGENT, PROPOSE, face, {
    input: { ...PROPOSE_INPUT, readRoots: [], writeRoots: [] },
  });
  expect(data).toMatchObject({ proposePolicy: { __typename: "ProposePolicyPayload" } });
  const call = vi.mocked(face.propose).mock.calls[0];
  expect(call?.[1].candidate.tools.read_file?.scope).toStrictEqual({ kind: "read", roots: ["."] });
  expect(call?.[1].candidate.tools.write_file?.scope).toStrictEqual({
    kind: "write",
    roots: ["."],
  });
});

// Catches: a network proposal Phase 1 cannot honour being stored and honoured by nothing.
test("a network proposal is unsupported", async () => {
  const face = fakeFace();
  const { data } = await run(AGENT, PROPOSE, face, {
    input: { ...PROPOSE_INPUT, network: true },
  });
  expect(data).toMatchObject({
    proposePolicy: { __typename: "PolicyFailure", code: "UNSUPPORTED" },
  });
  expect(face.propose).not.toHaveBeenCalled();
});

// C7: Catches: an empty list answering for a workspace that does not exist.
test("an unknown workspace is not_found, not an empty list", async () => {
  const unknown = toGlobalId("Project", "ws-missing");
  const revisions = await run(HUMAN, REVISIONS_QUERY, fakeFace(), { workspaceId: unknown });
  expect(revisions.data).toMatchObject({
    policyRevisions: { __typename: "PolicyFailure", code: "NOT_FOUND" },
  });
  const proposals = await run(HUMAN, PROPOSALS_QUERY, fakeFace(), { workspaceId: unknown });
  expect(proposals.data).toMatchObject({
    policyProposals: { __typename: "PolicyFailure", code: "NOT_FOUND" },
  });
});

// Catches: an id of another type read as a workspace, addressing a project that is not one.
test("a Conversation global id is invalid_request, not not_found", async () => {
  const { data } = await run(HUMAN, REVISIONS_QUERY, fakeFace(), {
    workspaceId: toGlobalId("Conversation", WORKSPACE),
  });
  expect(data).toMatchObject({
    policyRevisions: { __typename: "PolicyFailure", code: "INVALID_REQUEST" },
  });
});

// Catches: a status filter the face accepts and the store cannot answer; and a diff not listed.
test("policyProposals passes the status filter through and lists each diff", async () => {
  const face = fakeFace();
  const { data } = await run(HUMAN, PROPOSALS_QUERY, face, {
    workspaceId: WORKSPACE_ID,
    status: "PENDING",
  });
  expect(face.proposals).toHaveBeenCalledWith(WORKSPACE, "pending");
  expect(data).toMatchObject({
    policyProposals: {
      __typename: "PolicyProposalList",
      proposals: [
        {
          id: toGlobalId("PolicyProposal", PROPOSAL.id),
          status: "PENDING",
          reviewToken: PROPOSAL.reviewToken,
          diff: { kind: "EXPANSION", added: [{ atomKind: "read", value: "docs" }] },
        },
      ],
    },
  });
});

// Catches: a proposal id of another type guessed into a lookup.
test("a proposal id of another type is invalid_request", async () => {
  const face = fakeFace();
  const { data } = await run(HUMAN, DECIDE, face, {
    input: { ...DECIDE_INPUT, proposalId: toGlobalId("Project", PROPOSAL.id) },
  });
  expect(data).toMatchObject({
    decidePolicy: { __typename: "PolicyFailure", code: "INVALID_REQUEST" },
  });
  expect(face.decide).not.toHaveBeenCalled();
});

// Catches: two copies of a policy type in the schema (which GraphQL refuses), or an SDL field the
// contract names going missing, or a scope type Phase 1 must not publish.
test("the published schema carries the policy types and the five codes", () => {
  const sdl = buildSchemaSdl();
  expect(sdl).toMatch(/^type PolicyDocument \{/mu);
  expect(sdl).toMatch(/^type PolicyRevision \{/mu);
  expect(sdl).toMatch(/^type PolicyProposal \{/mu);
  expect(sdl).toMatch(/^type PolicyDiff \{/mu);
  expect(sdl).toMatch(/^type PolicyDiffAtom \{/mu);
  expect(sdl).toMatch(/^enum PolicyFailureCode \{/mu);
  expect(sdl).toMatch(
    /policyRevisions\(workspaceId: ID!, first: Int\): PolicyRevisionListResult!/u,
  );
  expect(sdl).toMatch(/policyProposals\(workspaceId: ID!, status: PolicyProposalStatus\)/u);
  expect(sdl).toMatch(/proposePolicy\(input: PolicyProposalInput!\): ProposePolicyResult!/u);
  expect(sdl).toMatch(/decidePolicy\(input: DecidePolicyInput!\): DecidePolicyResult!/u);
  expect(sdl).not.toMatch(/CapabilityScope|HostPort/u);
});
