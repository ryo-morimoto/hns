import type { PolicyProposalStatus, PolicyRevision } from "@hns/core/capability";
import type { ProjectId } from "@hns/core";
import type { GraphQLContext } from "../context.ts";
import type { HumanPrincipal } from "../../policy/principals.ts";
import { isHumanPrincipal, principalOf } from "../../policy/principals.ts";
import { policyFailure, type PolicyErrorCode, type PolicyFailureView } from "./failure.ts";
import type { DecideOutcome, PolicyOutcome } from "./face.ts";
import { decideInputOf, proposeInputOf, statusOf, workspaceIdOf } from "./inputs.ts";
import {
  policyProposalView,
  policyRevisionView,
  type PolicyProposalView,
  type PolicyRevisionView,
} from "./views.ts";

/**
 * The Query and Mutation resolvers of the policy face (\`docs/capability.md\` §10).
 *
 * @remarks
 * **Who may approve, and the hole.** The session the edge verified names a subject and nothing
 * else, so {@link principalOf} reads it: a subject in the agent namespace is an agent, and every
 * other subject is a human. That is a **default, not an identity proof**. Until the login face gives the
 * session a \`kind\`, an agent that holds a person's \`hns_session\` cookie is indistinguishable from
 * that person **here**, and could approve a proposal. What this face guarantees is the part it
 * can: an agent subject cannot decide (checked here, and again in the service), and no path turns
 * an agent credential into a {@link HumanPrincipal}. The remaining hole belongs to the login
 * face, and the issue's Result records it.
 *
 * The policy port answers with an outcome for every operation; an outage is a \`QueryReadError\` the
 * context raises, and an outage is **not** a policy code, so it propagates to the handler's
 * \`unavailable\` instead of borrowing one of the five published codes.
 */

/** The result of \`Query.policyRevisions\`. */
export interface PolicyRevisionListSuccess {
  readonly __typename: "PolicyRevisionList";
  readonly revisions: readonly PolicyRevisionView[];
}
/** The result of \`Query.policyProposals\`. */
export interface PolicyProposalListSuccess {
  readonly __typename: "PolicyProposalList";
  readonly proposals: readonly PolicyProposalView[];
}
/** The result of \`Mutation.proposePolicy\`. */
export interface ProposePolicyPayload {
  readonly __typename: "ProposePolicyPayload";
  readonly proposal: PolicyProposalView;
}
/** The result of \`Mutation.decidePolicy\`. */
export interface DecidePolicyPayload {
  readonly __typename: "DecidePolicyPayload";
  readonly proposal: PolicyProposalView;
  /** The revision the approval made active, or null when the decision was a rejection. */
  readonly revision: PolicyRevisionView | null;
  /** The policy moved while the proposal row could not be stamped; the approval is still real. */
  readonly proposalStale: boolean;
}

/** One result union member. */
export type PolicyRevisionListResult = PolicyRevisionListSuccess | PolicyFailureView;
/** One result union member. */
export type PolicyProposalListResult = PolicyProposalListSuccess | PolicyFailureView;
/** One result union member. */
export type ProposePolicyResult = ProposePolicyPayload | PolicyFailureView;
/** One result union member. */
export type DecidePolicyResult = DecidePolicyPayload | PolicyFailureView;

/** The \`proposePolicy\` input as GraphQL hands it to the resolver. */
export interface ProposePolicyArguments {
  readonly workspaceId: string;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  readonly bash: boolean;
  readonly network: boolean;
  readonly reason: string;
}

/** The \`decidePolicy\` input as GraphQL hands it to the resolver. */
export interface DecidePolicyArguments {
  readonly proposalId: string;
  readonly reviewToken: string;
  readonly approve: boolean;
  readonly reason: string;
}

/** A refusal as the union member. */
function failureOf(code: PolicyErrorCode, message: string): PolicyFailureView {
  return policyFailure(code, message);
}

/**
 * Read a `PolicyOutcome` as its value, or its failure member.
 *
 * @internal
 * @remarks
 * The port answers with the outcome union, so the resolver narrows once here instead of repeating
 * the three-branch check in every field. `left` is the value when it succeeded, `right` the union
 * member when it did not.
 */
function either<T>(
  outcome: PolicyOutcome<T>,
): { readonly left: T } | { readonly right: PolicyFailureView } {
  return outcome.ok ? { left: outcome.value } : { right: failureOf(outcome.code, outcome.message) };
}

/** Whether the workspace has a project row; the face's existence check. */
async function workspaceExists(workspaceId: ProjectId, context: GraphQLContext): Promise<boolean> {
  return (await context.reads.project(workspaceId)) !== undefined;
}

/**
 * Resolve \`Query.policyRevisions\`.
 *
 * @param _source - Always undefined; Query fields have no parent value.
 * @param args - The workspace (a \`Project\` global id) and the page size.
 * @param context - The request's reads and the policy port.
 * @returns The workspace's revisions with the active flag, or a union failure.
 *
 * @remarks
 * Reading opens the workspace's baseline policy (the idempotent \`ensure\`), so a workspace that
 * exists always answers at least revision 1; \`not_found\` therefore means the workspace, not the
 * policy.
 */
