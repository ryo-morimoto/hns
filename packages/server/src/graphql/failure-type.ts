import { GraphQLEnumType, GraphQLNonNull, GraphQLObjectType, GraphQLString } from "graphql";
import { publicEnumName } from "@hns/core/graphql";
import { FAILURE_STATUS, type FailureCode, type FailureCodeOf } from "../failures/status.ts";

/**
 * The GraphQL failure member: an enum of codes plus a message, for one result-union family.
 *
 * @param name - The object type name (`QueryFailure`, `MutationFailure`).
 * @param codes - The closed codes this family answers with, in the published order.
 * @returns The object type; its enum is named `<name>Code` with values from `publicEnumName`.
 *
 * @remarks
 * The enum and object used to be written twice (`schema.ts` and `mutations/failure.ts`); this is
 * the single builder. The code type is the server-wide `FailureCodeOf<"graphql">`; a code that
 * the table does not give to the GraphQL face is refused here, so a published enum value always
 * has a row. GraphQL publishes one spelling per code (`invalid_request` → `INVALID_REQUEST`).
 * @internal
 */
export function failureType(name: string, codes: readonly FailureCode[]): GraphQLObjectType {
  const codeEnum = new GraphQLEnumType({
    name: name + "Code",
    values: Object.fromEntries(codes.map((code) => [publicEnumName(code), { value: code }])),
  });
  return new GraphQLObjectType({
    name,
    fields: {
      code: { type: new GraphQLNonNull(codeEnum) },
      message: { type: new GraphQLNonNull(GraphQLString) },
    },
  });
}

/**
 * Check that every code a family publishes is a row the GraphQL face declares.
 *
 * @param codes - The codes the family's enum carries.
 * @throws Error when a code has no row for `graphql`, which is a table defect.
 * @internal
 */
export function assertGraphqlCodes(codes: readonly FailureCode[]): readonly FailureCodeOf<"graphql">[] {
  for (const code of codes) {
    const row = FAILURE_STATUS[code];
    if (!row.surfaces.some((surface) => surface === "graphql")) {
      throw new Error("GraphQL has no row for " + code);
    }
  }
  return codes as readonly FailureCodeOf<"graphql">[];
}
