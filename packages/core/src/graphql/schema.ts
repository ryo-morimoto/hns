import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  printType,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type GraphQLScalarType,
  type GraphQLSchemaConfig,
} from "graphql";
import { ENTITIES, ENUMS } from "./entities.ts";
import type { EntityDef, RegisteredField } from "./spec.ts";

/**
 * Deterministic order for types and fields: ascending by name.
 *
 * @internal
 */
function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Resolve a GraphQL built-in scalar name.
 *
 * @internal
 * @throws Error when `name` is not one of the five built-ins, which means the spec and the
 * runtime registry disagree.
 */
function scalarType(name: string): GraphQLScalarType {
  switch (name) {
    case "ID":
      return GraphQLID;
    case "String":
      return GraphQLString;
    case "Int":
      return GraphQLInt;
    case "Float":
      return GraphQLFloat;
    case "Boolean":
      return GraphQLBoolean;
    default:
      throw new Error("unknown scalar: " + name);
  }
}

/**
 * Build every enum type, before objects so object fields can reference them.
 *
 * @internal
 */
function createEnums(): Map<string, GraphQLEnumType> {
  const out = new Map<string, GraphQLEnumType>();
  for (const def of ENUMS) {
    const values: Record<string, { value: string }> = {};
    for (const value of def.values) values[value.name] = { value: value.value };
    out.set(def.name, new GraphQLEnumType({ name: def.name, values }));
  }
  return out;
}

/**
 * Resolve one field's GraphQL output type.
 *
 * @internal
 * @throws Error when the field names a type that is not registered.
 */
function outputType(
  field: RegisteredField,
  enums: Map<string, GraphQLEnumType>,
  objects: Map<string, GraphQLObjectType>,
): GraphQLOutputType {
  const base: GraphQLScalarType | GraphQLEnumType | GraphQLObjectType | undefined =
    field.kind === "scalar"
      ? scalarType(field.typeName)
      : field.kind === "enum"
        ? enums.get(field.typeName)
        : objects.get(field.typeName);
  if (base === undefined) throw new Error("GraphQL type is not registered: " + field.typeName);
  if (field.kind === "objectList") {
    // `elementNonNull` is only absent on a hand-written spec, which does not compile; null is the
    // GraphQL default, so the missing case is the one that refuses less.
    const list = new GraphQLList(field.elementNonNull === false ? base : new GraphQLNonNull(base));
    return field.nonNull ? new GraphQLNonNull(list) : list;
  }
  return field.nonNull ? new GraphQLNonNull(base) : base;
}

/**
 * Build every object type. Fields are resolved lazily, so an entity may reference itself or a
 * type declared later.
 *
 * @internal
 */
function createObjects(enums: Map<string, GraphQLEnumType>): Map<string, GraphQLObjectType> {
  const out = new Map<string, GraphQLObjectType>();
  for (const def of ENTITIES) {
    out.set(
      def.name,
      new GraphQLObjectType({
        name: def.name,
        fields: () => fieldsOf(def, enums, out),
      }),
    );
  }
  return out;
}

/**
 * The fields of one entity, sorted by name so the SDL is stable.
 *
 * @internal
 */
function fieldsOf(
  def: EntityDef,
  enums: Map<string, GraphQLEnumType>,
  objects: Map<string, GraphQLObjectType>,
) {
  return Object.fromEntries(
    [...def.fields]
      .sort(byName)
      .map((field) => [field.name, { type: outputType(field, enums, objects) }]),
  );
}

/**
 * Every type the model contributes, sorted by name.
 *
 * @returns All enum and object types, sorted by name so repeated calls produce the same order.
 *
 * @remarks
 * Enums are created before objects; object fields are resolved lazily, so declaration order in
 * `entities.ts` does not affect the result. The enums are made **once per process** and reused:
 * `buildSchema` registers a schema's types by instance, so a caller that names an enum across two
 * calls (the server's `Trail.gates` does, for the two gate enums) would otherwise put two
 * instances of one name in one schema, which GraphQL refuses.
 */
export function buildTypes(): readonly GraphQLNamedType[] {
  const enums = modelEnums();
  const objects = createObjects(enums);
  return [...enums.values(), ...objects.values()].sort(byName);
}

/** The model's enums, made once per process: a schema holds one instance per name. */
let sharedEnums: Map<string, GraphQLEnumType> | undefined;

