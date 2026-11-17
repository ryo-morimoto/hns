import { GraphQLEnumType, GraphQLNonNull, GraphQLObjectType, GraphQLString } from "graphql";
import { publicEnumName } from "@hns/core/graphql";

/**
 * The closed set of expected Mutation failures.
 *
 * @remarks
 * The values match the Query vocabulary plus `forbidden`, which only a write needs: the edge has
 * already proven a session exists, so a resolver refuses a target the caller does not own. The
 * set is separate from `QUERY_FAILURE_CODES` so a mutation-only code never changes the published
 * Query schema.
 */
const MUTATION_FAILURE_CODES = [
  "forbidden",
  "invalid_argument",
  "limit_exceeded",
  "unavailable",
] as const;

/** One expected Mutation failure; the client branches on it instead of reading a message. */
export type MutationFailureCode = (typeof MUTATION_FAILURE_CODES)[number];

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

/** The expected failure codes, named as GraphQL enum values. */
const MutationErrorCodeEnum = new GraphQLEnumType({
  name: "MutationErrorCode",
  values: Object.fromEntries(
    MUTATION_FAILURE_CODES.map((code) => [publicEnumName(code), { value: code }]),
  ),
});

/**
 * The failure member every mutation result union carries.
 *
 * @remarks
 * One shared instance: two modules that each built their own copy would add two types with the
 * same name to the schema, which GraphQL refuses. A schema that registers no module never
 * references it, so the published SDL stays unchanged.
 */
export const MutationFailureType = new GraphQLObjectType({
  name: MUTATION_FAILURE_TYPE,
  fields: {
    code: { type: new GraphQLNonNull(MutationErrorCodeEnum) },
    message: { type: new GraphQLNonNull(GraphQLString) },
  },
});
