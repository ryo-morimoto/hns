import { execute, parse } from "graphql";
import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import { toGlobalId } from "@hns/core/graphql";
import type { Store } from "../../../store/src/index.ts";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { createContext } from "../../src/graphql/context.ts";
import { createGraphQLFace } from "../../src/graphql/handler.ts";
import { buildGraphQLSchema } from "../../src/graphql/schema.ts";
import { policyFaceOver } from "../../src/graphql/policy/face.ts";
import { envWith } from "../support/edge.ts";
import type { JsonValue } from "@hns/core";
import type { GraphQLFaceDependencies } from "../../src/graphql/handler.ts";

/**
 * The policy face over the real D1 SQLite (workerd).
 *
 * @remarks
 * The unit suite proves the face's contract over a fake; this suite proves the **SQL and the
 * service behind it**: a proposal becomes a pending row and changes nothing, an approval through
 * \`decidePolicy\` appends a revision and moves the pointer, a stale token is \`approval_stale\`, an
 * agent subject is refused, and an unknown workspace is \`not_found\`. The documents go through the
 * same \`execute\` the handler runs, over the face a request builds (\`policyFaceOver\`).
 */

const HUMAN = "owner";
const AGENT = "agent:agent-1";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

const schema = buildGraphQLSchema();

// Catches: a response the face did not shape as the document asked (a missing payload, a null
// where the schema promises a list). Every read below parses with these, so a shape change fails
// here rather than in an assertion's message.
const RevisionListSchema = v.object({
  policyRevisions: v.object({
    __typename: v.literal("PolicyRevisionList"),
    revisions: v.array(
      v.object({
        revision: v.number(),
        hash: v.string(),
        active: v.boolean(),
        createdBy: v.string(),
        document: v.object({
          readRoots: v.array(v.string()),
          writeRoots: v.array(v.string()),
          bash: v.boolean(),
          network: v.boolean(),
        }),
      }),
    ),
  }),
});

const ProposalListSchema = v.object({
  policyProposals: v.object({
    __typename: v.literal("PolicyProposalList"),
    proposals: v.array(
      v.object({
        id: v.string(),
        status: v.string(),
        requestedBy: v.string(),
        reviewToken: v.string(),
        diff: v.object({ kind: v.string() }),
      }),
    ),
  }),
});

const ProposeSchema = v.object({
  proposePolicy: v.object({
    __typename: v.literal("ProposePolicyPayload"),
    proposal: v.object({
      id: v.string(),
      status: v.string(),
      requestedBy: v.string(),
      diff: v.object({ kind: v.string() }),
    }),
  }),
});

const DecideSchema = v.object({
  decidePolicy: v.object({
    __typename: v.literal("DecidePolicyPayload"),
    proposal: v.object({ status: v.string(), decidedBy: v.nullable(v.string()) }),
    revision: v.nullable(v.object({ revision: v.number(), hash: v.string(), active: v.boolean() })),
    proposalStale: v.boolean(),
  }),
});

/** A 200 GraphQL body's root object: one key per selected field. */
const ResponseRootSchema = v.object({
  data: v.record(v.string(), v.unknown()),
});

/** A failure member, as the union serves it. */
const FailureMemberSchema = v.object({
  __typename: v.literal("PolicyFailure"),
  code: v.string(),
});

/**
 * Parse a result as one field's failure member.
 *
 * @param data - The execution result's data, awaited here so a caller passes the run promise.
 * @param field - The root field the document selects.
 * @returns The failure member; a payload of another shape is a test failure, not a returned value.
 */
async function failureOf(
  data: Promise<JsonValue | null | undefined>,
  field: "policyRevisions" | "policyProposals" | "proposePolicy" | "decidePolicy",
): Promise<{ readonly __typename: "PolicyFailure"; readonly code: string }> {
  const answer = await data;
  const record = v.parse(v.record(v.string(), v.unknown()), answer);
  const member = record[field];
  if (member === undefined) throw new Error("the result has no " + field);
  return v.parse(FailureMemberSchema, member);
}

