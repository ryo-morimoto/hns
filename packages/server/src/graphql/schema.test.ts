import { GraphQLObjectType, validateSchema } from "graphql";
import { expect, test } from "vitest";
import { ENTITIES } from "@hns/core/graphql";
import { noteMutation } from "../../test/graphql/fixture-mutation.ts";
import { buildGraphQLSchema, buildSchemaSdl } from "./schema.ts";

/**
 * The registered shape of one field the model's entity generator produced.
 *
 * @param name - The GraphQL type name.
 * @param field - The field.
 * @returns The field's kind, type name, and nullability, as the generator registered them.
 */
function generatedField(name: string, field: string): string | undefined {
  const entity = ENTITIES.find((candidate) => candidate.name === name);
  const entry = entity?.fields.find((candidate) => candidate.name === field);
  if (entry === undefined) return undefined;
  return entry.kind + ":" + entry.typeName + ":" + String(entry.nonNull);
}

/**
 * One field's GraphQL type, as SDL prints it (`[TrailChange!]!`).
 *
 * @param schema - The built schema.
 * @param typeName - The type that has the field.
 * @param fieldName - The field.
 * @returns The printed type, so a list's element nullability is what the test reads.
 */
function typeText(
  schema: ReturnType<typeof buildGraphQLSchema>,
  typeName: string,
  fieldName: string,
): string {
  const type = schema.getType(typeName);
  if (!(type instanceof GraphQLObjectType)) throw new Error(typeName + " is not an object");
  const field = type.getFields()[fieldName];
  if (field === undefined) throw new Error(typeName + " has no " + fieldName);
  return String(field.type);
}

/**
 * The names the published SDL declares.
 *
 * @param sdl - The printed schema.
 * @returns Every type, enum, input, and union name, in the order the SDL declares them.
 */
function declaredNames(sdl: string): readonly string[] {
  return [...sdl.matchAll(/^(?:type|enum|input|union) ([A-Za-z0-9_]+)/gmu)].map(
    (match) => match[1] ?? "",
  );
}

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

// Catches: the replaced unit surviving in the contract (T2 / C2): a Task type, its status, or its
// query would be a second status beside the Trail's.
test("the published SDL carries no Task and names every Trail type", () => {
  const sdl = buildSchemaSdl();
  expect(sdl).not.toMatch(/^type Task\b/mu);
  expect(sdl).not.toMatch(/^enum TaskStatus\b/mu);
  expect(sdl).not.toMatch(/\btasks\(/u);
  const names = declaredNames(sdl);
  for (const name of [
    "Trail",
    "TrailChange",
    "TrailSession",
    "TrailFinding",
    "TrailDecision",
    "TrailGate",
    "TrailState",
    "TrailKind",
    "TrailPriority",
    "TrailChangeState",
    "TrailFindingSeverity",
    "TrailFindingSource",
    "TrailFindingStatus",
    "TrailDecisionAction",
    "TrailGateKind",
    "TrailGateStatus",
    "TrailList",
    "TrailPayload",
    "CreateTrailInput",
    "UpdateTrailInput",
  ]) {
    expect(names, name).toContain(name);
  }
});

// Catches: the Trail query fields missing from the executable schema, or a read left behind.
test("the default schema carries trails and trail(id), and no tasks", () => {
  const schema = buildGraphQLSchema();
  const query = schema.getQueryType()?.getFields() ?? {};
  expect(query["trails"]).toBeDefined();
  expect(query["trail"]).toBeDefined();
  expect(query["tasks"]).toBeUndefined();
  const mutation = schema.getMutationType()?.getFields() ?? {};
  expect(mutation["createTrail"]).toBeDefined();
  expect(mutation["updateTrail"]).toBeDefined();
  expect(validateSchema(schema)).toStrictEqual([]);
});

// Catches: a list field the entity generator cannot express (the issue's first risk), or a
// null element where the model's list is non-null (T4 / C4).
test("the Trail's changes is a non-null list of non-null changes", () => {
  const schema = buildGraphQLSchema();
  expect(typeText(schema, "Trail", "changes")).toBe("[TrailChange!]!");
  // The model's register is where the schema's Trail fields came from, not a hand-written type.
  expect(generatedField("Trail", "id")).toBe("scalar:ID:true");
  expect(generatedField("Trail", "kind")).toBe("enum:TrailKind:true");
});
