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
 * (0223); `not_found` is the face's when the workspace does not exist; `invalid_request` is the
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
      type: new GraphQLNonNull(
        new GraphQLEnumType({
          name: POLICY_FAILURE_TYPE + "Code",
          values: Object.fromEntries(
            POLICY_ERROR_CODES.map((code) => [publicEnumName(code), { value: code }]),
          ),
        }),
      ),
    },
    message: { type: new GraphQLNonNull(GraphQLString) },
  },
});