/** Run one document against a store, with a session subject. */
async function run(
  store: Store,
  subject: string,
  query: string,
  variables: Record<string, JsonValue>,
): Promise<JsonValue | null | undefined> {
  const context = createContext({
    env: envWith(),
    requestId: "integration",
    session: { subject, expiresAt: 0 },
    reads: { project: (projectId) => store.projects.get(projectId) },
    policy: policyFaceOver(store, { bashSandbox: false }),
    maxRows: 1_000,
    maxRowsPerList: 100,
  });
  const result = await execute({
    schema,
    document: parse(query),
    contextValue: context,
    variableValues: variables,
  });
  if (result.errors !== undefined && result.errors.length > 0) {
    throw new Error(
      "the document failed: " + result.errors.map((issue) => issue.message).join("; "),
    );
  }
  // SAFETY: GraphQL's execution result is a JSON value; the handler serializes it as such.
  return result.data as JsonValue | null | undefined;
}

const REVISIONS =
  "query R($workspaceId: ID!) { policyRevisions(workspaceId: $workspaceId) { __typename ... on PolicyRevisionList { revisions { revision hash active createdBy document { readRoots writeRoots bash network } } } ... on PolicyFailure { __typename code message } } }";

const PROPOSALS =
  "query P($workspaceId: ID!, $status: PolicyProposalStatus) { policyProposals(workspaceId: $workspaceId, status: $status) { __typename ... on PolicyProposalList { proposals { id baseRevision reviewToken status requestedBy reason diff { kind added { atomKind value } removed { atomKind value } } } } ... on PolicyFailure { __typename code message } } }";

const PROPOSE =
  "mutation Propose($input: PolicyProposalInput!) { proposePolicy(input: $input) { __typename ... on ProposePolicyPayload { proposal { id status requestedBy diff { kind added { atomKind value } } } } ... on PolicyFailure { __typename code message } } }";

const DECIDE =
  "mutation Decide($input: DecidePolicyInput!) { decidePolicy(input: $input) { __typename ... on DecidePolicyPayload { proposal { id status decidedBy } revision { revision hash active } proposalStale } ... on PolicyFailure { __typename code message } } }";

/** The baseline with \`docs\` added to the read roots: an expansion the algebra can compare. */
function proposalInput(workspaceId: string, overrides: { readonly reason?: string } = {}) {
  return {
    workspaceId: toGlobalId("Project", workspaceId),
    readRoots: [".", "docs"],
    writeRoots: ["."],
    bash: false,
    network: false,
    reason: overrides.reason ?? "read the docs",
  };
}

/**
 * Run one scenario with a fresh D1 and one project row.
 *
 * @remarks
 * The project row is what the face's existence check reads; the policy rows are the ones the SQL
 * under test writes. \`harness.withStore\` opens the store with the deterministic clock and ids.
 */
async function withPolicy(
  runScenario: (store: Store, projectId: string) => Promise<void>,
): Promise<void> {
  await harness.withStore(async (store) => {
    await store.projects.create("policy", "policy");
    const projects = await store.projects.list();
    const project = projects[0];
    if (project === undefined) throw new Error("the scenario created no project");
    await runScenario(store, project.id);
  });
}

// C1: Catches: a workspace read with no revision, or revision 1 not marked active.
test("the default revision is returned as active on the real D1", async () => {
  await withPolicy(async (store, workspaceId) => {
    const data = v.parse(
      RevisionListSchema,
      await run(store, HUMAN, REVISIONS, { workspaceId: toGlobalId("Project", workspaceId) }),
    );
    expect(data.policyRevisions.revisions).toHaveLength(1);
    expect(data.policyRevisions.revisions[0]).toMatchObject({
      revision: 1,
      active: true,
      createdBy: "system",
      document: { readRoots: ["."], bash: false, network: false },
    });
    // The read really stored the baseline: the table has one revision row.
    expect(await store.policy.revisions(workspaceId)).toHaveLength(1);
  });
});

