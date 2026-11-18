import { execute, parse } from "graphql";
import { expect, test, vi } from "vitest";
import type { JsonValue, Project } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import type { TrailRowValue, TrailWriteRefusal } from "@hns/store";
import { project } from "../../../test/support/graphql.ts";
import { createContext } from "../context.ts";
import { buildGraphQLSchema } from "../schema.ts";
import { envWith } from "../../../test/support/edge.ts";
import { trailModule } from "./trail.ts";

const CREATE_TRAIL =
  "mutation Create($projectId: ID!, $title: String!) { createTrail(input: { projectId: $projectId, title: $title }) { __typename ... on CreateTrailPayload { trail { id title state createdBy } } ... on MutationFailure { code } } }";

const UPDATE_TRAIL =
  "mutation Update($id: ID!, $title: String!) { updateTrail(id: $id, input: { title: $title }) { __typename ... on UpdateTrailPayload { trail { id title } } ... on MutationFailure { code } } }";

const schema = buildGraphQLSchema([trailModule()]);

/** A store refusal, as the write port answers it. */
const NOT_FOUND: TrailWriteRefusal = { kind: "not_found", refused: true };

/**
 * Run one mutation against a context whose ports are fakes.
 *
 * @param document - The operation text.
 * @param variables - Its variables.
 * @param overrides - The reads the resolver should see, and the subject it acts as.
 */
async function run<Variables extends { readonly [name: string]: JsonValue }>(
  document: string,
  variables: Variables,
  overrides: {
    readonly subject?: string;
    readonly project?: () => Promise<Project | undefined>;
  } = {},
) {
  const create = vi.fn(() => Promise.reject(new Error("the write must not run")));
  const update = vi.fn(() => Promise.reject(new Error("the write must not run")));
  const context = createContext({
    env: envWith(),
    requestId: "test",
    session: { subject: overrides.subject ?? "owner", expiresAt: 0 },
    reads: { project: overrides.project ?? (() => Promise.resolve(project("p1"))) },
    writes: { createTrail: create, updateTrail: update },
    policy: undefined,
    maxRows: 10,
    maxRowsPerList: 10,
  });
  const result = await execute({
    schema,
    document: parse(document),
    contextValue: context,
    variableValues: variables,
  });
  return { result, create, update };
}

/**
 * Run one update against a context whose update port answers `update`.
 *
 * @param document - The operation text.
 * @param variables - Its variables.
 * @param update - What the update port answers.
 */
async function runUpdate<Variables extends { readonly [name: string]: JsonValue }>(
  document: string,
  variables: Variables,
  update: () => Promise<TrailRowValue | TrailWriteRefusal | undefined>,
) {
  const context = createContext({
    env: envWith(),
    requestId: "test",
    session: { subject: "owner", expiresAt: 0 },
    reads: { project: () => Promise.resolve(project("p1")) },
    writes: { updateTrail: update },
    policy: undefined,
    maxRows: 10,
    maxRowsPerList: 10,
  });
  return execute({
    schema,
    document: parse(document),
    contextValue: context,
    variableValues: variables,
  });
}

// Catches: a resolver that writes for an empty session subject, or one that lets the caller
// choose the creator instead of taking the session's.
test("an empty session subject cannot create a Trail", async () => {
  const { result, create } = await run(
    CREATE_TRAIL,
    { projectId: toGlobalId("Project", "p1"), title: "t" },
    { subject: "" },
  );
  expect(create).not.toHaveBeenCalled();
  expect(result.data).toMatchObject({
    createTrail: { __typename: "MutationFailure", code: "FORBIDDEN" },
  });
});

// Catches: a Trail written into a project that does not exist, which no screen would ever list.
test("a Trail is not created in an unknown project", async () => {
  const { result, create } = await run(
    CREATE_TRAIL,
    { projectId: toGlobalId("Project", "p1"), title: "t" },
    { project: () => Promise.resolve(undefined) },
  );
  expect(create).not.toHaveBeenCalled();
  expect(result.data).toMatchObject({
    createTrail: { __typename: "MutationFailure", code: "INVALID_REQUEST" },
  });
});

// Catches: a blank title stored, or a write attempted before the check.
test("a blank title is invalid and writes nothing", async () => {
  const { result, create } = await run(CREATE_TRAIL, {
    projectId: toGlobalId("Project", "p1"),
    title: "   ",
  });
  expect(create).not.toHaveBeenCalled();
  expect(result.data).toMatchObject({
    createTrail: { __typename: "MutationFailure", code: "INVALID_REQUEST" },
  });
});

// Catches: a project id of another type accepted as a Project (a Conversation id, a raw id).
test("a project id that is not a Project global id is invalid", async () => {
  const { result, create } = await run(CREATE_TRAIL, {
    projectId: toGlobalId("Conversation", "c1"),
    title: "t",
  });
  expect(create).not.toHaveBeenCalled();
  expect(result.data).toMatchObject({
    createTrail: { __typename: "MutationFailure", code: "INVALID_REQUEST" },
  });
});

// Catches: a missing Trail answered as a payload, or the store's refusal read as a row.
test("updateTrail on a missing Trail is not_found", async () => {
  const result = await runUpdate(
    UPDATE_TRAIL,
    { id: toGlobalId("Trail", "trail-1"), title: "new" },
    () => Promise.resolve(NOT_FOUND),
  );
  expect(result.data).toMatchObject({
    updateTrail: { __typename: "MutationFailure", code: "NOT_FOUND" },
  });
});

// Catches: a corrupt row (unavailable) reported as the caller's mistake, or as a payload.
test("updateTrail on a corrupt row is unavailable", async () => {
  const result = await runUpdate(
    UPDATE_TRAIL,
    { id: toGlobalId("Trail", "trail-1"), title: "new" },
    () => Promise.resolve({ kind: "corrupt_row", refused: true }),
  );
  expect(result.data).toMatchObject({
    updateTrail: { __typename: "MutationFailure", code: "UNAVAILABLE" },
  });
});

// Catches: a Trail id of another type accepted by updateTrail (a Project id would edit a Trail).
test("updateTrail refuses an id that is not a Trail global id", async () => {
  const { result, update } = await run(UPDATE_TRAIL, {
    id: toGlobalId("Project", "p1"),
    title: "new",
  });
  expect(update).not.toHaveBeenCalled();
  expect(result.data).toMatchObject({
    updateTrail: { __typename: "MutationFailure", code: "INVALID_REQUEST" },
  });
});
