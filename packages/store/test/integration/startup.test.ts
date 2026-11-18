import { expect, test, vi } from "vitest";
import * as v from "valibot";
import { storeObserveFor } from "../../../server/src/obs/store.ts";
import { checkpointMirrorReporter } from "../../../server/src/checkpoint/mirror-report.ts";
import { Workspace } from "../../../server/src/do/workspace.ts";
import { openSqliteState } from "../../../server/test/support/sqlite.ts";
import { dependencies } from "../../../server/src/edge/worker.ts";
import { envWith, sessionCookie, sessionWith } from "../../../server/test/support/edge.ts";
import { createEdge } from "../../../server/src/edge/handler.ts";
import { DEFAULT_LIMITS } from "../../../server/src/edge/limits.ts";
import type { D1Binding } from "../../../store/src/sql.ts";
import { mirrorObservationEntry } from "../../../server/src/artifacts/observability.ts";

/**
 * The Workspace object start-up, as the production table builds it (0272n).
 *
 * @remarks
 * A Durable Object is constructed as (state, env), so the three things the object starts with are
 * built **by the object** from its bindings: the observation sink from SESSION (the Session log's
 * own factory), the Trail lookup from DB, and the mirror reporter from WORKSPACE. These tests pin
 * that to the production code, and pin the Worker's own part — the once-per-isolate start-up pass
 * — to what it promises.
 */

/** The entry one decided mirror reports; nothing in it can carry a token or a remote. */
function entry() {
  return mirrorObservationEntry({
    repo: "ws-w1",
    status: "failed",
    failure: "network",
    durationMs: 12,
    requestId: "request-1",
    now: Date.parse("2026-11-18T00:00:00.000Z"),
  });
}

// Catches: a Workspace object constructed with no sink because nothing passed one — the state
// 0249 recorded as "the line stops at the console and /api/metrics never sees it". The object
// builds the sink from the SESSION binding it is given, and a mirror report through the object's
// own route is where that sink is reached.
test("a decided mirror is reported through the sink the SESSION binding gives the object", async () => {
  const opened = openSqliteState();
  const sent: Request[] = [];
  // The sink posts to the edge's append address; this fetch is what the network would do.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    sent.push(new Request(String(input), init));
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 201 }));
  });
  // The checkpoint the report is about: a completed Run whose mirror is `pending`.
  opened.sql(
    "CREATE TABLE IF NOT EXISTS checkpoint_run (run_id TEXT PRIMARY KEY, prepare TEXT NOT NULL, record TEXT)",
  );
  opened.sql(
    "INSERT INTO checkpoint_run (run_id, prepare, record) VALUES (?, ?, ?)",
    "run-1",
    JSON.stringify({ runId: "run-1" }),
    JSON.stringify({
      runId: "run-1",
      ref: "refs/hns/checkpoints/run-1",
      commit: "d".repeat(40),
      packKey: "checkpoints/" + "d".repeat(40) + ".pack",
      objectCount: 1,
      packBytes: 8,
      maxBlobBytes: 4,
      mirror: { status: "pending", updatedAt: "2026-11-18T00:00:00.000Z" },
    }),
  );
  const workspace = new Workspace(opened.state, {
    now: () => Date.parse("2026-11-18T00:00:00.000Z"),
    SESSION: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: (request: Request) => fetch(request.url, request),
      }),
    },
  });
  const reported = await workspace.fetch(
    new Request("https://workspace.internal/rpc/checkpoint/mirror", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "request-1" },
      body: JSON.stringify({
        workspaceId: "w1",
        runId: "run-1",
        status: "failed",
        failure: "network",
      }),
    }),
  );
  expect(reported.status, await reported.clone().text()).toBe(200);
  // The sink does not wait for the append (an observation is a side effect); let it run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent.map((request) => request.url)).toStrictEqual(["https://edge.internal/api/events"]);
  vi.unstubAllGlobals();
  opened.close();
});

// Catches: an obs sink that is not the edge own append route, so the entry would never reach
// the log /api/metrics reads; or one that raises at the object when the log is down.
test("the obs sink appends through the edge /api/events, with the entry request id", async () => {
  const session = sessionWith();
  const sent: Request[] = [];
  const fetchImpl: typeof fetch = (_input, init) => {
    const request = new Request("https://edge.internal/api/events", init);
    sent.push(request);
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 201 }));
  };
  const observe = storeObserveFor(envWith({ session: session.namespace }), fetchImpl);
  if (observe === undefined) throw new Error("the sink was not built");
  observe(entry());
  // A sink that throws at the caller would fail the mirror for the log problem; it must not.
  const failing = storeObserveFor(envWith({ session: session.namespace }), () =>
    Promise.reject(new Error("the log is down")),
  );
  failing?.(entry());
  // The append is fire-and-forget; let it run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(sent).toHaveLength(1);
  const request = sent[0];
  if (request === undefined) throw new Error("nothing was sent");
  expect(request.url).toBe("https://edge.internal/api/events");
  expect(request.method).toBe("POST");
  expect(request.headers.get("x-request-id")).toBe("request-1");
  const body = v.parse(v.object({ event: v.string() }), JSON.parse(await request.text()));
  expect(body.event).toBe("artifacts.mirror");
});

