import { expect, test, vi } from "vitest";
import type { JsonValue } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import { createEdge } from "../edge/handler.ts";
import { envWith, sessionCookie, sessionWith } from "../../test/support/edge.ts";
import { conversation, project, task } from "../../test/support/graphql.ts";
import type { WorkerEnv } from "../edge/env.ts";
import type { GraphQLFaceDependencies } from "./handler.ts";
import { createGraphQLFace } from "./handler.ts";

const PROJECTS =
  "{ projects { __typename ... on ProjectList { projects { id name createdAt } } ... on QueryFailure { code } } }";

/** The JSON body a test sends; mirrors the shape the face parses. */
interface RequestBody {
  readonly query: string;
  readonly variables?: { readonly [name: string]: JsonValue };
  readonly operationName?: string;
}

/** Build an edge over the real GraphQL face, with reads and limits replaced per test. */
function edgeWith(dependencies: GraphQLFaceDependencies = {}) {
  const edge = createEdge({
    graphql: createGraphQLFace(dependencies),
    ws: () => Promise.resolve(new Response("ok")),
  });
  return async function send(body: RequestBody, env: WorkerEnv = envWith()): Promise<Response> {
    const cookie = await sessionCookie("owner");
    return edge(
      new Request("https://hns.test/graphql", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", cookie },
      }),
      env,
    );
  };
}

// Catches: a resolver that ignores its read port, or a union the client cannot tell from data.
test("projects are served from the injected read", async () => {
  const send = edgeWith({ reads: { projects: () => Promise.resolve([project("p1", "One")]) } });
  const response = await send({ query: PROJECTS });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      projects: {
        __typename: "ProjectList",
        projects: [
          { id: toGlobalId("Project", "p1"), name: "One", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      },
    },
  });
});

// Catches: a project filter that is not applied, or a conversation view that leaks snake_case.
test("conversations are filtered to the requested project", async () => {
  const send = edgeWith({
    reads: {
      conversations: () =>
        Promise.resolve([conversation("c1", "p1", "Mine"), conversation("c2", "p2", "Theirs")]),
    },
  });
  const response = await send({
    query:
      '{ conversations(projectId: "' +
      toGlobalId("Project", "p1") +
      '") { __typename ... on ConversationList { conversations { id projectId title isArchived } } } }',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      conversations: {
        __typename: "ConversationList",
        conversations: [
          {
            id: toGlobalId("Conversation", "c1"),
            projectId: toGlobalId("Project", "p1"),
            title: "Mine",
            isArchived: false,
          },
        ],
      },
    },
  });
});

