import * as v from "valibot";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { JsonValue, ProjectId } from "@hns/core";
import { fromGlobalId, toGlobalId } from "@hns/core/graphql";
import type { Store } from "@hns/store";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { createGraphQLFace, type GraphQLFaceDependencies } from "../../src/graphql/handler.ts";
import { policyFaceOver } from "../../src/graphql/policy/face.ts";
import { envWith } from "../support/edge.ts";
import workspaceOperation from "../../../web/src/__generated__/ShellWorkspaceQuery.graphql.ts";

/**
 * The web app's own Trail document, through the real face and a real D1.
 *
 * @remarks
 * The web tests answer the wire with fixtures, so they cannot tell whether the request the
 * Sidebar sends is one the face can serve. This suite takes the **compiled operation the web app
 * ships** (the SidebarTrails fragment, spread into ShellWorkspaceQuery), posts its params.text to
 * the production handler (createGraphQLFace) over a real D1, and lets the request run through the
 * schema, the trails / trail resolvers, the store, and migration 0010: nothing between the
 * browser's document and the row is replaced here. A field the screen renamed, a field the face
 * does not serve, or a resolver that cannot read what the store wrote fails here.
 */

/** The operation text of one compiled document, which is what the browser sends. */
function textOf(operation: { readonly params: { readonly text?: string | null } }): string {
  const text = operation.params.text;
  if (text === null || text === undefined) throw new Error("the operation has no text");
  return text;
}

/** The trails selection as the SidebarTrails fragment spreads it. */
const TRAILS =
  "trails(projectId: $projectId) { __typename ... on TrailList { trails { id projectId title state } } ... on QueryFailure { code message } }";

/**
 * The wrapper a project's list is sent in: the web document's own argument.
 *
 * @remarks
 * A read by id uses {@link BY_ID_WRAPPER} and a write uses {@link MUTATION_WRAPPER}, because
 * GraphQL refuses an operation that declares a variable it does not use, and each of those
 * selections names a different set.
 */
const QUERY_WRAPPER = "query ShellWorkspaceQuery($projectId: ID!) {";

/** The wrapper a read by id is sent in: it names no variable, because `trail` takes none. */
const BY_ID_WRAPPER = "query TrailFaceDetail {";

/**
 * The wrapper a write is sent in.
 *
 * @remarks
 * A mutation is its own operation (GraphQL refuses a write inside a query), and it declares the
 * title `createTrail` takes.
 */
const MUTATION_WRAPPER = "mutation TrailFaceWrite($projectId: ID!, $title: String!) {";

/** A 200 body: one key per selected field. */
const ResponseSchema = v.object({ data: v.record(v.string(), v.unknown()) });

/** The answer's trails member: the list, or a typed failure. */
const TrailListSchema = v.union([
  v.object({
    __typename: v.literal("TrailList"),
    trails: v.array(
      v.object({ id: v.string(), projectId: v.string(), title: v.string(), state: v.string() }),
    ),
  }),
  v.object({ __typename: v.literal("QueryFailure"), code: v.string(), message: v.string() }),
]);

/** The answer's trail member: the payload, or a typed failure. */
const TrailPayloadSchema = v.union([
  v.object({
    __typename: v.literal("TrailPayload"),
    trail: v.object({
      id: v.string(),
      projectId: v.string(),
      title: v.string(),
      description: v.string(),
      acceptance: v.string(),
      kind: v.string(),
      state: v.string(),
      priority: v.string(),
      createdBy: v.string(),
      /** C4: the Change list, with the hashes the store holds. */
      changes: v.array(
        v.object({
          id: v.string(),
          trailId: v.string(),
          baseCommit: v.string(),
          headCommit: v.string(),
        }),
      ),
    }),
  }),
  v.object({ __typename: v.literal("QueryFailure"), code: v.string(), message: v.string() }),
]);

/** The answer's createTrail member. */
const CreateTrailSchema = v.union([
  v.object({
    __typename: v.literal("CreateTrailPayload"),
    trail: v.object({
      id: v.string(),
      title: v.string(),
      state: v.string(),
      createdBy: v.string(),
    }),
  }),
  v.object({ __typename: v.literal("MutationFailure"), code: v.string(), message: v.string() }),
]);

const HUMAN = "owner";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