// C2 + C3: The real path the issue is about — a mutation on a D1 database: propose, then approve,
// and the revision grows.
test("an agent proposes and a human approves on the real D1, and the revision grows", async () => {
  await withPolicy(async (store, workspaceId) => {
    const proposed = v.parse(
      ProposeSchema,
      await run(store, AGENT, PROPOSE, { input: proposalInput(workspaceId) }),
    );
    expect(proposed.proposePolicy.proposal.status).toBe("PENDING");
    expect(proposed.proposePolicy.proposal.diff.kind).toBe("EXPANSION");
    // The proposal is a row, and the active policy did not move.
    const stored = await store.policy.proposals(workspaceId);
    expect(stored).toHaveLength(1);
    expect((await store.policy.active(workspaceId))?.revision).toBe(1);
    expect(await store.policy.revisions(workspaceId)).toHaveLength(1);
    const reviewToken = stored[0]?.reviewToken;
    if (reviewToken === undefined) throw new Error("the proposal was not stored");

    const decided = v.parse(
      DecideSchema,
      await run(store, HUMAN, DECIDE, {
        input: {
          proposalId: proposed.proposePolicy.proposal.id,
          reviewToken,
          approve: true,
          reason: "ok",
        },
      }),
    );
    expect(decided.decidePolicy.proposal.status).toBe("APPROVED");
    expect(decided.decidePolicy.proposal.decidedBy).toBe(HUMAN);
    expect(decided.decidePolicy.revision).toMatchObject({ revision: 2, active: true });
    expect(decided.decidePolicy.proposalStale).toBe(false);
    // The real D1 wrote the revision and moved the pointer to it.
    expect((await store.policy.active(workspaceId))?.revision).toBe(2);
    const revisions = await store.policy.revisions(workspaceId);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.hash).toBe(decided.decidePolicy.revision?.hash);
    expect(revisions[1]?.createdBy).toBe(HUMAN);
  });
});

// C4: Catches: a decision built on a policy that moved, being accepted by the CAS.
test("a decision after the policy moved is approval_stale on the real D1", async () => {
  await withPolicy(async (store, workspaceId) => {
    const first = v.parse(
      ProposeSchema,
      await run(store, AGENT, PROPOSE, { input: proposalInput(workspaceId) }),
    );
    const staleToken = (await store.policy.proposals(workspaceId))[0]?.reviewToken;
    if (staleToken === undefined) throw new Error("the proposal was not stored");
    // A second proposal, approved, moves the active revision past the first one's base.
    const second = v.parse(
      ProposeSchema,
      await run(store, AGENT, PROPOSE, {
        input: proposalInput(workspaceId, { reason: "again" }),
      }),
    );
    const secondToken = (await store.policy.proposals(workspaceId)).find(
      (proposal) => toGlobalId("PolicyProposal", proposal.id) === second.proposePolicy.proposal.id,
    )?.reviewToken;
    if (secondToken === undefined) throw new Error("the second proposal was not stored");
    v.parse(
      DecideSchema,
      await run(store, HUMAN, DECIDE, {
        input: {
          proposalId: second.proposePolicy.proposal.id,
          reviewToken: secondToken,
          approve: true,
          reason: "ok",
        },
      }),
    );
    const stale = await failureOf(
      run(store, HUMAN, DECIDE, {
        input: {
          proposalId: first.proposePolicy.proposal.id,
          reviewToken: staleToken,
          approve: true,
          reason: "ok",
        },
      }),
      "decidePolicy",
    );
    expect(stale.code).toBe("APPROVAL_STALE");
    expect((await store.policy.active(workspaceId))?.revision).toBe(2);
    expect(await store.policy.revisions(workspaceId)).toHaveLength(2);
  });
});