export async function resolvePolicyRevisions(
  _source: undefined,
  args: {
    readonly workspaceId?: string | null | undefined;
    readonly first?: number | null | undefined;
  },
  context: GraphQLContext,
): Promise<PolicyRevisionListResult> {
  const workspace = workspaceIdOf(args.workspaceId);
  if (!workspace.ok) return failureOf("invalid_request", workspace.message);
  const first = args.first ?? context.maxRowsPerList;
  if (!Number.isInteger(first) || first < 1 || first > context.maxRowsPerList) {
    return failureOf(
      "invalid_request",
      "first must be an integer between 1 and " + String(context.maxRowsPerList) + ".",
    );
  }
  if (!(await workspaceExists(workspace.value, context))) {
    return failureOf("not_found", "No workspace has this id.");
  }
  const read = either(await context.policy.revisions(workspace.value));
  if ("right" in read) return read.right;
  const revisions: readonly PolicyRevision[] = read.left.revisions;
  return {
    __typename: "PolicyRevisionList",
    revisions: revisions
      .slice(0, first)
      .map((revision) => policyRevisionView(revision, read.left.active)),
  };
}

/**
 * Resolve \`Query.policyProposals\`.
 *
 * @param _source - Always undefined; Query fields have no parent value.
 * @param args - The workspace and the status to keep (absent means every status).
 * @param context - The request's reads and the policy port.
 * @returns The proposals newest first, each with its diff, or a union failure.
 */
export async function resolvePolicyProposals(
  _source: undefined,
  args: {
    readonly workspaceId?: string | null | undefined;
    /** GraphQL coerces this to the enum's value; absent means every status. */
    readonly status?: PolicyProposalStatus | null | undefined;
  },
  context: GraphQLContext,
): Promise<PolicyProposalListResult> {
  const workspace = workspaceIdOf(args.workspaceId);
  if (!workspace.ok) return failureOf("invalid_request", workspace.message);
  const status = statusOf(args.status);
  if (!status.ok) return failureOf("invalid_request", status.message);
  if (!(await workspaceExists(workspace.value, context))) {
    return failureOf("not_found", "No workspace has this id.");
  }
  const read = either(await context.policy.proposals(workspace.value, status.value));
  if ("right" in read) return read.right;
  return {
    __typename: "PolicyProposalList",
    proposals: read.left.map((entry) => policyProposalView(entry.proposal, entry.diff)),
  };
}

/**
 * Resolve \`Mutation.proposePolicy\`.
 *
 * @param _source - Always undefined; Mutation fields have no parent value.
 * @param args - The \`PolicyProposalInput\`.
 * @param context - The verified session and the policy port.
 * @returns The pending proposal with its diff, or a union failure.
 *
 * @remarks
 * A proposal changes nothing active, and an agent may make one: it is a request to a human. The
 * document is built from the four atoms the contract publishes for a proposal, so a client cannot
 * propose a shape the algebra cannot compare; where the contract accepts a shape and refuses it,
 * the answer is the policy code (\`network: true\` and a glob root are \`unsupported\`, not a
 * malformed input).
 */
export async function resolveProposePolicy(
  _source: undefined,
  args: { readonly input: ProposePolicyArguments },
  context: GraphQLContext,
): Promise<ProposePolicyResult> {
  const input = proposeInputOf(args.input);
  if (!input.ok) return failureOf(input.code, input.message);
  if (!(await workspaceExists(input.value.workspaceId, context))) {
    return failureOf("not_found", "No workspace has this id.");
  }
  const proposed = either(
    await context.policy.propose(principalOf(context.session.subject), {
      workspaceId: input.value.workspaceId,
      candidate: input.value.document,
      reason: input.value.reason,
    }),
  );
  if ("right" in proposed) return proposed.right;
  return {
    __typename: "ProposePolicyPayload",
    proposal: policyProposalView(proposed.left.proposal, proposed.left.diff),
  };
}

/**
 * Resolve \`Mutation.decidePolicy\`.
 *
 * @param _source - Always undefined; Mutation fields have no parent value.
 * @param args - The \`DecidePolicyInput\`.
 * @param context - The verified session and the policy port.
 * @returns The decided proposal and, when approved, the revision the approval made active.
 *
 * @remarks
 * **Only a human may decide.** The principal is read from the session and checked here, before
 * the service is called; the service checks again, and either refusal is \`policy_denied\`.
 * The review token is part of the input so the human's client names the view it decided on; the
 * service recomputes the token from the stored proposal's inputs and answers \`approval_stale\`
 * when the stored one no longer matches, so a token the client invents cannot pass.
 */
export async function resolveDecidePolicy(
  _source: undefined,
  args: { readonly input: DecidePolicyArguments },
  context: GraphQLContext,
): Promise<DecidePolicyResult> {
  const actor = principalOf(context.session.subject);
  if (!isHumanPrincipal(actor)) {
    return failureOf("policy_denied", "Only a human may decide a policy proposal.");
  }
  const human: HumanPrincipal = actor;
  const input = decideInputOf(args.input);
  if (!input.ok) return failureOf("invalid_request", input.message);
  const decided = either(
    await context.policy.decide(human, {
      proposalId: input.value.proposalId,
      reviewToken: input.value.reviewToken,
      decision: input.value.approve ? "approve" : "reject",
      reason: input.value.reason,
    }),
  );
  if ("right" in decided) return decided.right;
  const outcome: DecideOutcome = decided.left;
  if (outcome.kind === "rejected") {
    return {
      __typename: "DecidePolicyPayload",
      proposal: policyProposalView(outcome.proposal, outcome.diff),
      revision: null,
      proposalStale: false,
    };
  }
  return {
    __typename: "DecidePolicyPayload",
    proposal: policyProposalView(outcome.proposal, outcome.diff),
    revision: policyRevisionView(outcome.revision, outcome.revision.revision),
    proposalStale: outcome.proposalStale,
  };
}
