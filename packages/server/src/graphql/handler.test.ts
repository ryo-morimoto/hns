import { expect, test, vi } from "vitest";
import { createEdge } from "../edge/handler.ts";
import { envWith, sessionCookie } from "../../test/support/edge.ts";
import { conversation, project, task } from "../../test/support/graphql.ts";
import type { WorkerEnv } from "../edge/env.ts";
import type { GraphQLFaceDependencies } from "./handler.ts";
import { createGraphQLFace } from "./handler.ts";

const PROJECTS =
  "{ projects { __typename ... on ProjectList { projects { id name createdAt } } ... on QueryFailure { code } } }";

/** Build an edge over the real GraphQL face, with reads and limits replaced per test. */
function edgeWith(dependencies: GraphQLFaceDependencies = {}) {
  const edge = createEdge({
    graphql: createGraphQLFace(dependencies),
    ws: () => Promise.resolve(new Response("ok")),
  });
  return async function post(query: string, env: WorkerEnv = envWith()): Promise<Response> {
    const cookie = await sessionCookie("owner");
    return edge(
      new Request("https://hns.test/graphql", {
        method: "POST",
        body: JSON.stringify({ query }),
        headers: { "content-type": "application/json", cookie },
      }),
      env,
    );
  };
}

// Catches: a resolver that ignores its read port, or a union the client cannot tell from data.
test("projects are served from the injected read", async () => {
  const post = edgeWith({ reads: { projects: () => Promise.resolve([project("p1", "One")]) } });
  const response = await post(PROJECTS);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      projects: {
        __typename: "ProjectList",
        projects: [{ id: "p1", name: "One", createdAt: "2026-01-01T00:00:00.000Z" }],
      },
    },
  });
});

// Catches: a project filter that is not applied, or a conversation view that leaks snake_case.
test("conversations are filtered to the requested project", async () => {
  const post = edgeWith({
    reads: {
      conversations: () =>
        Promise.resolve([conversation("c1", "p1", "Mine"), conversation("c2", "p2", "Theirs")]),
    },
  });
  const response = await post(
    '{ conversations(projectId: "p1") { __typename ... on ConversationList { conversations { id projectId title isArchived } } } }',
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      conversations: {
        __typename: "ConversationList",
        conversations: [{ id: "c1", projectId: "p1", title: "Mine", isArchived: false }],
      },
    },
  });
});

// Catches: tasks read across projects, or a task status serialized as a free string.
test("tasks are served from the injected read with the enum name", async () => {
  const post = edgeWith({
    reads: { tasks: () => Promise.resolve([task("t1", "p1", "Do it", "doing")]) },
  });
  const response = await post(
    '{ tasks(projectId: "p1") { __typename ... on TaskList { tasks { id status } } } }',
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { tasks: { __typename: "TaskList", tasks: [{ id: "t1", status: "DOING" }] } },
  });
});

// Catches: an invalid page size becoming an empty list instead of a typed failure.
test("an invalid first is a typed failure at HTTP 200", async () => {
  const post = edgeWith({ reads: { projects: () => Promise.resolve([project("p1")]) } });
  const response = await post("{ projects(first: 0) { __typename ... on QueryFailure { code } } }");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { projects: { __typename: "QueryFailure", code: "INVALID_ARGUMENT" } },
  });
});

// Catches: a missing database reported as an empty list or a 500.
test("a missing database binding is an unavailable union", async () => {
  const post = edgeWith();
  const response = await post(PROJECTS, envWith());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { projects: { __typename: "QueryFailure", code: "UNAVAILABLE" } },
  });
});

// Catches: a row budget shared incorrectly, so one request reads past the edge limit.
test("a read over the row budget is a typed failure", async () => {
  const post = edgeWith({
    reads: { projects: () => Promise.resolve([project("p1"), project("p2"), project("p3")]) },
    rows: { maxRowsPerRequest: 2, maxRowsPerList: 10 },
  });
  const response = await post(PROJECTS);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { projects: { __typename: "QueryFailure", code: "LIMIT_EXCEEDED" } },
  });
});

// Catches: a body that is not JSON reaching the engine as a parse error with a 200.
test("a body that is not JSON is refused with 400", async () => {
  const cookie = await sessionCookie("owner");
  const edge = createEdge({
    graphql: createGraphQLFace(),
    ws: () => Promise.resolve(new Response("ok")),
  });
  const response = await edge(
    new Request("https://hns.test/graphql", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json", cookie },
    }),
    envWith(),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    errors: [{ extensions: { code: "GRAPHQL_REQUEST_INVALID" } }],
  });
});

// Catches: a syntactically invalid or unknown-field query answered with 200.
test("an invalid query is refused with 400", async () => {
  const post = edgeWith({ reads: { projects: () => Promise.resolve([]) } });
  const syntax = await post("{ projects { ");
  expect(syntax.status).toBe(400);
  const unknown = await post("{ nope }");
  expect(unknown.status).toBe(400);
});

// Catches: a query over the limits reaching a resolver.
test("a query over the limits is refused before execution", async () => {
  const read = vi.fn(() => Promise.resolve([project("p1")]));
  const post = edgeWith({
    reads: { projects: read },
    queryLimits: { maxBytes: 4_096, maxDepth: 2, maxComplexity: 10 },
  });
  const response = await post(PROJECTS);
  expect(response.status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});

// Catches: a mutation accepted on a query-only face.
test("a mutation document is refused with 400", async () => {
  const post = edgeWith();
  const response = await post("mutation { projects { __typename } }");
  expect(response.status).toBe(400);
});

// Catches: a defect turned into a clean union, hiding a programming error.
test("an unexpected resolver failure is a 500 with the request id logged", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const post = edgeWith({
      reads: {
        projects: () => Promise.reject(new Error("boom")),
      },
    });
    const response = await post(PROJECTS);
    expect(response.status).toBe(500);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).not.toBeNull();
    expect(spy).toHaveBeenCalledWith("graphql: request failed", requestId, "Error");
  } finally {
    spy.mockRestore();
  }
});