/**
 * The model's enums, as the one set every schema build shares.
 *
 * @internal
 * @returns The enums by name.
 */
function modelEnums(): Map<string, GraphQLEnumType> {
  sharedEnums ??= createEnums();
  return sharedEnums;
}

/**
 * The SDL fragment for the model. No Query: the server adds it with its resolvers,
 * and Relay receives the complete schema from the web package.
 *
 * @param mutation - Optional builder for a Mutation root. Omitted, the SDL carries no Mutation
 * type at all; the model alone contributes nothing writable.
 * @returns The generated SDL, including the "do not edit" header and a trailing newline.
 *
 * @remarks
 * Deterministic: types and fields are sorted by name and enum values keep declaration order, so
 * the committed golden can be compared byte for byte. When a Mutation root is given, only that
 * root is printed after the model types; its payload and union types belong to the caller, which
 * prints the complete schema with `printSchema` (the server does).
 */
export function buildSdl(mutation?: MutationRootFactory): string {
  const header = "# Generated by @hns/core (buildSdl). Do not edit by hand.";
  const enums = modelEnums();
  const objects = createObjects(enums);
  const printed = [...enums.values(), ...objects.values()]
    .sort(byName)
    .map((type) => printType(type));
  if (mutation !== undefined) printed.push(printType(mutation(objects, new Map())));
  return [header, ...printed].join("\n\n") + "\n";
}

/**
 * Builds a Query root from the model's object types.
 *
 * @param objects - The model's object instances, so a Query field can name `Project` or
 * `Conversation` without defining a second type of that name.
 * @param overrides - The types the roots define in place of the model's, by name; empty when the
 * factory runs. The server offers its own `Trail` (the row plus the lists resolved from its id);
 * a field that names a Trail uses that instance, and the root records it here so every later root
 * and payload names the same one. A schema holds one type per name.
 *
 * @remarks
 * Enums are not in the map; a Query field that needs a model enum reaches for `ENUMS` or the map
 * grows in a later change.
 */
export type QueryRootFactory = (
  objects: ReadonlyMap<string, GraphQLObjectType>,
  overrides: ReadonlyMap<string, GraphQLObjectType>,
) => GraphQLObjectType;

/**
 * Builds a Mutation root from the model's object types.
 *
 * @remarks
 * The same contract as {@link QueryRootFactory}. It is optional everywhere because GraphQL
 * refuses a Mutation root with no fields: a build that passes no factory has no Mutation type
 * rather than an empty one.
 */
export type MutationRootFactory = QueryRootFactory;

/**
 * The schema a server serves: the model types plus the caller's Query root.
 * Ordering is deterministic by construction (types and fields sorted by name, enum values in
 * declaration order), so the schema and the SDL artifact cannot disagree.
 *
 * @param query - Builds the server's Query root from the model's object types. The root shares
 * the very instances the schema is built with, so a Query field can name `Project` or
 * `Conversation` without a duplicate definition.
 * @param mutation - Builds the server's Mutation root from the same object types. Omitted, the
 * schema has no Mutation type; an empty Mutation root is never created.
 * @returns A schema containing the model types, the Query root, and the Mutation root when given.
 *
 * @remarks
 * The factories run after the object types exist; they must not create a second `Project` type.
 * When a root names a type of its own that stands in for a model type (the server's `Trail` adds
 * the lists a Trail resolves from its id), the root's instance replaces the model's in the
 * schema's type list: GraphQL holds one type per name, and it prints the one a root reaches.
 */
export function buildSchema(
  query: QueryRootFactory,
  mutation?: MutationRootFactory,
): GraphQLSchema {
  const enums = modelEnums();
  const objects = createObjects(enums);
  // A stand-in a root offers replaces the model's type of that name. `overrides` is handed to
  // every factory: the Query root records its `Trail` there, and the Mutation root reads it back,
  // so a payload and a field name one instance.
  const overrides = new Map<string, GraphQLObjectType>();
  const root = withStandIns(query(objects, overrides), overrides);
  const mutationRoot =
    mutation === undefined ? undefined : withStandIns(mutation(objects, overrides), overrides);
  // Materialize the field maps now, outside the walk below: a type's fields are a thunk, and
  // reading them while the walk is still collecting would resolve references before they exist.
  for (const field of Object.values(root.getFields())) void field;
  if (mutationRoot !== undefined) {
    for (const field of Object.values(mutationRoot.getFields())) void field;
  }
  const config: GraphQLSchemaConfig = {
    query: root,
    types: [...enums.values(), ...objects.values()].sort(byName),
  };
  if (mutationRoot !== undefined) config.mutation = mutationRoot;
  config.types = typesReachedFrom({
    query: root,
    mutation: mutationRoot,
    types: config.types ?? [],
  });
  return new GraphQLSchema(config);
}

