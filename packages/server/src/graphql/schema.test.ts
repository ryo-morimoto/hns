import { validateSchema } from "graphql";
import { expect, test } from "vitest";
import { noteMutation } from "../../test/graphql/fixture-mutation.ts";
import { buildGraphQLSchema, buildSchemaSdl } from "./schema.ts";

// Catches: an empty Mutation root, or a Mutation in the SDL, when no feature registers a write.
test("a schema with no modules has no Mutation root and no Mutation in the SDL", () => {
  const schema = buildGraphQLSchema([]);
  expect(schema.getMutationType()).toBeUndefined();
  expect(buildSchemaSdl([])).not.toMatch(/^type Mutation\b/mu);
});

// Catches: the first real write missing from the executable schema or the published SDL.
test("the default schema carries createProject", () => {
  const schema = buildGraphQLSchema();
  expect(schema.getMutationType()?.getFields()["createProject"]).toBeDefined();
  expect(buildSchemaSdl()).toMatch(/createProject\(name: String!, workspaceRoot: String!\)/u);
});

// Catches: a registered module missing from the executable schema or the published SDL.
test("a registered module appears in the schema and the SDL", () => {
  const schema = buildGraphQLSchema([noteMutation("owner")]);
  expect(schema.getMutationType()?.getFields().createNote).toBeDefined();
  expect(buildSchemaSdl([noteMutation("owner")])).toMatch(/^type Mutation \{/mu);
  expect(validateSchema(schema)).toStrictEqual([]);
});