// Catches: a reporter that sends something other than the object own mirror route, or one that
// puts anything beside the state (the route has no field for a token).
test("the mirror reporter posts the object mirror RPC with no token in it", async () => {
  // The stub answers 200: the route's own status is what the reporter reads, and a refusal is
  // the failing case below.
  const inner = sessionWith(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const reporter = checkpointMirrorReporter(inner.namespace);
  await reporter({
    workspaceId: "w1",
    runId: "run-1",
    status: "failed",
    failure: "push_rejected",
    startedAt: 0,
    requestId: "request-1",
  });
  const sent = inner.requests[0];
  if (sent === undefined) throw new Error("nothing was sent");
  expect(sent.url).toBe("https://workspace.internal/rpc/checkpoint/mirror");
  expect(sent.headers.get("x-request-id")).toBe("request-1");
  expect(JSON.parse(await sent.text())).toStrictEqual({
    workspaceId: "w1",
    runId: "run-1",
    status: "failed",
    failure: "push_rejected",
  });
});

// Catches: an object that is never started because the Worker stops reaching it (an early
// return, a guard that never passes) — the sink and the lookup would then be built by no one,
// and a Workspace object that had not been constructed yet would have neither.
test("a request starts every project's Workspace object through the binding", async () => {
  const session = sessionWith();
  const workspaces = sessionWith(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  // The binding the store opens over: the migrations see an absent version (0) and finish,
  // the seeded project is found, and the project list is the two rows this test starts
  // objects for.
  const projectRow = (id: string) => ({
    id,
    name: id,
    workspace_root: "projects/" + id,
    egress: "inherit",
    created_at: "2026-11-18T00:00:00.000Z",
  });
  const firstFor = (sql: string) => {
    if (sql.includes("MAX(version)")) return { version: 0 };
    if (sql.includes("FROM projects")) return projectRow("default");
    return undefined;
  };
  const allFor = (sql: string) =>
    sql.includes("FROM projects")
      ? { results: [projectRow("p1"), projectRow("p2")] }
      : { results: [] };
  /** One D1 statement: bound or not, it answers the same way for the same SQL. */
  const statementOf = (sql: string) => {
    const statement = {
      bind: () => statementOf(sql),
      all: () => Promise.resolve(allFor(sql)),
      first: () => Promise.resolve(firstFor(sql)),
      run: () => Promise.resolve({ meta: { changes: 1 } }),
    };
    return statement;
  };
  // SAFETY: the fake binding answers the four calls the store makes; the rows it answers are the
  // whole question this test asks.
  const db = { prepare: statementOf, batch: () => Promise.resolve([]) } as D1Binding;
  const env = envWith({
    session: session.namespace,
    workspace: workspaces.namespace,
    db,
  });
  const edge = createEdge(
    {
      graphql: () => Promise.resolve(new Response("{}")),
      ws: () => Promise.resolve(new Response("ws")),
      workspace: dependencies.workspace,
    },
    DEFAULT_LIMITS,
  );
  const response = await edge(
    new Request("https://edge.example/api/events", {
      headers: { cookie: await sessionCookie() },
    }),
    env,
  );
  // The request itself is the Session's to answer (this deployment has no event route); what
  // this test is about is the start-up pass, which runs after it.
  expect(response.status).toBe(503);
  // Every project's object was reached, each with the same request the object answers.
  await waitForPass(workspaces, 2);
  expect(workspaces.ids).toStrictEqual(["p1", "p2"]);
  for (const request of workspaces.requests) {
    expect(request.url).toBe("https://workspace.internal/rpc/start");
  }
});

/**
 * Wait until the start-up pass has reached `count` objects.
 *
 * @param workspaces - The namespace recording the requests it was handed.
 * @param count - How many objects the pass is expected to reach.
 *
 * @remarks
 * The pass runs after the answer and is not awaited by it (0272n), so the test waits for the
 * work the way a runtime keeps it alive — it polls, it does not sleep on a fixed guess.
 */
async function waitForPass(workspaces: ReturnType<typeof sessionWith>, count: number) {
  const started = Date.now();
  while (workspaces.ids.length < count) {
    if (Date.now() - started > 5_000) {
      throw new Error(
        "the start-up pass did not reach the objects: " + JSON.stringify(workspaces.ids),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Acceptance (0272n, lead's NB3): the pass runs **once per isolate**, not once per request. A
// second request finds it already scheduled and must not start it again — the cost of starting
// the three faces must not be paid by every request.
test("a second request does not run the Workspace start-up pass again", async () => {
  const session = sessionWith();
  const workspaces = sessionWith(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const projectRow = (id: string) => ({
    id,
    name: id,
    workspace_root: "projects/" + id,
    egress: "inherit",
    created_at: "2026-11-18T00:00:00.000Z",
  });
  // SAFETY: the binding answers the four calls the store makes to open and list projects; its
  // rows are the whole question this test asks.
  const db = {
    prepare: (sql: string) => {
      const statement = {
        bind: () => statement,
        all: () =>
          Promise.resolve(
            sql.includes("FROM projects") ? { results: [projectRow("p1")] } : { results: [] },
          ),
        first: () =>
          Promise.resolve(sql.includes("MAX(version)") ? { version: 0 } : projectRow("default")),
        run: () => Promise.resolve({ meta: { changes: 1 } }),
      };
      return statement;
    },
    batch: () => Promise.resolve([]),
  } as D1Binding;
  const env = envWith({
    session: session.namespace,
    workspace: workspaces.namespace,
    db,
  });
  const edge = createEdge(
    {
      graphql: () => Promise.resolve(new Response("{}")),
      ws: () => Promise.resolve(new Response("ws")),
      workspace: dependencies.workspace,
    },
    DEFAULT_LIMITS,
  );
  const cookie = await sessionCookie();
  const ask = () =>
    edge(new Request("https://edge.example/api/events", { headers: { cookie } }), env);
  // The same environment across both requests: one isolate, one pass.
  await ask();
  await waitForPass(workspaces, 1);
  await ask();
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Two requests, one start-up pass: the second found it already run.
  expect(workspaces.ids).toStrictEqual(["p1"]);
});