/**
 * Record the model types a root defines in place of the model's.
 *
 * @internal
 * @param root - The root a factory built.
 * @param overrides - The map the schema keeps the stand-ins in; filled here.
 * @returns The root, unchanged.
 *
 * @remarks
 * A root that says "I define `Trail` myself" names a field by it, and that field's type is the
 * root's object rather than the model's. The first such type per name wins; a second would be a
 * second type of the same name, which GraphQL refuses, so it is left for that refusal.
 */
function withStandIns(
  root: GraphQLObjectType,
  overrides: Map<string, GraphQLObjectType>,
): GraphQLObjectType {
  for (const field of Object.values(root.getFields())) {
    const named = objectInside(field.type);
    if (named !== undefined && !overrides.has(named.name)) overrides.set(named.name, named);
  }
  return root;
}

/**
 * The object type inside a field's output type, or undefined when the field is not an object.
 *
 * @internal
 * @remarks
 * Only the field's own type is considered: a union's members are a feature's payloads, not the
 * model objects the feature names on its fields. A stand-in is named by a field directly (the
 * `TrailList` payload's `trails: [Trail!]!`).
 */
function objectInside(type: GraphQLOutputType): GraphQLObjectType | undefined {
  let current: GraphQLOutputType = type;
  while (current instanceof GraphQLNonNull || current instanceof GraphQLList)
    current = current.ofType;
  return current instanceof GraphQLObjectType ? current : undefined;
}

/**
 * The schema's type list, with each root's stand-in type replaced by the root's instance.
 *
 * @internal
 * @param roots - The roots and the model's types.
 * @returns The model types, sorted, with a model type the roots define replaced by theirs.
 *
 * @remarks
 * A named type is unique per schema. A root that defines its own object with a model type's name
 * is that type for this schema; keeping the model's instance beside it would make the schema
 * invalid, and printing the model's instance would drop the field the root added.
 */
function typesReachedFrom(roots: {
  readonly query: GraphQLObjectType;
  readonly mutation: GraphQLObjectType | undefined;
  readonly types: readonly GraphQLNamedType[];
}): readonly GraphQLNamedType[] {
  const byNameOf = new Map<string, GraphQLNamedType>();
  for (const type of roots.types) byNameOf.set(type.name, type);
  // One seen-set for the whole walk: the first instance of a name the roots reach is the one the
  // schema keeps. A model type reached through a stand-in (`TrailList` -> `Trail`) is skipped
  // because the stand-in was entered first through the field that names it directly.
  const seen = new Set<string>();
  for (const root of [roots.query, roots.mutation]) {
    if (root === undefined) continue;
    seen.add(root.name);
    for (const field of Object.values(root.getFields())) {
      visitObjects(field.type, seen, (named) => {
        if (byNameOf.has(named.name)) byNameOf.set(named.name, named);
      });
    }
  }
  return [...byNameOf.values()].sort(byName);
}

/**
 * Call `visit` for every object type reachable from a field's output type.
 *
 * @internal
 * @param type - The field's output type.
 * @param seen - The type names the walk has entered; shared across the whole schema so each name
 * is visited once.
 * @param visit - Called once per object type entered.
 *
 * @remarks
 * The walk is bounded by `seen`: a type may reach itself (`Trail` through a list of its own) and
 * a union reaches its members, so both are entered and the second visit stops.
 */
function visitObjects(
  type: GraphQLOutputType,
  seen: Set<string>,
  visit: (type: GraphQLObjectType) => void,
): void {
  const walk = (current: GraphQLOutputType): void => {
    if (current instanceof GraphQLNonNull || current instanceof GraphQLList) {
      walk(current.ofType);
      return;
    }
    if (seen.has(current.name)) return;
    seen.add(current.name);
    if (current instanceof GraphQLObjectType) {
      visit(current);
      for (const field of Object.values(current.getFields())) walk(field.type);
    } else if (current instanceof GraphQLUnionType) {
      for (const member of current.getTypes()) walk(member);
    }
  };
  walk(type);
}
