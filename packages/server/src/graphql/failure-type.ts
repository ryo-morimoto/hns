import { GraphQLEnumType, GraphQLNonNull, GraphQLObjectType, GraphQLString } from "graphql";
import { publicEnumName } from "@hns/core/graphql";
import { FAILURE_STATUS, type FailureCode, type FailureCodeOf } from "../failures/status.ts";

/**
 * The GraphQL failure member: an enum of codes plus a message, for one result-union family.
 *
 * @param name - The object type name (`QueryFailure`, `MutationFailure`).
 * @param codes - The codes this family answers with, in the published order; each must be a row
 * the GraphQL face declares, which {@link allGraphqlCodes} proves.
 * @returns The object type; its enum is named `<name>Code` with values from `publicEnumName`.
 *
 * @remarks
 * The enum and object used to be written twice (`schema.ts` and `mutations/failure.ts`); this is
 * the single builder. GraphQL publishes one spelling per code (`invalid_request` →
 * `INVALID_REQUEST`), so a published enum value always has a row.
 * @internal
 */
export function failureType(
  name: string,
  codes: readonly FailureCodeOf<"graphql">[],
): GraphQLObjectType {
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
 * Check a family's code list and narrow it to the rows the GraphQL face declares.
 *
 * @param codes - The codes the family's enum carries.
 * @returns The same codes, typed as the GraphQL face's vocabulary.
 * @throws Error when a code has no row for `graphql`, which is a table defect.
 *
 * @remarks
 * Every code is checked against the table at run time before the list goes on; the throw is the
 * only way a code the face does not declare can reach the published schema.
 * @internal
 */
export function allGraphqlCodes(
  codes: readonly FailureCode[],
): readonly FailureCodeOf<"graphql">[] {
  for (const code of codes) {
    if (!FAILURE_STATUS[code].surfaces.some((surface) => surface === "graphql")) {
      throw new Error("GraphQL has no row for " + code);
    }
  }
  return codes.filter(isGraphqlCode);
}

/** Whether one code is a row the GraphQL face declares. */
function isGraphqlCode(code: FailureCode): code is FailureCodeOf<"graphql"> {
  return FAILURE_STATUS[code].surfaces.some((surface) => surface === "graphql");
}
