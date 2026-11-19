import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";
import { toGlobalId } from "@hns/core/graphql";
import { openStore } from "../../../store/src/index.ts";
import { createD1Harness, type D1Harness } from "../../../store/test/integration/harness.ts";
import { createGraphQLFace } from "../../src/graphql/index.ts";
import { officeObjectName } from "../../src/office/route.ts";
import { envWith, sessionWith } from "../support/edge.ts";
import { openSqliteState } from "../support/sqlite.ts";
import { Session } from "../../src/do/session.ts";
import type { SessionEnv, SessionState } from "../../src/do/state.ts";
import type { AgentSession } from "@hns/agent/session";

/**
 * The office fields' workspace, end to end through the face the edge calls (0239, NB1).
 *
 * @remarks
 * **The argument the office fields are given is the graph's workspace id**, and the row that
 * decides a preview is keyed by the project's own id (D080). The step between the two —
 * `officeProjectId` in the port's project lookup, and `officeObjectName` in the object and the
 * version read — had no test at any layer: the resolver tests replace the port, and the journey
 * replaces the port's project lookup, so deleting either conversion left every test green (the
 * review's NB1, and this series' sixth instance of it).
 *
 * This file passes **neither** of those seams. The face is `createGraphQLFace()` with its own
 * port; the port's project lookup reads a **real D1** (miniflare's workerd) through the edge's own
 * store; the Session binding is a real `Session` object over its own SQLite; the Workspace
 * binding is a real `Workspace` object. What a mutation of either conversion breaks, this file
 * fails on: the lookup answers "no project" and the field answers the failure union, not the row.
 *
 * **The mutation was measured, and it is why the assertions read messages.** Two conversions
 * stand between the graph id and an object — the port's project lookup (`officeProjectId`) and
 * the version read's object name (`officeObjectName`) — and either alone finds the project, so
 * the first version of this file (code-only) stayed green with **both** broken. Each is now
 * removed on its own and the file fails: `officeProjectId` by the engine probe's reason,
 * `officeObjectName` by the read's own no-row sentence.
 */
/** A conversation runtime that never runs a turn: office never opens one. */
function inertSession(): AgentSession {
  return {
    closed: new Promise(() => undefined),
    createConversation: async () => {
      throw new Error("unused");
    },
    listConversations: async () => [],
    getConversation: async () => undefined,
    send: async () => {
      throw new Error("unused");
    },
    transcript: async () => [],
    watchConversation: async () => {
      throw new Error("unused");
    },
    abort: async () => false,
    pendingIndex: async () => ({ entries: [], remaining: 0, legacy: 0 }),
    markIndexed: async () => undefined,
    indexRows: async () => [],
    wake: () => ({ active: false }),
    resume: () => undefined,
    close: async () => undefined,
  };
}

/** One workerd for the file: starting it per test is what a 30-second test cannot afford. */
let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

/**
 * Reset the database and insert one project with the id the test names.
 *
 * @param projectId - The project id (the workspace id D080 keys the rows by).
 * @returns Nothing.
 *
 * @remarks
 * The store's `create` mints its own id, and the point of the file is a **named** project, so
 * the row is inserted after the store's own migrations have made the table.
 */
