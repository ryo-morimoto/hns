import { expect, test, vi } from "vitest";
import type { JsonValue } from "@hns/core";
import { toGlobalId } from "@hns/core/graphql";
import { createEdge } from "../edge/handler.ts";
import { QueryReadError } from "./failures.ts";
import { envWith, sessionCookie, sessionWith } from "../../test/support/edge.ts";
import { noteMutation } from "../../test/graphql/fixture-mutation.ts";
import { project, task } from "../../test/support/graphql.ts";
import type { WorkerEnv } from "../edge/env.ts";
import type { GraphQLFaceDependencies } from "./handler.ts";
import { createGraphQLFace } from "./handler.ts";

const PROJECTS =
  "{ projects { __typename ... on ProjectList { projects { id name workspaceRoot agentCwd createdAt } } ... on QueryFailure { code } } }";

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
  return async function send(
    body: RequestBody,
    env: WorkerEnv = envWith(),
    subject = "owner",
  ): Promise<Response> {
    const cookie = await sessionCookie(subject);
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
          {
            id: toGlobalId("Project", "p1"),
            name: "One",
            workspaceRoot: "",
            agentCwd: "",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    },
  });
});

// Catches: a conversation view that leaks snake_case, or the response losing the project scope.
test("a project's conversations are served from that project's Session object", async () => {
  const session = sessionWith(
    new Response(
      JSON.stringify({
        ok: true,
        conversations: [
          {
            id: "c1",
            project_id: "p1",
            title: "Mine",
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
        '") { __typename ... on ConversationList { conversations { id projectId title isArchived } } } }',
    },
    envWith({ session: session.namespace }),
  );
  expect(response.status).toBe(200);
  expect(session.ids).toStrictEqual(["p1"]);
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
  expect(session.ids).toStrictEqual(["p1"]);
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

// Catches: a mutation document accepted while the schema has no Mutation root.
test("a mutation document on a face with no module is refused with 400", async () => {
  const send = edgeWith();
  const response = await send({ query: "mutation { projects { __typename } }" });
  expect(response.status).toBe(400);
});

const CREATE_NOTE =
  "mutation Create($text: String!) { createNote(text: $text) { __typename ... on NotePayload { text actor } ... on MutationFailure { code } } }";

const CREATE_PROJECT =
  "mutation Create($name: String!, $workspaceRoot: String!) { createProject(name: $name, workspaceRoot: $workspaceRoot) { __typename ... on CreateProjectPayload { project { id name workspaceRoot agentCwd } } ... on MutationFailure { code } } }";

/** A write port that records its input and answers with the created project. */
function createProjectWrite() {
  return vi.fn((input: { readonly name: string; readonly workspaceRoot: string }) =>
    Promise.resolve(project("p9", input.name, input.workspaceRoot)),
  );
}

// Catches: a mutation that returns a payload without writing, or a root that never reaches the store.
test("createProject writes through the store and returns the project", async () => {
  const write = createProjectWrite();
  const send = edgeWith({ writes: { createProject: write } });
  const response = await send({
    query: CREATE_PROJECT,
    variables: { name: "a", workspaceRoot: "projects/a" },
  });
  expect(response.status).toBe(200);
  expect(write).toHaveBeenCalledWith({ name: "a", workspaceRoot: "projects/a" });
  expect(await response.json()).toMatchObject({
    data: {
      createProject: {
        __typename: "CreateProjectPayload",
        project: {
          id: toGlobalId("Project", "p9"),
          name: "a",
          workspaceRoot: "projects/a",
          agentCwd: "projects/a",
        },
      },
    },
  });
});

// Catches: a non-canonical root written as if the machine could still resolve it, or an empty
// root silently pointing a new project at the machine ROOT.
test.each(["/abs", "../x", "a//b", "a\\b", ".hns/x", ""])(
  "createProject refuses the root %j without writing",
  async (root) => {
    const write = createProjectWrite();
    const send = edgeWith({ writes: { createProject: write } });
    const response = await send({
      query: CREATE_PROJECT,
      variables: { name: "a", workspaceRoot: root },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { createProject: { __typename: "MutationFailure", code: "INVALID_ARGUMENT" } },
    });
    expect(write).not.toHaveBeenCalled();
  },
);

// Catches: a database outage reported as a created project.
test("createProject reports an unavailable store as a typed failure", async () => {
  const send = edgeWith({
    writes: {
      createProject: () =>
        Promise.reject(new QueryReadError("unavailable", "The database write failed.")),
    },
  });
  const response = await send({
    query: CREATE_PROJECT,
    variables: { name: "a", workspaceRoot: "projects/a" },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { createProject: { __typename: "MutationFailure", code: "UNAVAILABLE" } },
  });
});

// Catches: a mutation spending rows outside the request budget.
test("createProject spends the request's row budget before writing", async () => {
  const write = createProjectWrite();
  const send = edgeWith({
    writes: { createProject: write },
    rows: { maxRowsPerRequest: 0, maxRowsPerList: 0 },
  });
  const response = await send({
    query: CREATE_PROJECT,
    variables: { name: "a", workspaceRoot: "projects/a" },
  });
  expect(await response.json()).toMatchObject({
    data: { createProject: { __typename: "MutationFailure", code: "LIMIT_EXCEEDED" } },
  });
  expect(write).not.toHaveBeenCalled();
});

// Catches: a non-string root coerced or reported as a server failure instead of 400.
test("createProject refuses a non-string workspaceRoot with 400", async () => {
  const send = edgeWith({ writes: { createProject: createProjectWrite() } });
  const response = await send({
    query: CREATE_PROJECT,
    variables: { name: "a", workspaceRoot: 42 },
  });
  expect(response.status).toBe(400);
});

// Catches: a registered mutation field the face validates but never executes, or a payload read
// as a failure.
test("a mutation executes through its result union at HTTP 200", async () => {
  const send = edgeWith({ mutations: [noteMutation("owner")] });
  const response = await send({ query: CREATE_NOTE, variables: { text: "hello" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: {
      createNote: { __typename: "NotePayload", text: "hello", actor: "owner" },
    },
  });
});

// Catches: a resolver that skips the caller check the edge cannot make, or a denial reported as
// a server failure instead of a union member.
test("a caller that does not own the target gets a typed forbidden failure", async () => {
  const send = edgeWith({ mutations: [noteMutation("owner")] });
  const response = await send(
    { query: CREATE_NOTE, variables: { text: "hello" } },
    envWith(),
    "intruder",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { createNote: { __typename: "MutationFailure", code: "FORBIDDEN" } },
  });
});

// Catches: invalid mutation input reported as a GraphQL error (500) or an empty payload.
test("invalid mutation input is a typed failure at HTTP 200", async () => {
  const send = edgeWith({ mutations: [noteMutation("owner")] });
  const response = await send({ query: CREATE_NOTE, variables: { text: "   " } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { createNote: { __typename: "MutationFailure", code: "INVALID_ARGUMENT" } },
  });
});

// Catches: a mutation variable that does not coerce reported as a server failure.
test("a mutation variable that does not coerce is refused with 400", async () => {
  const send = edgeWith({ mutations: [noteMutation("owner")] });
  const response = await send({ query: CREATE_NOTE, variables: { text: 42 } });
  expect(response.status).toBe(400);
});

// Catches: an unknown operationName in a mutation document answered with 200 or 500.
test("an unknown operationName on a mutation document is refused with 400", async () => {
  const document =
    'mutation A { createNote(text: "a") { __typename } } mutation B { createNote(text: "b") { __typename } }';
  const send = edgeWith({ mutations: [noteMutation("owner")] });
  const response = await send({ query: document, operationName: "C" });
  expect(response.status).toBe(400);
  const missing = await send({ query: document });
  expect(missing.status).toBe(400);
});

// Catches: a mutation that spends rows outside the request budget.
test("a mutation spends the same row budget as a query", async () => {
  const send = edgeWith({
    mutations: [noteMutation("owner")],
    rows: { maxRowsPerRequest: 0, maxRowsPerList: 0 },
  });
  const response = await send({ query: CREATE_NOTE, variables: { text: "hello" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { createNote: { __typename: "MutationFailure", code: "LIMIT_EXCEEDED" } },
  });
});

// Catches: a mutation body paying for a parse before the byte limit runs.
test("an oversized mutation is refused before parsing", async () => {
  const send = edgeWith({
    mutations: [noteMutation("owner")],
    queryLimits: { maxBytes: 32, maxDepth: 8, maxComplexity: 500 },
  });
  const response = await send({
    query: CREATE_NOTE + " ".repeat(64),
    variables: { text: "hello" },
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    errors: [{ message: expect.stringContaining("bytes") }],
  });
});

// Catches: mutations escaping the depth or complexity limit that queries obey.
test("a mutation over the limits is refused before execution", async () => {
  const send = edgeWith({
    mutations: [noteMutation("owner")],
    queryLimits: { maxBytes: 4_096, maxDepth: 1, maxComplexity: 10 },
  });
  const response = await send({ query: CREATE_NOTE, variables: { text: "hello" } });
  expect(response.status).toBe(400);
});

// Catches: an unknown mutation field reaching execution instead of validation.
test("an unknown mutation field is refused with 400", async () => {
  const send = edgeWith({ mutations: [noteMutation("owner")] });
  const response = await send({ query: "mutation { nope { __typename } }" });
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
