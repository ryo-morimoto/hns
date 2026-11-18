import { GraphQLObjectType, type GraphQLFieldConfigMap } from "graphql";
import type { GraphQLContext } from "../context.ts";
import { createProjectModule } from "./create-project.ts";
import { requestGrantModule } from "./grants.ts";
import { machinesModule } from "./machines.ts";
import { trailModule } from "./trail.ts";
import { reviewModule } from "./review.ts";
import { officeModule } from "./office.ts";
import { sendMessageModule } from "./send-message.ts";
import { policyModule } from "../policy/schema.ts";

/**
 * One feature's contribution to the Mutation root.
 *
 * @remarks
 * One module per feature (D059: the schema, resolvers, and tests of a feature land together).
 * A module owns its payload and union types; it shares `MutationFailureType` from
 * `./failure.ts` so the schema carries one failure type.
 */
export interface MutationModule {
  /** The feature name; unique, and named when two modules claim the same field. */
  readonly name: string;
  /**
   * The fields this feature adds.
   *
   * @param objects - The model's object types, so a payload can name `Project` or `Trail`
   * without a second definition of that name.
   * @param overrides - The stand-in type a root defined in place of the model's (the Query root's
   * `Trail`, with the lists it resolves from its id). A payload that names that type must use
   * this instance; two types of one name are refused by GraphQL.
   * @returns The feature's field configs, keyed by GraphQL field name.
   */
  readonly fields: (
    objects: ReadonlyMap<string, GraphQLObjectType>,
    overrides: ReadonlyMap<string, GraphQLObjectType>,
  ) => GraphQLFieldConfigMap<undefined, GraphQLContext>;
}

/**
 * Every feature mutation, in declaration order.
 *
 * @remarks
 * The schema has a Mutation root exactly when this is non-empty, which keeps a deployment with
 * no writes free of an empty (and invalid) root. `createProject` is the first real feature; the
 * 0198 skeleton's fixture stays test-only.
 */
export const MUTATION_MODULES: readonly MutationModule[] = [
  createProjectModule(),
  policyModule(),
  machinesModule(),
  requestGrantModule(),
  // The chat's send face (0270n): the turn that admits a policy snapshot and opens 0226's
  // granted path.
  sendMessageModule(),
  // The Trail write face (0231, D104): createTrail and updateTrail.
  trailModule(),
  // The review face (0232, D104): the decision, the finding, and the hunk actions. Its module is
  // last so the published SDL's Mutation grows at the end.
  reviewModule(),
  // The office preview request (0237): one row and an alarm, never a job. It shares the office
  // types the Query root declared, so the union has one instance in the schema.
  officeModule(),
];

/**
 * Build the Mutation root from the feature modules.
 *
 * @param objects - The model object types the schema is built with.
 * @param modules - At least one feature module; an empty collection has no root.
 * @param overrides - The stand-in types the Query root defined; passed to every module.
 * @returns The collected root, preserving module and field declaration order.
 * @throws Error when two modules define the same field name, or when a module defines no field.
 *
 * @remarks
 * A duplicate field would otherwise be merged silently by the object type, hiding the feature
 * that lost its field. Callers that may have no module pass `undefined` to `buildSchema`
 * instead of an empty root, because GraphQL refuses a Mutation type with no fields.
 */
export function buildMutationRoot(
  objects: ReadonlyMap<string, GraphQLObjectType>,
  modules: readonly MutationModule[],
  overrides: ReadonlyMap<string, GraphQLObjectType> = new Map(),
): GraphQLObjectType {
  const fields: GraphQLFieldConfigMap<undefined, GraphQLContext> = {};
  const owners = new Map<string, string>();
  for (const module of modules) {
    for (const [name, field] of Object.entries(module.fields(objects, overrides))) {
      const owner = owners.get(name);
      if (owner !== undefined) {
        throw new Error(
          "mutation field " + name + " is defined by " + owner + " and " + module.name,
        );
      }
      owners.set(name, module.name);
      fields[name] = field;
    }
  }
  if (owners.size === 0) throw new Error("the mutation modules define no fields");
  return new GraphQLObjectType<undefined, GraphQLContext>({ name: "Mutation", fields });
}