async function withProject(projectId: string): Promise<void> {
  await harness.reset();
  const store = await openStore({ d1: harness.db });
  await store.close();
  await harness.db
    .prepare(
      "INSERT INTO projects (id, name, workspace_root, egress, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(projectId, projectId, "", "inherit", "2026-01-01T00:00:00.000Z")
    .run();
}

/** The office fields' answer, parsed at the boundary: the union member the face serialized. */
const AnswerSchema = v.object({
  __typename: v.string(),
  status: v.optional(v.string()),
  code: v.optional(v.string()),
  message: v.optional(v.string()),
  reason: v.optional(v.string()),
});

type Answer = v.InferOutput<typeof AnswerSchema>;

/**
 * Run one office field through the face, with the deployment's own port.
 *
 * @param query - The GraphQL document.
 * @returns The field's union member.
 *
 * @remarks
 * The environment carries the real D1 as `DB` and the real objects as `SESSION`/`WORKSPACE`;
 * the face builds its own office port from them, so every id the port composes is the
 * production's. **No `office` or `officeProject` dependency is passed here** — that is the
 * point of the file.
 */
async function ask(query: string): Promise<Answer> {
  const workspaces = new Map<string, Session>();
  const env = envWith({
    db: harness.db,
    session: {
      idFromName: (name: string) => ({ name }),
      get: (id: { readonly name: string }) => {
        const name = id.name;
        let object = workspaces.get(name);
        if (object === undefined) {
          const opened = openSqliteState();
          const state: SessionState = {
            id: { name },
            storage: {
              ...opened.state.storage,
              getAlarm: async () => null,
              setAlarm: async () => undefined,
              deleteAlarm: async () => undefined,
            },
            blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
            abort: () => undefined,
          };
          // SAFETY: `envWith` builds the edge's `WorkerEnv`, and the object reads the same
          // bindings through its own structural type (every field optional).
          const bindings = env as SessionEnv;
          object = new Session(state, bindings, async () => inertSession());
          workspaces.set(name, object);
        }
        return { fetch: async (request: Request) => await object.fetch(request) };
      },
    },
    workspace: sessionWith().namespace,
  });
  const face = createGraphQLFace();
  const response = await face({
    request: new Request("https://hns.test/graphql", { method: "POST" }),
    env,
    session: { subject: "owner", expiresAt: 0 },
    requestId: "office-workspace-id",
    signal: new AbortController().signal,
    body: JSON.stringify({ query, variables: {} }),
  });
  expect(response.status).toBe(200);
  // The envelope is parsed at this boundary, as every external value is: a body that is not the
  // GraphQL response is a failure here, not an `undefined` read later.
  const body = v.parse(
    v.object({
      data: v.object({
        documentPreview: v.optional(AnswerSchema),
        requestDocumentPreview: v.optional(AnswerSchema),
        officeEngine: v.optional(AnswerSchema),
      }),
    }),
    await response.json(),
  );
  const answer =
    body.data.documentPreview ?? body.data.requestDocumentPreview ?? body.data.officeEngine;
  if (answer === undefined) throw new Error("the field has no answer");
  return answer;
}

// Catches: the graph id reaching the store unanswered — a project lookup given
// `Project:<base64url>` asks D1 for that string, finds no row, and the field turns into
// `not_authorized / engine_unavailable` instead of the row it should have read.
test("the office fields find the project of a graph workspace id in a real D1", async () => {
  await harness.reset();
  await withProject("office-workspace");
  const workspace = toGlobalId("Project", "office-workspace");
  // The object's name is the project's id, not the graph's: this is what the port must reach.
  expect(officeObjectName(workspace)).toBe("office-workspace");
  // **The message is what tells the two paths apart**, and it is why the code is not enough.
  // Two conversions stand between the graph id and the object — the port's project lookup
  // (`officeProjectId`) and the version read's object name (`officeObjectName`) — and **either
  // alone finds the project**, so a code-only assertion passes with both broken (measured: the
  // mutation run left this green). The read's no-row failure says so: a lookup that missed the
  // project never addresses an object and answers "No preview has been requested".
  const answer = await ask(
    `query { documentPreview(workspaceId: "${workspace}", path: "a.docx") { __typename ... on DocumentPreview { status } ... on OfficeFailure { code message } } }`,
  );
  expect(answer.__typename).toBe("OfficeFailure");
  expect(answer.code).toBe("ENGINE_UNAVAILABLE");
  expect(answer.message).not.toContain("No preview has been requested");
});

// Catches: the same conversion in the engine probe — the probe's workspace too is the graph's.
test("the engine probe of a graph workspace id reaches the project's session", async () => {
  await harness.reset();
  await withProject("office-engine");
  const workspace = toGlobalId("Project", "office-engine");
  const answer = await ask(
    `query { officeEngine(workspaceId: "${workspace}") { __typename ... on OfficeEngineAvailable { id } ... on OfficeEngineUnavailable { reason } ... on OfficeFailure { code } } }`,
  );
  // The object this reaches was constructed by the test's Session binding under the project's
  // own name: had the port asked for the graph id, `stubFor` would have found no project and
  // answered "This project has no session to ask." — the reason a found project never gives.
  expect(answer.__typename).toBe("OfficeEngineUnavailable");
  expect(answer.reason).not.toBe("This project has no session to ask.");
});

test("the request mutation of a graph workspace id answers a row, not a refusal", async () => {
  await harness.reset();
  await withProject("office-request");
  const workspace = toGlobalId("Project", "office-request");
  const answer = await ask(
    `mutation { requestDocumentPreview(workspaceId: "${workspace}", path: "a.docx") { __typename ... on DocumentPreview { status version } ... on OfficeFailure { code message } } }`,
  );
  // No machine is enrolled, so the row is the contract's failure for "no engine" — created by
  // the object the lookup found. A lookup that missed the project never writes a row and answers
  // the read's own "no preview has been requested", which is the refusal this asserts against.
  expect(answer.__typename).toBe("OfficeFailure");
  expect(answer.code).toBe("ENGINE_UNAVAILABLE");
  expect(answer.message).not.toContain("No preview has been requested");
});