// C5: Catches: an agent subject approving; the refusal comes before any write.
test("an agent subject's decision is policy_denied on the real D1 and writes nothing", async () => {
  await withPolicy(async (store, workspaceId) => {
    const proposed = v.parse(
      ProposeSchema,
      await run(store, AGENT, PROPOSE, { input: proposalInput(workspaceId) }),
    );
    const token = (await store.policy.proposals(workspaceId))[0]?.reviewToken;
    if (token === undefined) throw new Error("the proposal was not stored");
    const denied = await failureOf(
      run(store, AGENT, DECIDE, {
        input: {
          proposalId: proposed.proposePolicy.proposal.id,
          reviewToken: token,
          approve: true,
          reason: "ok",
        },
      }),
      "decidePolicy",
    );
    expect(denied.code).toBe("POLICY_DENIED");
    expect((await store.policy.active(workspaceId))?.revision).toBe(1);
    expect(await store.policy.revisions(workspaceId)).toHaveLength(1);
    expect((await store.policy.proposals(workspaceId))[0]?.status).toBe("pending");
  });
});

// C6: Catches: a glob stored as a pending proposal no approval could accept — and, separately, a
// glob rule that only knows `*` and `?`, which would let `a/{b,c}` through as invalid_request.
test.each([
  ["a/*", "a star"],
  ["a/{b,c}", "a brace expansion"],
  ["a/[bc]", "a character class"],
  ["a/?.txt", "a question mark"],
])("a glob proposal is unsupported on the real D1 and stores nothing (%s)", async (root) => {
  await withPolicy(async (store, workspaceId) => {
    const refused = await failureOf(
      run(store, AGENT, PROPOSE, {
        input: { ...proposalInput(workspaceId), readRoots: [root] },
      }),
      "proposePolicy",
    );
    expect(refused.code).toBe("UNSUPPORTED");
    expect(await store.policy.proposals(workspaceId)).toHaveLength(0);
  });
});

// Catches: a NUL or a `..` root read as a normal path (the contract refuses both, and the face must
// not turn either into invalid_request or, worse, store it).
test.each([
  ["a/..", "a parent segment"],
  ["/etc", "an absolute path"],
])("a root the contract cannot compare is unsupported on the real D1 (%s)", async (root) => {
  await withPolicy(async (store, workspaceId) => {
    const refused = await failureOf(
      run(store, AGENT, PROPOSE, {
        input: { ...proposalInput(workspaceId), writeRoots: [root] },
      }),
      "proposePolicy",
    );
    expect(refused.code).toBe("UNSUPPORTED");
    expect(await store.policy.proposals(workspaceId)).toHaveLength(0);
  });
});

// C7: Catches: an empty list answering for a workspace that does not exist.
test("an unknown workspace is not_found on the real D1", async () => {
  await withPolicy(async (store) => {
    const unknown = toGlobalId("Project", "ws-missing");
    const revisions = await failureOf(
      run(store, HUMAN, REVISIONS, { workspaceId: unknown }),
      "policyRevisions",
    );
    expect(revisions.code).toBe("NOT_FOUND");
    const proposals = await failureOf(
      run(store, HUMAN, PROPOSALS, { workspaceId: unknown }),
      "policyProposals",
    );
    expect(proposals.code).toBe("NOT_FOUND");
  });
});

// Catches: a decided proposal that disappears from the default list, or a filter returning the
// wrong rows; and a diff computed against the moved active revision instead of the named base.
test("policyProposals filters by status on the real D1 and keeps the base diff", async () => {
  await withPolicy(async (store, workspaceId) => {
    const first = v.parse(
      ProposeSchema,
      await run(store, AGENT, PROPOSE, { input: proposalInput(workspaceId) }),
    );
    const token = (await store.policy.proposals(workspaceId))[0]?.reviewToken;
    if (token === undefined) throw new Error("the proposal was not stored");
    v.parse(
      DecideSchema,
      await run(store, HUMAN, DECIDE, {
        input: {
          proposalId: first.proposePolicy.proposal.id,
          reviewToken: token,
          approve: true,
          reason: "ok",
        },
      }),
    );
    const pending = v.parse(
      ProposalListSchema,
      await run(store, HUMAN, PROPOSALS, {
        workspaceId: toGlobalId("Project", workspaceId),
        status: "PENDING",
      }),
    );
    expect(pending.policyProposals.proposals).toHaveLength(0);
    const approved = v.parse(
      ProposalListSchema,
      await run(store, HUMAN, PROPOSALS, {
        workspaceId: toGlobalId("Project", workspaceId),
        status: "APPROVED",
      }),
    );
    expect(approved.policyProposals.proposals).toHaveLength(1);
    expect(approved.policyProposals.proposals[0]?.status).toBe("APPROVED");
    expect(approved.policyProposals.proposals[0]?.diff.kind).toBe("EXPANSION");
  });
});

