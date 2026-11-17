import { execute, parse } from "graphql";
import { expect, test, vi } from "vitest";
import { createContext } from "../context.ts";
import { buildGraphQLSchema } from "../schema.ts";
import { envWith } from "../../../test/support/edge.ts";
import { createProjectModule } from "./create-project.ts";

const CREATE_PROJECT =
  "mutation Create($name: String!, $workspaceRoot: String!) { createProject(name: $name, workspaceRoot: $workspaceRoot) { __typename ... on CreateProjectPayload { project { id } } ... on MutationFailure { code } } }";

const schema = buildGraphQLSchema([createProjectModule()]);

/** Run the mutation directly, with a context the edge would never build. */
async function run(
  subject: string,
  variables: { readonly name: string; readonly workspaceRoot: string },
) {
  const write = vi.fn(() => Promise.reject(new Error("the write must not run")));
  const context = createContext({
    env: envWith(),
    requestId: "test",
    session: { subject, expiresAt: 0 },
    writes: { createProject: write },
    maxRows: 10,
    maxRowsPerList: 10,
  });
  const result = await execute({
    schema,
    document: parse(CREATE_PROJECT),
    contextValue: context,
    variableValues: variables,
  });
  return { result, write };
}

// Catches: a resolver that writes for an empty session subject, which the edge should have refused.
test("an empty session subject is forbidden and writes nothing", async () => {
  const { result, write } = await run("", { name: "a", workspaceRoot: "projects/a" });
  expect(write).not.toHaveBeenCalled();
  expect(result.data).toMatchObject({
    createProject: { __typename: "MutationFailure", code: "FORBIDDEN" },
  });
});

// Catches: a blank project name stored as an unnamed row, or a write attempted before the check.
test("a blank name is invalid and writes nothing", async () => {
  const { result, write } = await run("owner", { name: "   ", workspaceRoot: "projects/a" });
  expect(write).not.toHaveBeenCalled();
  expect(result.data).toMatchObject({
    createProject: { __typename: "MutationFailure", code: "INVALID_REQUEST" },
  });
});