// Catches: a Session read that fans out, drops the request id, or loses the RPC envelope.
test("conversations are one Session RPC carrying the request id", async () => {
  const session = sessionWith(
    new Response(
      JSON.stringify({
        ok: true,
        conversations: [
          {
            id: "c1",
            project_id: "p1",
            title: "One",
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: null,
            archived: false,
            deleted_at: null,
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const send = edgeWith();
  const response = await send(
    {
      query:
        '{ conversations(projectId: "' +
        toGlobalId("Project", "p1") +
        '") { __typename ... on ConversationList { conversations { id } } } }',
    },
    envWith({ session: session.namespace }),
  );
  expect(response.status).toBe(200);
  expect(session.ids).toStrictEqual(["default"]);
  expect(session.requests).toHaveLength(1);
  const forwarded = session.requests[0];
  if (forwarded === undefined) throw new Error("the Session RPC was not called");
  expect(forwarded.url).toContain("/rpc/conversations?limit=");
  expect(forwarded.headers.get("x-request-id")).toBe(response.headers.get("x-request-id"));
  expect(await response.json()).toMatchObject({
    data: {
      conversations: {
        __typename: "ConversationList",
        conversations: [{ id: toGlobalId("Conversation", "c1") }],
      },
    },
  });
});

// Catches: a failed Session read shown as an empty list.
test("a failed Session read is an unavailable union", async () => {
  const session = sessionWith(new Response("boom", { status: 500 }));
  const send = edgeWith();
  const response = await send(
    {
      query:
        '{ conversations(projectId: "' +
        toGlobalId("Project", "p1") +
        '") { __typename ... on QueryFailure { code } } }',
    },
    envWith({ session: session.namespace }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { conversations: { __typename: "QueryFailure", code: "UNAVAILABLE" } },
  });
});

// Catches: tasks read across projects, or a task status serialized as a free string.
test("tasks are served from the injected read with the enum name", async () => {
  const send = edgeWith({
    reads: { tasks: () => Promise.resolve([task("t1", "p1", "Do it", "doing")]) },
  });
  const response = await send({
    query:
      '{ tasks(projectId: "' +
      toGlobalId("Project", "p1") +
      '") { __typename ... on TaskList { tasks { id status } } } }',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      tasks: {
        __typename: "TaskList",
        tasks: [{ id: toGlobalId("Task", "t1"), status: "DOING" }],
      },
    },
  });
});

// Catches: an invalid page size becoming an empty list instead of a typed failure.
test("an invalid first is a typed failure at HTTP 200", async () => {
  const send = edgeWith({ reads: { projects: () => Promise.resolve([project("p1")]) } });
  const response = await send({
    query: "{ projects(first: 0) { __typename ... on QueryFailure { code } } }",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { projects: { __typename: "QueryFailure", code: "INVALID_ARGUMENT" } },
  });
});

// Catches: a raw or wrong-typed id accepted as a project id.
test("a project id that is not a Project global id is a typed failure", async () => {
  const send = edgeWith({ reads: { projects: () => Promise.resolve([]) } });
  const raw = await send({
    query: '{ tasks(projectId: "p1") { __typename ... on QueryFailure { code } } }',
  });
  expect(raw.status).toBe(200);
  expect(await raw.json()).toMatchObject({
    data: { tasks: { __typename: "QueryFailure", code: "INVALID_ARGUMENT" } },
  });
  const wrongType = await send({
    query:
      '{ tasks(projectId: "' +
      toGlobalId("Conversation", "p1") +
      '") { __typename ... on QueryFailure { code } } }',
  });
  expect(await wrongType.json()).toMatchObject({
    data: { tasks: { __typename: "QueryFailure", code: "INVALID_ARGUMENT" } },
  });
  const malformed = await send({
    query: '{ tasks(projectId: "not-a-global-id") { __typename ... on QueryFailure { code } } }',
  });
  expect(await malformed.json()).toMatchObject({
    data: { tasks: { __typename: "QueryFailure", code: "INVALID_ARGUMENT" } },
  });
});

// Catches: a missing database reported as an empty list or a 500.
test("a missing database binding is an unavailable union", async () => {
  const send = edgeWith();
  const response = await send({ query: PROJECTS }, envWith());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { projects: { __typename: "QueryFailure", code: "UNAVAILABLE" } },
  });
});

// Catches: a row budget charged after the read, so an over-budget request still touches D1.
test("an over-budget page is a typed failure", async () => {
  const read = vi.fn(() => Promise.resolve([project("p1"), project("p2"), project("p3")]));
  const send = edgeWith({
    reads: { projects: read },
    rows: { maxRowsPerRequest: 2, maxRowsPerList: 10 },
  });
  const response = await send({ query: PROJECTS });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { projects: { __typename: "QueryFailure", code: "LIMIT_EXCEEDED" } },
  });
  expect(read).not.toHaveBeenCalled();
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
  const send = edgeWith({ reads: { projects: () => Promise.resolve([]) } });
  const syntax = await send({ query: "{ projects { " });
  expect(syntax.status).toBe(400);
  const unknown = await send({ query: "{ nope }" });
  expect(unknown.status).toBe(400);
});

// Catches: variable coercion and an unknown operation name reported as a server failure.
test("input errors in variables and operationName are refused with 400", async () => {
  const send = edgeWith({ reads: { conversations: () => Promise.resolve([]) } });
  const badVariable = await send({
    query: "query C($p: ID!) { conversations(projectId: $p) { __typename } }",
    variables: { p: null },
  });
  expect(badVariable.status).toBe(400);
  const badOperation = await send({
    query: "query A { projects { __typename } } query B { projects { __typename } }",
    operationName: "Nope",
  });
  expect(badOperation.status).toBe(400);
  const notAnInt = await send({
    query: "query P($n: Int) { projects(first: $n) { __typename } }",
    variables: { n: "abc" },
  });
  expect(notAnInt.status).toBe(400);
  const fraction = await send({
    query: "query P($n: Int) { projects(first: $n) { __typename } }",
    variables: { n: 1.5 },
  });
  expect(fraction.status).toBe(400);
});

// Catches: an oversized body paying for a parse before the byte limit runs.
test("an oversized query is refused before parsing", async () => {
  const send = edgeWith({
    queryLimits: { maxBytes: 32, maxDepth: 8, maxComplexity: 500 },
  });
  const response = await send({ query: "{ projects { __typename } } } " + "x".repeat(64) });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    errors: [{ message: expect.stringContaining("bytes") }],
  });
});

// Catches: a query over the depth or complexity limit reaching a resolver.
test("a query over the limits is refused before execution", async () => {
  const read = vi.fn(() => Promise.resolve([project("p1")]));
  const send = edgeWith({
    reads: { projects: read },
    queryLimits: { maxBytes: 4_096, maxDepth: 2, maxComplexity: 10 },
  });
  const response = await send({ query: PROJECTS });
  expect(response.status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});

// Catches: a mutation accepted on a query-only face.
test("a mutation document is refused with 400", async () => {
  const send = edgeWith();
  const response = await send({ query: "mutation { projects { __typename } }" });
  expect(response.status).toBe(400);
});

// Catches: a defect turned into a clean union, hiding a programming error.
test("an unexpected resolver failure is a 500 with the request id logged", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const send = edgeWith({
      reads: {
        projects: () => Promise.reject(new Error("boom")),
      },
    });
    const response = await send({ query: PROJECTS });
    expect(response.status).toBe(500);
    const requestId = response.headers.get("x-request-id");
    expect(requestId).not.toBeNull();
    expect(spy).toHaveBeenCalledWith("graphql: request failed", requestId, "Error");
  } finally {
    spy.mockRestore();
  }
});