/**
 * Run one document through the **face the edge calls**, not \`execute\` directly.
 *
 * @remarks
 * This is the HTTP path of the issue's acceptance: the body is parsed, the document validated and
 * bounded, then executed over the context the handler builds. The dependencies replace the store
 * the face would open with the harness's, which is the same seam a test of the face would use; the
 * schema, the limits, and the response envelope are production's.
 */
async function post(
  store: Store,
  subject: string,
  query: string,
  variables: Record<string, JsonValue>,
): Promise<v.InferOutput<typeof ResponseRootSchema>> {
  const face = createGraphQLFace({
    reads: { project: (projectId) => store.projects.get(projectId) },
    policy: policyFaceOver(store, { bashSandbox: false }),
  } satisfies GraphQLFaceDependencies);
  const response = await face({
    request: new Request("https://hns.test/graphql", { method: "POST" }),
    env: envWith(),
    session: { subject, expiresAt: 0 },
    requestId: "integration",
    signal: new AbortController().signal,
    body: JSON.stringify({ query, variables }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  const parsed = v.safeParse(ResponseRootSchema, body);
  if (!parsed.success) throw new Error("the response has no data: " + JSON.stringify(body));
  return parsed.output;
}

// Catches: a face whose mutation is not reachable through the handler — the acceptance path is the
// HTTP request, and a resolver-only test would not prove the document validates or that the union
// serializes.
test("decidePolicy through the HTTP face approves on the real D1", async () => {
  await withPolicy(async (store, workspaceId) => {
    const proposed = await post(store, AGENT, PROPOSE, { input: proposalInput(workspaceId) });
    const proposal = v.parse(
      v.object({
        data: v.object({
          proposePolicy: v.object({
            proposal: v.object({ id: v.string(), status: v.string() }),
          }),
        }),
      }),
      proposed,
    ).data.proposePolicy.proposal;
    expect(proposal.status).toBe("PENDING");
    const token = (await store.policy.proposals(workspaceId))[0]?.reviewToken;
    if (token === undefined) throw new Error("the proposal was not stored");
    const decided = v.parse(
      v.object({
        data: v.object({
          decidePolicy: v.object({
            revision: v.nullable(v.object({ revision: v.number() })),
            proposal: v.object({ status: v.string() }),
          }),
        }),
      }),
      await post(store, HUMAN, DECIDE, {
        input: { proposalId: proposal.id, reviewToken: token, approve: true, reason: "ok" },
      }),
    );
    expect(decided.data.decidePolicy.proposal.status).toBe("APPROVED");
    expect(decided.data.decidePolicy.revision?.revision).toBe(2);
    expect((await store.policy.active(workspaceId))?.revision).toBe(2);
  });
});

// Catches: the handler answering 200 with a payload for an agent's decision, which would hide the
// refusal from a client that only checks HTTP.
test("an agent's decidePolicy through the HTTP face is a 200 union failure", async () => {
  await withPolicy(async (store, workspaceId) => {
    const proposed = v.parse(
      ProposeSchema,
      await run(store, AGENT, PROPOSE, { input: proposalInput(workspaceId) }),
    );
    const token = (await store.policy.proposals(workspaceId))[0]?.reviewToken;
    if (token === undefined) throw new Error("the proposal was not stored");
    const body = v.parse(
      v.object({
        data: v.object({
          decidePolicy: v.object({ __typename: v.literal("PolicyFailure"), code: v.string() }),
        }),
      }),
      await post(store, AGENT, DECIDE, {
        input: {
          proposalId: proposed.proposePolicy.proposal.id,
          reviewToken: token,
          approve: true,
          reason: "ok",
        },
      }),
    );
    expect(body.data.decidePolicy.code).toBe("POLICY_DENIED");
  });
});
