import type { AgentSession } from "@hns/agent/session";
import { openSession } from "@hns/agent/session";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { openStore, type D1Binding } from "@hns/store";
import { openConversationIndex } from "@hns/store/conversation-index";
import { expect, test } from "vitest";
import * as v from "valibot";
import { openFakeD1 } from "../../../store/test/support/fake-d1.ts";
import { createEdge } from "../edge/handler.ts";
import { forgetStore } from "../edge/store.ts";
import worker from "../edge/worker.ts";
import type { SessionEnv } from "../do/state.ts";
import { Session } from "../do/session.ts";
import { openSqliteState } from "../../test/support/sqlite.ts";
import { envWith, sessionCookie, sessionWith } from "../../test/support/edge.ts";
import { createConversationsFace, lookupConversation } from "./index.ts";

/**
 * 0119 through the product's own parts: the edge, a real D1, the real Session object, and a real
 * `@hns/agent` conversation.
 *
 * @remarks
 * Nothing here is a fake of a boundary the product ships. The D1 is the store's own adapter over
 * SQLite (the migrations and the `conversations` keys run for real), the rows are written by the
 * **real** `SessionIndex` drain of a **real** `Session` object around a **real** `openSession`,
 * and the conversation is created and archived through that runtime. The requests go through
 * `createEdge`, and once through the assembled Worker.
 *
 * The one seam is the machine: a Durable Object namespace whose stub calls `Session#fetch` in this
 * process, because the test has no workerd to host the object. The object's own routing, its D1
 * read, and its state answer are the product's.
 */

const BASE = "https://hns.test";
const LEGACY = "default";

/** A settled send answer: the state route never runs a turn, so the runtime answers none. */
function answer(): Awaited<ReturnType<AgentSession["send"]>> {
  const turn = { settlement: { id: "1", status: "unanswered", reason: "test" }, text: "" };
  // SAFETY: the route reads only the settlement's id; this is the answer of a send whose model
  // never runs.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the fake is not the real Turn.
  return turn as unknown as Awaited<ReturnType<AgentSession["send"]>>;
}

/** A real agent runtime over memory, so the conversation's metadata is the product's. */
async function runtime(): Promise<AgentSession> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return await openSession({
    storage: new MemoryStorage(),
    models,
    registry: createRegistry(),
    model: { provider: "faux", modelId: "faux-1" },
    context: BACKGROUND_CONTEXT,
  });
}

/** The create route's body, as the test reads it: the object's answer for this seam. */
const CreatedBody = v.object({ conversation: v.object({ id: v.string() }) });

/** The bindings a Session opens with: development, so its model is the faux one. */
const DEV: SessionEnv = { HNS_ENV: "dev" };

/** A row the index holds for a conversation no object has: the "the two disagree" case. */
const ORPHAN = "orphan-1";

