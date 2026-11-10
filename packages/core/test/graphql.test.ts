import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GraphQLBoolean, GraphQLEnumType, GraphQLObjectType, validateSchema } from "graphql";
import { buildSchema, buildSdl, defineEntity, EXCLUDED } from "../src/graphql/index.ts";
import { TASK_STATUSES } from "../src/types.ts";

const golden = readFileSync(new URL("./fixtures/schema.graphql", import.meta.url), "utf8");

/** A stand-in for the server's Query root; the model contributes no Query of its own. */
function dummyQuery(): GraphQLObjectType {
  return new GraphQLObjectType({ name: "Query", fields: { ok: { type: GraphQLBoolean } } });
}

test("buildSdl is deterministic", () => {
  assert.equal(buildSdl(), buildSdl());
});

// Catches: a model change that the SDL did not follow (the golden is reviewed, not regenerated blindly).
test("SDL matches the committed golden", () => {
  assert.equal(buildSdl(), golden);
});

test("the model types plus a Query root form a valid schema", () => {
  const schema = buildSchema(dummyQuery());
  assert.deepEqual(validateSchema(schema), []);
});

test("ids are exposed as ID and the brand is not part of the contract", () => {
  const sdl = buildSdl();
  assert.match(sdl, /type Project \{\n  createdAt: String!\n  id: ID!/u);
  assert.match(sdl, /  projectId: ID!/u);
  assert.match(sdl, /type Task \{\n  createdAt: String!\n  id: ID!/u);
  const typeNames = [...sdl.matchAll(/^(?:type|enum) (\w+)/gmu)].map((match) => match[1]);
  assert.deepEqual(typeNames, ["Conversation", "Project", "Task", "TaskStatus"]);
});

test("nullability follows the model", () => {
  const sdl = buildSdl();
  assert.match(sdl, /  updatedAt: String\n/u);
  assert.match(sdl, /  deletedAt: String\n/u);
  assert.match(sdl, /  isArchived: Boolean!/u);
});

test("enum names are SCREAMING_SNAKE_CASE and keep the model values", () => {
  const schema = buildSchema(dummyQuery());
  const type = schema.getType("TaskStatus");
  assert.ok(type instanceof GraphQLEnumType);
  assert.deepEqual(
    type.getValues().map((value) => value.name),
    ["TODO", "DOING", "DONE", "BLOCKED"],
  );
  assert.deepEqual(
    type.getValues().map((value) => value.value),
    [...TASK_STATUSES],
  );
});

test("every excluded model type says why", () => {
  for (const entry of EXCLUDED) {
    assert.ok(entry.reason.length > 0, entry.type + " has no reason");
  }
  const names = EXCLUDED.map((entry) => entry.type);
  assert.equal(new Set(names).size, names.length);
});

// Catches: a boolean field whose name does not tell the reader it is a boolean.
test("boolean fields need an is/has prefix", () => {
  assert.throws(() =>
    defineEntity<{ archived: boolean }>({
      name: "Naming",
      fields: { archived: { name: "archived", kind: "scalar", type: "Boolean", nonNull: true } },
    }),
  );
});

test("duplicate GraphQL field names are rejected", () => {
  assert.throws(() =>
    defineEntity<{ a: string; b: string }>({
      name: "Dup",
      fields: {
        a: { name: "same", kind: "scalar", type: "String", nonNull: true },
        b: { name: "same", kind: "scalar", type: "String", nonNull: true },
      },
    }),
  );
});

test("reserved names are rejected", () => {
  assert.throws(() =>
    defineEntity<{ a: string }>({
      name: "Reserved",
      fields: { a: { name: "__a", kind: "scalar", type: "String", nonNull: true } },
    }),
  );
});

test("camelCase field names are explicit, not derived", () => {
  const sdl = buildSdl();
  assert.match(sdl, /  projectId: ID!/u);
  assert.match(sdl, /  createdAt: String!/u);
  assert.ok(!sdl.includes("project_id"));
  assert.ok(!sdl.includes("created_at"));
});
