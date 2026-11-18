import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { JsonValue } from "@hns/core";
import type { ProjectId } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import type { Store } from "@hns/store";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { createGraphQLFace, type GraphQLFaceDependencies } from "../../src/graphql/handler.ts";
import { policyFaceOver } from "../../src/graphql/policy/face.ts";
import { envWith } from "../support/edge.ts";
import decideOperation from "../../../web/src/__generated__/PolicyScreenDecideMutation.graphql.ts";
import proposeOperation from "../../../web/src/__generated__/PolicyScreenProposeMutation.graphql.ts";
import queryOperation from "../../../web/src/__generated__/PolicyScreenQuery.graphql.ts";

/**
 * The web screen's own operations, through the real GraphQL face.
 *
 * @remarks
 * The web tests answer the wire with fixtures, so they cannot tell whether the request the screen
 * sends is one the face can serve. This suite takes the **compiled operations the web app ships**
 * (`packages/web/src/__generated__/*.graphql.ts`, generated from the screen's graphql tags) and
 * posts their `params.text` to the production handler (`createGraphQLFace`) over a real D1: the
 * body is parsed, the document validated and bounded by the handler, the resolvers run, and the
 * answer is read back with the field names the screen selects. A screen that renames a field, asks
 * for a field the face does not serve, or sends an input the resolver refuses fails here.
 *
 * The dependency points web -> server, so the test lives on the server side; the web package does
 * not import the server anywhere.
 */

/** The operation text of one compiled document, which is what the browser sends. */
function textOf(operation: { readonly params: { readonly text?: string | null } }): string {
  const text = operation.params.text;
  if (text === null || text === undefined) throw new Error("the operation has no text");
  return text;
}

const QUERY = textOf(queryOperation);
const PROPOSE = textOf(proposeOperation);
const DECIDE = textOf(decideOperation);

const HUMAN = "owner";
const AGENT = "agent:agent-1";

/** A 200 body: one key per selected field. */
const ResponseSchema = v.object({ data: v.record(v.string(), v.unknown()) });

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