/** Run one operation through the handler and return its data. */
async function post(
  store: Store,
  subject: string,
  query: string,
  variables: Record<string, JsonValue>,
): Promise<v.InferOutput<typeof ResponseSchema>["data"]> {
  const face = createGraphQLFace({
    reads: { project: (projectId) => store.projects.get(projectId) },
    policy: policyFaceOver(store, { bashSandbox: false }),
  } satisfies GraphQLFaceDependencies);
  const response = await face({
    request: new Request("https://hns.test/graphql", { method: "POST" }),
    env: envWith({ db: harness.db }),
    session: { subject, expiresAt: 0 },
    requestId: "trail-face",
    signal: new AbortController().signal,
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  expect(response.status, text).toBe(200);
  const body: unknown = JSON.parse(text);
  return v.parse(ResponseSchema, body).data;
}
/**
 * One read inside the web document's wrapper.
 *
 * @param field - A field with its selection set, as the web document spreads it.
 * @returns The operation the face parses: the wrapper names the operation and its variables, and
 * the selection is its only field.
 */
function selection(field: string): string {
  return QUERY_WRAPPER + " " + field + " }";
}

/**
 * One read by id inside its own wrapper.
 *
 * @param field - The `trail(...)` selection, with its argument inline.
 * @returns The operation the face parses. A bare wrapper is valid because no variable is declared
 * and left unused (`query TrailFaceDetail {` needs no `(...)` set).
 */
function byId(field: string): string {
  return BY_ID_WRAPPER + " " + field + " }";
}

/** One write inside the mutation wrapper. */
function write(field: string): string {
  return MUTATION_WRAPPER + " " + field + " }";
}

/** The createTrail selection a test sends. */
const CREATE =
  "createTrail(input: { projectId: $projectId, title: $title }) { __typename ... on CreateTrailPayload { trail { id title state createdBy } } ... on MutationFailure { code message } }";

/**
 * The trail(id) selection: every stored field and the Change list.
 *
 * @param id - The Trail's global id, written inline: `trail` takes no project argument, so the
 * read names no variable at all.
 */
const DETAIL = (id: string): string =>
  'trail(id: "' +
  id +
  '") { __typename ... on TrailPayload { trail { id projectId title description acceptance kind state priority createdBy changes { id trailId baseCommit headCommit } } } ... on QueryFailure { code message } }';

/**
 * Create one Trail through the face, over the store.
 *
 * @param store - The store the face writes.
 * @returns The project's global id (and its raw id, which the store's own methods take), the
 * Trail's global id as the face answered it, its raw id, and its title.
 */
async function createOne(store: Store): Promise<{
  projectId: string;
  id: string;
  rawId: string;
  projectIdRaw: ProjectId;
  title: string;
}> {
  const project = await store.projects.create("trail-face", "projects/trail-face");
  const projectId = toGlobalId("Project", project.id);
  const payload = (
    await post(store, HUMAN, write(CREATE), {
      projectId,
      title: "The Trail face",
    })
  )["createTrail"];
  const created = v.parse(CreateTrailSchema, payload);
  if (created.__typename === "MutationFailure") throw new Error(created.message);
  const decoded = fromGlobalId(created.trail.id);
  if (!decoded.ok || decoded.value.type !== "Trail") {
    throw new Error("createTrail answered a Trail id that is not a Trail global id");
  }
  return {
    projectId,
    projectIdRaw: project.id,
    id: created.trail.id,
    rawId: decoded.value.id,
    title: created.trail.title,
  };
}

/**
 * Read one Trail through the face, failing the test on a typed failure.
 *
 * @param store - The store the face reads.
 * @param id - The Trail's global id.
 */
async function detailOf(store: Store, id: string) {
  const answer = v.parse(
    TrailPayloadSchema,
    (await post(store, HUMAN, byId(DETAIL(id)), {}))["trail"],
  );
  if (answer.__typename === "QueryFailure") throw new Error(answer.message);
  return answer.trail;
}
/**
 * C1: an empty database, `createTrail`, then `trail(id)` answers the same Trail.
 *
 * @remarks
 * Catches a write and a read that disagree about the model (a state the store stores but the SDL
 * cannot serialize, a project id wrapped twice, a creator that is not the session's subject), and
 * a `trail(id)` that cannot find what `createTrail` just wrote.
 */
test("createTrail then trail(id) round-trips through the store", async () => {
  await harness.withStore(async (store) => {
    const created = await createOne(store);
    // A second Trail in the same project: `trail(id)` must read the row its id names, not the
    // list's first or newest one.
    const other = await store.trails.create({
      projectId: created.projectIdRaw,
      title: "A second Trail",
      createdBy: HUMAN,
    });
    expect(other.refused).toBe(false);
    const detail = await detailOf(store, created.id);
    expect(detail).toStrictEqual({
      id: created.id,
      projectId: created.projectId,
      title: created.title,
      description: "",
      acceptance: "",
      kind: "FEATURE",
      state: "DRAFT",
      priority: "NORMAL",
      createdBy: HUMAN,
      changes: [],
    });
  });
});

/**
 * The Sidebar's document is served by the face: the project's Trails, or none.
 *
 * @remarks
 * Catches a screen asking for a field the face stopped serving (400 at post), a trails field
 * that cannot filter by project, and a Trail the sidebar would show under the wrong project.
 */
test("the web document reads the project's Trails and only its Trails", async () => {
  await harness.withStore(async (store) => {
    const hns = await createOne(store);
    const other = await store.projects.create("other", "projects/other");
    const otherId = toGlobalId("Project", other.id);
    const elsewhere = v.parse(
      CreateTrailSchema,
      (await post(store, HUMAN, write(CREATE), { projectId: otherId, title: "Elsewhere" }))[
        "createTrail"
      ],
    );
    expect(elsewhere.__typename).toBe("CreateTrailPayload");

    const answer = v.parse(
      TrailListSchema,
      (await post(store, HUMAN, selection(TRAILS), { projectId: hns.projectId }))["trails"],
    );
    expect(answer).toStrictEqual({
      __typename: "TrailList",
      trails: [{ id: hns.id, projectId: hns.projectId, title: hns.title, state: "DRAFT" }],
    });
  });
});

/**
 * C4: a Trail's changes carry the base and head the store holds.
 *
 * @remarks
 * The Change is written by the repository (no mutation adds one yet), so this is the only place
 * the list field reads a real row. Catches a list field that resolves nothing, a `base..head` pair
 * reversed or dropped, and a resolver that turns the store's throwing `listChanges` into an
 * empty list.
 */
test("a Trail's changes carry the base and head commits", async () => {
  await harness.withStore(async (store) => {
    const created = await createOne(store);
    const change = await store.trails.addChange(created.rawId, {
      workspaceId: "project-hns",
      baseCommit: "1".repeat(40),
      headCommit: "2".repeat(40),
    });
    if (change.refused) throw new Error("the change was refused: " + change.kind);

    const detail = await detailOf(store, created.id);
    expect(detail.changes).toStrictEqual([
      {
        id: toGlobalId("TrailChange", change.id),
        trailId: created.id,
        baseCommit: "1".repeat(40),
        headCommit: "2".repeat(40),
      },
    ]);
  });
});

/**
 * A Trail the store can hold but this build cannot read is `unavailable`, not a 500.
 *
 * @remarks
 * The `trails` state column is CHECKed on the way in, so the row a legacy build wrote is made
 * here: the table is recreated without its CHECK and a state no vocabulary contains is written.
 * The resolver answers the store's `corrupt_row` refusal as `unavailable` — a client can retry a
 * broken read — and never as an empty list or a payload that reads the row as a default.
 */
test("a Trail this build cannot read is unavailable on trail(id) and on trails", async () => {
  await harness.withStore(async (store) => {
    const created = await createOne(store);
    await harness.exec(
      "DROP TABLE trails; " +
        "CREATE TABLE trails (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, " +
        "description TEXT NOT NULL, acceptance TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, " +
        "priority TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, " +
        "updated_at TEXT NOT NULL);",
    );
    await harness.exec(
      "INSERT INTO trails (id, project_id, title, description, acceptance, kind, state, priority, " +
        "created_by, created_at, updated_at) " +
        "VALUES ('corrupt', '" +
        created.projectIdRaw +
        "', 'A corrupt Trail', " +
        "'', '', 'feature', 'blocked', 'normal', 'owner', " +
        "'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');",
    );

    // The row is the one the new table holds: `corrupt`, the id the face is asked for.
    const detail = (await post(store, HUMAN, byId(DETAIL(toGlobalId("Trail", "corrupt"))), {}))[
      "trail"
    ];
    expect(detail).toStrictEqual({
      __typename: "QueryFailure",
      code: "UNAVAILABLE",
      message: "The stored trail could not be read.",
    });
    const list = (
      await post(store, HUMAN, selection(TRAILS), {
        projectId: created.projectId,
      })
    )["trails"];
    expect(list).toStrictEqual({
      __typename: "QueryFailure",
      code: "UNAVAILABLE",
      message: "The stored trail could not be read.",
    });
  });
});

/**
 * The Trail the Sidebar lists is the one trail(id) reads: one unit, two faces.
 *
 * @remarks
 * Catches the two reads disagreeing: a list that drops the state a detail shows, or a detail
 * that reads a different row for the id the list carried.
 */
test("the Sidebar's Trail and trail(id) are the same Trail", async () => {
  await harness.withStore(async (store) => {
    const created = await createOne(store);
    const list = v.parse(
      TrailListSchema,
      (await post(store, HUMAN, selection(TRAILS), { projectId: created.projectId }))["trails"],
    );
    if (list.__typename === "QueryFailure") throw new Error(list.message);
    const detail = await detailOf(store, created.id);
    const listed = list.trails.find((trail) => trail.id === created.id);
    expect(listed).toBeDefined();
    expect(listed?.title).toBe(detail.title);
    expect(listed?.state).toBe(detail.state);
    expect(listed?.projectId).toBe(detail.projectId);
  });
});

/**
 * The web app's workspace document is one the face accepts.
 *
 * @remarks
 * The document is the shell's compiled operation. Catches a shell document the face refuses: a
 * trails field that lost an argument, a fragment on a type the schema no longer has (the Task
 * list the Sidebar used to read), or a selection the handler's limits refuse.
 */
test("the shell's document is a request the face can serve", async () => {
  const text = textOf(workspaceOperation);
  expect(text).toContain("query ShellWorkspaceQuery");
  expect(text).toContain("trails(projectId: $projectId)");
  expect(text).not.toContain("tasks");
  await harness.withStore(async (store) => {
    const created = await createOne(store);
    const answer = v.parse(
      TrailListSchema,
      (await post(store, HUMAN, selection(TRAILS), { projectId: created.projectId }))["trails"],
    );
    expect(answer.__typename).toBe("TrailList");
  });
});
