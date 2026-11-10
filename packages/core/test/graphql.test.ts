import assert from "node:assert/strict";
import { expect, test } from "vitest";
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
  expect(buildSdl()).toBe(buildSdl());
});

// Catches: a model change that the SDL did not follow (the golden is reviewed, not regenerated blindly).
test("SDL matches the committed golden", () => {
  expect(buildSdl()).toBe(golden);
});

test("the model types plus a Query root form a valid schema", () => {
  const schema = buildSchema(dummyQuery());
  expect(validateSchema(schema)).toStrictEqual([]);
});

test("ids are exposed as ID and the brand is not part of the contract", () => {
  const sdl = buildSdl();
  expect(sdl).toMatch(/type Project \{\n  createdAt: String!\n  id: ID!/u);
  expect(sdl).toMatch(/  projectId: ID!/u);
  expect(sdl).toMatch(/type Task \{\n  createdAt: String!\n  id: ID!/u);
  const typeNames = [...sdl.matchAll(/^(?:type|enum) (\w+)/gmu)].map((match) => match[1]);
  expect(typeNames).toStrictEqual(["Conversation", "Project", "Task", "TaskStatus"]);
});

test("nullability follows the model", () => {
  const sdl = buildSdl();
  expect(sdl).toMatch(/  updatedAt: String\n/u);
  expect(sdl).toMatch(/  deletedAt: String\n/u);
  expect(sdl).toMatch(/  isArchived: Boolean!/u);
});

test("enum names are SCREAMING_SNAKE_CASE and keep the model values", () => {
  const schema = buildSchema(dummyQuery());
  const type = schema.getType("TaskStatus");
  assert.ok(type instanceof GraphQLEnumType);
  expect(type.getValues().map((value) => value.name)).toStrictEqual([
    "TODO",
    "DOING",
    "DONE",
    "BLOCKED",
  ]);
  expect(type.getValues().map((value) => value.value)).toStrictEqual([...TASK_STATUSES]);
});

test("every excluded model type says why", () => {
  for (const entry of EXCLUDED) {
    expect(entry.reason.length, entry.type + " has no reason").toBeGreaterThan(0);
  }
  const names = EXCLUDED.map((entry) => entry.type);
  expect(new Set(names).size).toBe(names.length);
});

// Catches: a boolean field whose name does not tell the reader it is a boolean.
test("boolean fields need an is/has prefix", () => {
  expect(() =>
    defineEntity<{ archived: boolean }>({
      name: "Naming",
      fields: { archived: { name: "archived", kind: "scalar", type: "Boolean", nonNull: true } },
    }),
  ).toThrow();
});

test("duplicate GraphQL field names are rejected", () => {
  expect(() =>
    defineEntity<{ a: string; b: string }>({
      name: "Dup",
      fields: {
        a: { name: "same", kind: "scalar", type: "String", nonNull: true },
        b: { name: "same", kind: "scalar", type: "String", nonNull: true },
      },
    }),
  ).toThrow();
});

test("reserved names are rejected", () => {
  expect(() =>
    defineEntity<{ a: string }>({
      name: "Reserved",
      fields: { a: { name: "__a", kind: "scalar", type: "String", nonNull: true } },
    }),
  ).toThrow();
});

test("camelCase field names are explicit, not derived", () => {
  const sdl = buildSdl();
  expect(sdl).toMatch(/  projectId: ID!/u);
  expect(sdl).toMatch(/  createdAt: String!/u);
  expect(sdl.includes("project_id")).toBe(false);
  expect(sdl.includes("created_at")).toBe(false);
});
