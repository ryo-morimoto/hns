import { GraphQLBoolean, GraphQLID, GraphQLNonNull, GraphQLObjectType } from "graphql";
import { expect, test } from "vitest";
import { buildMutationRoot, type MutationModule } from "./index.ts";

const NO_OBJECTS: ReadonlyMap<string, GraphQLObjectType> = new Map();

/** A module that claims one scalar field. */
function moduleWith(name: string, field: string): MutationModule {
  return {
    name,
    fields: () => ({ [field]: { type: GraphQLBoolean } }),
  };
}

// Catches: a duplicate field silently merged, hiding the module that lost its field.
test("two modules defining the same field are refused", () => {
  expect(() =>
    buildMutationRoot(NO_OBJECTS, [moduleWith("first", "same"), moduleWith("second", "same")]),
  ).toThrow(/same/u);
});

// Catches: modules that contribute nothing producing an empty Mutation type.
test("modules with no fields are refused instead of creating an empty root", () => {
  expect(() => buildMutationRoot(NO_OBJECTS, [{ name: "empty", fields: () => ({}) }])).toThrow();
});

// Catches: a module that is never handed the schema's object types, so its payload duplicates one.
test("a module receives the model object types", () => {
  let seen: ReadonlyMap<string, GraphQLObjectType> | undefined;
  const probe: MutationModule = {
    name: "probe",
    fields: (objects) => {
      seen = objects;
      return { ok: { type: GraphQLBoolean } };
    },
  };
  const project = new GraphQLObjectType({
    name: "Project",
    fields: { id: { type: new GraphQLNonNull(GraphQLID) } },
  });
  buildMutationRoot(new Map<string, GraphQLObjectType>([["Project", project]]), [probe]);
  expect(seen?.get("Project")).toBe(project);
});

test("the root collects every module's fields", () => {
  const root = buildMutationRoot(NO_OBJECTS, [moduleWith("a", "one"), moduleWith("b", "two")]);
  expect(Object.keys(root.getFields())).toStrictEqual(["one", "two"]);
});