/** Write the orphan row (the index's own writer, over the real D1). */
async function seedOrphan(d1: D1Binding): Promise<void> {
  await openConversationIndex(d1).upsert([
    {
      id: ORPHAN,
      projectId: LEGACY,
      title: "orphan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archived: false,
      deletedAt: null,
      indexedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
}

/** One opened object and what a test needs to drive it. */
interface Opened {
  readonly session: Session;
  readonly db: D1Binding;
  /** The conversation the real runtime created and the real drain wrote to D1. */
  readonly created: string;
  readonly close: () => Promise<void>;
}

/**
 * Open a Session object around a real runtime and a real D1, then create one conversation.
 *
 * @remarks
 * The object opens its runtime on the first RPC (the list route is that wake-up). The object is
 * given the runtime through its `open` seam, so the runtime the test holds is the one that runs
 * `createConversation`; `send` is the only thing replaced, because a state read never runs a turn
 * and a model would.
 */
async function openObject(): Promise<Opened> {
  const d1 = openFakeD1();
  // The edge opens the store first (migrations and the default project), as a deployment does.
  // Each test's database is its own, so the isolate's memo must not still hold the last one.
  forgetStore(d1.db);
  const store = await openStore({ d1: d1.db });
  await store.close();
  const opened = openSqliteState();
  const storage = {
    ...opened.state.storage,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
  };
  const agent = await runtime();
  /** The object's wake-up that lets the index drains its timer would have run. */
  const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 5; tick += 1) await new Promise((done) => setTimeout(done, 1));
  };
  const runtimeWithAnswer = {
    ...agent,
    send: async () => answer(),
  };
  const session = new Session(
    {
      id: { name: LEGACY },
      storage,
      blockConcurrencyWhile: opened.state.blockConcurrencyWhile,
      abort: () => undefined,
    },
    { ...DEV, DB: d1.db },
    async () => agent,
    { open: async () => runtimeWithAnswer },
  );
  // The list route is the wake-up: the object opens its runtime on the first RPC.
  const list = await session.fetch(
    new Request("https://session.internal/rpc/conversations", {
      headers: { "x-request-id": "seed" },
    }),
  );
  expect(list.status).toBe(200);
  const created = await session.fetch(
    new Request("https://session.internal/rpc/conversations", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "seed" },
      body: JSON.stringify({ title: "the conversation", projectId: LEGACY }),
    }),
  );
  expect(created.status).toBe(201);
  const createdBody = v.parse(CreatedBody, await created.json());
  const id = createdBody.conversation.id;
  // A second RPC drains the index: the object writes its dirty row into the real D1.
  const drain = await session.fetch(
    new Request("https://session.internal/rpc/conversations", {
      headers: { "x-request-id": "drain" },
    }),
  );
  expect(drain.status).toBe(200);
  await settle();
  // The object drains after it answers (D078), so its write may still be in flight here.
  await settle();
  return {
    session,
    db: d1.db,
    created: id,
    close: async () => {
      await agent.close();
      opened.close();
      d1.close();
    },
  };
}

/**
 * The Session namespace this process can serve.
 *
 * @param session - The object this test opened.
 * @remarks
 * The stub is the object itself. The object's name in production is the **conversation** it holds
 * (0270n), not the project: the stub says which name it was addressed by, and the real object
 * serves the request either way, so the route's `conversation` is what decides what it answers.
 * A name the object does not hold is the namespace's absence, which a deployment's binding answers
 * as a 404 (an object is not created for an unknown id it was never written to).
 */
function namespaceOf(session: Session, held: string) {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { readonly name: string }) => ({
      fetch: (request: Request): Promise<Response> =>
        id.name === held || id.name === LEGACY
          ? session.fetch(request)
          : Promise.resolve(new Response("no such object", { status: 404 })),
    }),
  };
}

/**
 * The edge's dependencies: the production conversations face.
 *
 * @remarks
 * The face reads D1 and the object through the environment's bindings, so it is the Worker's
 * wiring with nothing replaced: only the faces this test does not exercise are stubs.
 */
function edgeDeps() {
  return {
    graphql: () => Promise.resolve(new Response("graphql")),
    ws: () => Promise.resolve(new Response("ws")),
    conversations: createConversationsFace(lookupConversation),
  };
}

/** A GET with a signed session cookie, unless the caller asks for none. */
async function get(path: string, signed = true): Promise<Request> {
  const request = new Request(BASE + path);
  if (signed) request.headers.set("cookie", await sessionCookie("owner"));
  return request;
}

