import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  GraphQLUnionType,
  type GraphQLFieldConfigMap,
} from "graphql";
import { POLICY_DIFF_KINDS, POLICY_PROPOSAL_STATUSES } from "@hns/core/capability";
import type { GraphQLContext } from "../context.ts";
import type { MutationModule } from "../mutations/index.ts";
import { closedEnum, PolicyFailureType } from "./failure.ts";
import { DecidePolicyInputType, PolicyProposalInputType } from "./inputs.ts";
import {
  resolveDecidePolicy,
  resolvePolicyProposals,
  resolvePolicyRevisions,
  resolveProposePolicy,
} from "./resolvers.ts";

/** The result union: the payload or a typed policy refusal. */
function resultUnion(name: string, payload: GraphQLObjectType): GraphQLUnionType {
  return new GraphQLUnionType({
    name,
    types: [payload, PolicyFailureType],
    resolveType: (value: { readonly __typename: string }): string => value.__typename,
  });
}

/** The policy object and union types the Query and Mutation roots share. */
interface PolicyTypes {
  readonly revisionListResult: GraphQLUnionType;
  readonly proposalListResult: GraphQLUnionType;
  readonly proposeResult: GraphQLUnionType;
  readonly decideResult: GraphQLUnionType;
  readonly proposalStatus: GraphQLEnumType;
}

/**
 * Build the policy types, so the Query and Mutation roots reference one instance each.
 *
 * @internal
 * @remarks
 * The GraphQL type names are the contract's (\`PolicyDocument\` / \`PolicyRevision\` /
 * \`PolicyProposal\` / \`PolicyDiff\` / \`PolicyDiffAtom\`, \`docs/capability.md\` §10). None collides
 * with a model entity, so the schema registers them through the roots that reference them.
 * \`CapabilityScope\` and \`HostPort\` are not published in Phase 1.
 */
function policyTypes(): PolicyTypes {
  const document = new GraphQLObjectType({
    name: "PolicyDocument",
    fields: {
      readRoots: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
      writeRoots: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
      bash: { type: new GraphQLNonNull(GraphQLBoolean) },
      network: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
  });
  const atom = new GraphQLObjectType({
    name: "PolicyDiffAtom",
    fields: {
      atomKind: { type: new GraphQLNonNull(GraphQLString) },
      value: { type: new GraphQLNonNull(GraphQLString) },
    },
  });
  const diff = new GraphQLObjectType({
    name: "PolicyDiff",
    fields: {
      kind: { type: new GraphQLNonNull(closedEnum("PolicyDiffKind", POLICY_DIFF_KINDS)) },
      added: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(atom))) },
      removed: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(atom))) },
    },
  });
  const proposalStatus = closedEnum("PolicyProposalStatus", POLICY_PROPOSAL_STATUSES);
  const revision = new GraphQLObjectType({
    name: "PolicyRevision",
    fields: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      workspaceId: { type: new GraphQLNonNull(GraphQLID) },
      revision: { type: new GraphQLNonNull(GraphQLInt) },
      hash: { type: new GraphQLNonNull(GraphQLString) },
      active: { type: new GraphQLNonNull(GraphQLBoolean) },
      createdAt: { type: new GraphQLNonNull(GraphQLString) },
      createdBy: { type: new GraphQLNonNull(GraphQLString) },
      document: { type: new GraphQLNonNull(document) },
    },
  });
  const proposal = new GraphQLObjectType({
    name: "PolicyProposal",
    fields: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      baseRevision: { type: new GraphQLNonNull(GraphQLInt) },
      reviewToken: { type: new GraphQLNonNull(GraphQLString) },
      status: { type: new GraphQLNonNull(proposalStatus) },
      requestedBy: { type: new GraphQLNonNull(GraphQLString) },
      reason: { type: new GraphQLNonNull(GraphQLString) },
      createdAt: { type: new GraphQLNonNull(GraphQLString) },
      decidedBy: { type: GraphQLString },
      decidedAt: { type: GraphQLString },
      decisionReason: { type: GraphQLString },
      candidate: { type: new GraphQLNonNull(document) },
      diff: { type: new GraphQLNonNull(diff) },
    },
  });
  const revisionList = new GraphQLObjectType({
    name: "PolicyRevisionList",
    fields: {
      revisions: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(revision))) },
    },
  });
  const proposalList = new GraphQLObjectType({
    name: "PolicyProposalList",
    fields: {
      proposals: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(proposal))) },
    },
  });
  const proposePayload = new GraphQLObjectType({
    name: "ProposePolicyPayload",
    fields: { proposal: { type: new GraphQLNonNull(proposal) } },
  });
  const decideRevision = new GraphQLObjectType({
    name: "DecidePolicyPayload",
    fields: {
      proposal: { type: new GraphQLNonNull(proposal) },
      /** The revision the approval made active; null when the decision was a rejection. */
      revision: { type: revision },
      /** The policy moved while the proposal row could not be stamped; the approval is still real. */
      proposalStale: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
  });
  return {
    proposalStatus,
    revisionListResult: resultUnion("PolicyRevisionListResult", revisionList),
    proposalListResult: resultUnion("PolicyProposalListResult", proposalList),
    proposeResult: resultUnion("ProposePolicyResult", proposePayload),
    decideResult: resultUnion("DecidePolicyResult", decideRevision),
  };
}

/** The types both roots share, built once at module load. */
const TYPES = policyTypes();

/**
 * The policy Query fields, added to the Query root.
 *
 * @returns The two fields, over the shared policy types.
 *
 * @remarks
 * Both take the workspace as a \`Project\` global id (the face's one conversion) and answer a list
 * result union. An unknown workspace is \`not_found\`, never an empty list: a list would tell the
 * caller the workspace exists and has no policy.
 */
export function policyQueryFields(): GraphQLFieldConfigMap<undefined, GraphQLContext> {
  return {
    policyRevisions: {
      type: new GraphQLNonNull(TYPES.revisionListResult),
      args: {
        workspaceId: { type: new GraphQLNonNull(GraphQLID) },
        first: { type: GraphQLInt },
      },
      resolve: resolvePolicyRevisions,
    },
    policyProposals: {
      type: new GraphQLNonNull(TYPES.proposalListResult),
      args: {
        workspaceId: { type: new GraphQLNonNull(GraphQLID) },
        status: { type: TYPES.proposalStatus },
      },
      resolve: resolvePolicyProposals,
    },
  };
}

/**
 * The \`policy\` feature: \`proposePolicy\` and \`decidePolicy\` on the Mutation root.
 *
 * @returns The module the Mutation root collects.
 *
 * @remarks
 * The inputs are the contract's (\`PolicyProposalInput\` / \`DecidePolicyInput\`). The authorization is
 * the resolver's (see \`./resolvers.ts\`), so registering the module cannot lift it.
 */
export function policyModule(): MutationModule {
  return {
    name: "policy",
    fields: (): GraphQLFieldConfigMap<undefined, GraphQLContext> => ({
      proposePolicy: {
        type: new GraphQLNonNull(TYPES.proposeResult),
        args: { input: { type: new GraphQLNonNull(PolicyProposalInputType) } },
        resolve: resolveProposePolicy,
      },
      decidePolicy: {
        type: new GraphQLNonNull(TYPES.decideResult),
        args: { input: { type: new GraphQLNonNull(DecidePolicyInputType) } },
        resolve: resolveDecidePolicy,
      },
    }),
  };
}
