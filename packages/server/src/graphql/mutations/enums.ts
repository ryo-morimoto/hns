import { publicEnumName } from "@hns/core/graphql";

/**
 * Turn a closed vocabulary into GraphQL enum values.
 *
 * @param values - The closed list, in declaration order.
 * @returns One value per member; the value is the model string, unchanged.
 *
 * @remarks
 * The names follow the published output enums (`publicEnumName`: `feature` -> `FEATURE`,
 * `in_review` -> `IN_REVIEW`), so a client sends the value name it read from a Trail without a
 * translation table, and the two spellings cannot drift. Shared by the Trail module's input
 * enums and the review face's `ReviewLine` / `ReviewFile` output enums, which are the schema's
 * own vocabulary rather than the model's.
 */
export function enumValues(values: readonly string[]): Record<string, { value: string }> {
  return Object.fromEntries(values.map((value) => [publicEnumName(value), { value }]));
}
