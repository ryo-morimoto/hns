import type { GraphQLObjectType } from "graphql";
import { failureType, assertGraphqlCodes } from "../failure-type.ts";
import type { FailureCodeOf } from "../../failures/status.ts";

/**
 * The closed set of expected Mutation failures.
 *
 * @remarks
 * The codes are the ones the server's table gives the GraphQL face. `forbidden` is one of them
 * and only a write needs it: the edge has already proven a session exists, so a resolver refuses
 * a target the caller does not own. The Query and Mutation unions stay separate because a
 * mutation-only code must not appear in the published Query schema; the spelling of a shared
 * code is the same on both.
 */
export type MutationFailureCode = FailureCodeOf<"graphql">;

/** One expected Mutation failure; the client branches on it instead of reading a message. */
const MUTATION_FAILURE_CODES = [
  "forbidden",
  "invalid_request",
  "limit_exceeded",
  "unavailable",
] as const;

/** The type name every mutation result union carries for its failure. */
const MUTATION_FAILURE_TYPE = "MutationFailure";

/** The union member a result carries when the mutation refused without a payload. */
export interface MutationFailureView {
  readonly __typename: typeof MUTATION_FAILURE_TYPE;
  readonly code: MutationFailureCode;
  readonly message: string;
}

/** Build a failure member. */
export function mutationFailure(code: MutationFailureCode, message: string): MutationFailureView {
  return { __typename: MUTATION_FAILURE_TYPE, code, message };
}

/**
 * The failure member every mutation result union carries.
 *
 * @remarks
 * One shared instance: two modules that each built their own copy would add two types with the
 * same name to the schema, which GraphQL refuses. A schema that registers no module never
 * references it, so the published SDL stays unchanged.
 */
export const MutationFailureType: GraphQLObjectType = failureType(
  MUTATION_FAILURE_TYPE,
  assertGraphqlCodes(MUTATION_FAILURE_CODES),
);