/** Run one operation through the handler and return its `data`. */
async function post(
  store: Store,
  subject: string,
  query: string,
  variables: Record<string, JsonValue>,
): Promise<v.InferOutput<typeof ResponseSchema>["data"]> {
  const face = createGraphQLFace({
    reads: { project: (projectId) => store.projects.get(projectId) },
    policy: policyFaceOver(store, { bashSandbox: false }),
  } satisfies GraphQLFaceDependencies);
  const response = await face({
    request: new Request("https://hns.test/graphql", { method: "POST" }),
    env: envWith(),
    session: { subject, expiresAt: 0 },
    requestId: "web-operations",
    signal: new AbortController().signal,
    body: JSON.stringify({ query, variables }),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  return v.parse(ResponseSchema, body).data;
}

/** One project and the workspace it names. */
async function withWorkspace(
  run: (store: Store, workspaceId: ProjectId) => Promise<void>,
): Promise<void> {
  await harness.withStore(async (store) => {
    const project = await store.projects.create("web", "projects/web");
    await run(store, project.id);
  });
}

/** The members of an answer's `policyRevisions` field. */
const RevisionListSchema = v.object({
  __typename: v.literal("PolicyRevisionList"),
  revisions: v.array(
    v.object({
      id: v.string(),
      revision: v.number(),
      active: v.boolean(),
      createdBy: v.string(),
      hash: v.string(),
      createdAt: v.string(),
      document: v.object({
        readRoots: v.array(v.string()),
        writeRoots: v.array(v.string()),
        bash: v.boolean(),
        network: v.boolean(),
      }),
    }),
  ),
});

/** The members of an answer's `policyProposals` field. */
const ProposalListSchema = v.object({
  __typename: v.literal("PolicyProposalList"),
  proposals: v.array(
    v.object({
      id: v.string(),
      baseRevision: v.number(),
      reviewToken: v.string(),
      status: v.string(),
      requestedBy: v.string(),
      reason: v.string(),
      createdAt: v.string(),
      candidate: v.object({
        readRoots: v.array(v.string()),
        writeRoots: v.array(v.string()),
        bash: v.boolean(),
        network: v.boolean(),
      }),
      diff: v.object({
        kind: v.string(),
        added: v.array(v.object({ atomKind: v.string(), value: v.string() })),
        removed: v.array(v.object({ atomKind: v.string(), value: v.string() })),
      }),
    }),
  ),
});

/** The members of an answer's `proposePolicy` field. */
const ProposeSchema = v.object({
  __typename: v.literal("ProposePolicyPayload"),
  proposal: v.object({ id: v.string(), status: v.string() }),
});

/** The members of an answer's `decidePolicy` field. */
const DecideSchema = v.object({
  __typename: v.literal("DecidePolicyPayload"),
  proposal: v.object({ id: v.string(), status: v.string() }),
  revision: v.nullable(v.object({ id: v.string(), revision: v.number() })),
  proposalStale: v.boolean(),
});

/**
 * The screen's read is served by the face, with the fields it selects.
 *
 * @remarks
 * Catches a screen that asks for a field the face does not serve (the handler answers 400 and
 * `post` fails at its status), one that selects a different set (the answer does not parse as the
 * screen's shapes), and a face whose `ensure` does not give a fresh workspace its revision 1.
 */
test("PolicyScreenQuery is served by the face", async () => {
  await withWorkspace(async (store, workspaceId) => {
    const answer = await post(store, HUMAN, QUERY, {
      workspaceId: toGlobalId("Project", workspaceId),
    });
    const revisions = v.parse(RevisionListSchema, answer["policyRevisions"]);
    expect(revisions.revisions).toHaveLength(1);
    expect(revisions.revisions[0]?.active).toBe(true);
    expect(revisions.revisions[0]?.document.readRoots).toStrictEqual(["."]);
    const proposals = v.parse(ProposalListSchema, answer["policyProposals"]);
    expect(proposals.proposals).toStrictEqual([]);
  });
});

/**
 * A proposal and an approval, as the screen sends them, reach the service.
 *
 * @remarks
 * The screen sends `[]` for a root list it leaves empty ("unchanged"), which is the face's own rule;
 * the token the screen displays is the one the decision must reproduce. Catches a screen whose
 * input names a field the face rejects, an approval without the displayed token, and a decision
 * whose reason the screen forgot.
 */
test("the screen's propose and decide inputs are the ones the service takes", async () => {
  await withWorkspace(async (store, workspaceId) => {
    const proposed = v.parse(
      ProposeSchema,
      (
        await post(store, AGENT, PROPOSE, {
          input: {
            workspaceId: toGlobalId("Project", workspaceId),
            readRoots: ["docs"],
            writeRoots: [],
            bash: false,
            network: false,
            reason: "docs を読むため",
          },
        })
      )["proposePolicy"],
    );
    expect(proposed.proposal.status).toBe("PENDING");

    const listed = v.parse(
      ProposalListSchema,
      (
        await post(store, HUMAN, QUERY, {
          workspaceId: toGlobalId("Project", workspaceId),
        })
      )["policyProposals"],
    );
    const pending = listed.proposals[0];
    if (pending === undefined) throw new Error("the proposal is not in the screen's read");
    // The input names "docs" and leaves writeRoots empty, which the face reads as "unchanged":
    // the candidate names "docs" for read_file, so "docs" is the atom the diff adds. Both the
    // proposal and the diff are the screen's own input round-tripped through the service.
    expect(pending.diff.added.map((entry) => entry.value)).toStrictEqual(["docs"]);
    expect(pending.diff.kind).not.toBe("EQUAL");

    const decided = v.parse(
      DecideSchema,
      (
        await post(store, HUMAN, DECIDE, {
          input: {
            proposalId: pending.id,
            reviewToken: pending.reviewToken,
            approve: true,
            reason: "ok",
          },
        })
      )["decidePolicy"],
    );
    expect(decided.proposal.status).toBe("APPROVED");
    expect(decided.revision?.revision).toBe(2);
    expect(decided.proposalStale).toBe(false);

    // The read the screen asks for after a decision sees the new active revision.
    const after = v.parse(
      RevisionListSchema,
      (
        await post(store, HUMAN, QUERY, {
          workspaceId: toGlobalId("Project", workspaceId),
        })
      )["policyRevisions"],
    );
    expect(after.revisions.map((revision) => [revision.revision, revision.active])).toStrictEqual([
      [1, false],
      [2, true],
    ]);
  });
});

/**
 * A decision the face refuses is the `PolicyFailure` the screen branches on.
 *
 * @remarks
 * Catches a client that reads a refusal as a payload (it would report an approval that never
 * happened) and a face whose stale answer is an HTTP error rather than a union member.
 */
test("a stale decision is the failure member the screen reports", async () => {
  await withWorkspace(async (store, workspaceId) => {
    const proposed = v.parse(
      ProposeSchema,
      (
        await post(store, AGENT, PROPOSE, {
          input: {
            workspaceId: toGlobalId("Project", workspaceId),
            readRoots: [],
            writeRoots: [],
            bash: false,
            network: false,
            reason: "nothing changes",
          },
        })
      )["proposePolicy"],
    );
    const listed = v.parse(
      ProposalListSchema,
      (
        await post(store, HUMAN, QUERY, {
          workspaceId: toGlobalId("Project", workspaceId),
        })
      )["policyProposals"],
    );
    const pending = listed.proposals[0];
    if (pending === undefined) throw new Error("the proposal is not in the screen's read");
    // A second proposal from the same base makes the first one's decision stale.
    await post(store, AGENT, PROPOSE, {
      input: {
        workspaceId: toGlobalId("Project", workspaceId),
        readRoots: [],
        writeRoots: [],
        bash: false,
        network: false,
        reason: "also nothing",
      },
    });
    const first = await post(store, AGENT, DECIDE, {
      input: {
        proposalId: proposed.proposal.id,
        reviewToken: pending.reviewToken,
        approve: true,
        reason: "ok",
      },
    });
    const member = v.parse(
      v.object({ __typename: v.literal("PolicyFailure"), code: v.string() }),
      first["decidePolicy"],
    );
    expect(member.code).toBe("POLICY_DENIED");
  });
});
