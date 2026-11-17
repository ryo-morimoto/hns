import { GraphQLEnumType, GraphQLNonNull, GraphQLObjectType, GraphQLString } from "graphql";
import { publicEnumName } from "@hns/core/graphql";

/**
 * The closed set of codes a policy face answers with.
 *
 * @remarks
 * These are the contract's five (`docs/capability.md` §10), and they are **not** the
 * `QueryFailure` / `MutationFailure` vocabulary: widening either would let a policy refusal appear
 * in a schema every other field shares, and the client branches on the union member's type before
 * it branches on a code. `approval_stale` and `unsupported` are the service's own refusal codes
 * ; `not_found` is the face's when the workspace does not exist; `invalid_request` is the
 * face's when an argument or an input is malformed; `policy_denied` is "this principal may not".
 */
export const POLICY_ERROR_CODES = [
  "policy_denied",
  "approval_stale",
  "unsupported",
  "not_found",
  "invalid_request",
] as const;

/** One expected policy refusal. */
export type PolicyErrorCode = (typeof POLICY_ERROR_CODES)[number];

/** The type name every policy result union carries for its failure. */
const POLICY_FAILURE_TYPE = "PolicyFailure";

/** The union member a policy result carries when the operation refused. */
export interface PolicyFailureView {
  readonly __typename: typeof POLICY_FAILURE_TYPE;
  readonly code: PolicyErrorCode;
  readonly message: string;
}

/** Build a policy refusal member. */
export function policyFailure(code: PolicyErrorCode, message: string): PolicyFailureView {
  return { __typename: POLICY_FAILURE_TYPE, code, message };
}

/**
 * The failure member every policy result union carries.
 *
 * @remarks
 * One shared instance: two modules that each built their own copy would add two types with the
 * same name, which GraphQL refuses.
 */
export const PolicyFailureType: GraphQLObjectType = new GraphQLObjectType({
  name: POLICY_FAILURE_TYPE,
  fields: {
    code: {
      type: new GraphQLNonNull(closedEnum(POLICY_FAILURE_TYPE + "Code", POLICY_ERROR_CODES)),
    },
    message: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/**
 * A GraphQL enum over a closed vocabulary, spelled as the face publishes it.
 *
 * @param name - The GraphQL enum name.
 * @param values - The closed vocabulary, in published order.
 * @returns The enum; each value's GraphQL spelling is `publicEnumName`'s, and the resolver still
 * sees the model value.
 *
 * @remarks
 * The one builder the policy types share. `enumOf` in `@hns/core/graphql` cannot be used here: it is
 * typed over the model's `EnumRegistry`, and a face-local vocabulary (`PolicyProposalStatus`,
 * `PolicyDiffKind`, `PolicyErrorCode`) is not in it. Building the enum by hand in two places would
 * let one spelling drift, so both `failure.ts` and `schema.ts` call this.
 */
export function closedEnum(name: string, values: readonly string[]): GraphQLEnumType {
  return new GraphQLEnumType({
    name,
    values: Object.fromEntries(values.map((value) => [publicEnumName(value), { value }])),
  });
}