test("the edge serves one conversation and its state from D1 and the object", async () => {
  const object = await openObject();
  try {
    await seedOrphan(object.db);
    const edge = createEdge(edgeDeps());
    const env = envWith({ db: object.db, session: namespaceOf(object.session, object.created) });

    const row = await edge(await get("/api/conversations/" + object.created), env);
    expect(row.status).toBe(200);
    expect(await row.json()).toStrictEqual({
      ok: true,
      conversation: {
        id: object.created,
        project_id: LEGACY,
        title: "the conversation",
        created_at: expect.any(String),
        updated_at: expect.any(String),
        archived: false,
        deleted_at: null,
      },
    });

    const state = await edge(await get("/api/conversations/" + object.created + "/state"), env);
    expect(state.status).toBe(200);
    expect(await state.json()).toStrictEqual({
      ok: true,
      // The object's state and the row's metadata, in one answer: this is the round trip 0105
      // asks for. Every key the object answers keeps its spelling; `conversation` is added.
      conversation: {
        id: object.created,
        project_id: LEGACY,
        title: "the conversation",
        created_at: expect.any(String),
        updated_at: expect.any(String),
        archived: false,
        deleted_at: null,
      },
    });

    // An id outside the alphabet is a bad request, not an absence: it never named anything.
    const malformed = await edge(await get("/api/conversations/bad.id/state"), env);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "invalid_request" });

    // The metadata face serves the row it has; it asks the object nothing.
    const orphanRow = await edge(await get("/api/conversations/" + ORPHAN), env);
    expect(orphanRow.status).toBe(200);
    // The row is a copy (D078): a row no object holds is not a conversation. The object says so,
    // and the state route passes the answer through — it never serves a state for a row alone.
    // The object itself is asked first: its answer is the one the route passes through.
    const direct = await object.session.fetch(
      new Request("https://session.internal/rpc/state?conversation=" + ORPHAN),
    );
    expect(direct.status).toBe(404);
    expect(await direct.json()).toStrictEqual({
      ok: false,
      code: "not_found",
      message: "No conversation has this id.",
    });
    const orphan = await edge(await get("/api/conversations/" + ORPHAN + "/state"), env);
    expect(orphan.status).toBe(404);
    expect(await orphan.json()).toMatchObject({ code: "not_found" });
  } finally {
    await object.close();
  }
});

test("an archived conversation answers 200 with archived true; a deleted one is 404", async () => {
  const object = await openObject();
  try {
    const index = openConversationIndex(object.db);
    const row = (archived: boolean, deletedAt: string | null, updatedAt: string) => ({
      id: object.created,
      projectId: LEGACY,
      title: "the conversation",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt,
      archived,
      deletedAt,
      indexedAt: updatedAt,
    });
    await index.upsert([row(true, null, "2099-01-02T00:00:00.000Z")]);
    expect(
      await object.db
        .prepare("SELECT archived, deleted_at, updated_at FROM conversations WHERE id = ?")
        .bind(object.created)
        .first(),
    ).toStrictEqual({ archived: 1, deleted_at: null, updated_at: "2099-01-02T00:00:00.000Z" });
    const edge = createEdge(edgeDeps());
    const env = envWith({ db: object.db, session: namespaceOf(object.session, object.created) });
    const archived = await edge(await get("/api/conversations/" + object.created), env);
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({
      ok: true,
      conversation: { id: object.created, archived: true, deleted_at: null },
    });

    // The soft delete is the tombstone the row carries (0029): the same answer as no row.
    await index.upsert([row(true, "2099-01-03T00:00:00.000Z", "2099-01-03T00:00:00.000Z")]);
    const deleted = await edge(await get("/api/conversations/" + object.created), env);
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toMatchObject({ code: "not_found" });
    const deletedState = await edge(
      await get("/api/conversations/" + object.created + "/state"),
      env,
    );
    expect(deletedState.status).toBe(404);
  } finally {
    await object.close();
  }
});

test("an unknown conversation is 404 and an anonymous request is 401", async () => {
  const object = await openObject();
  try {
    const edge = createEdge(edgeDeps());
    const env = envWith({ db: object.db, session: namespaceOf(object.session, object.created) });
    const unknown = await edge(await get("/api/conversations/no-such-conversation"), env);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "not_found" });
    for (const path of [
      "/api/conversations/" + object.created,
      "/api/conversations/" + object.created + "/state",
    ]) {
      const anonymous = await edge(await get(path, false), env);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: "unauthorized" });
    }
  } finally {
    await object.close();
  }
});

// Catches: the assembled Worker missing the route, or its face reading a different table.
test("the assembled Worker serves the face and fails closed without a database", async () => {
  const cookie = await sessionCookie("owner");
  const session = sessionWith();
  const without = await worker.fetch(
    new Request(BASE + "/api/conversations/some-conversation", {
      headers: { cookie },
    }),
    envWith({ session: session.namespace }),
  );
  expect(without.status).toBe(503);
  expect(await without.json()).toMatchObject({ code: "unavailable" });
  // No object was addressed: the database is what the face reads, and the edge never asks one.
  expect(session.requests.map((request) => new URL(request.url).pathname)).toStrictEqual([
    "/rpc/events",
  ]);
});
