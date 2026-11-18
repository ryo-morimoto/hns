import { expect, test } from "vitest";
import * as v from "valibot";
import { storeObserveFor } from "../../../server/src/obs/store.ts";
import { checkpointMirrorReporter } from "../../../server/src/checkpoint/mirror-report.ts";
import { workspaceWithStartUp } from "../../../server/src/edge/handler.ts";
import { dependencies } from "../../../server/src/edge/worker.ts";
import { envWith, sessionCookie, sessionWith } from "../../../server/test/support/edge.ts";
import { createEdge } from "../../../server/src/edge/handler.ts";
import { DEFAULT_LIMITS } from "../../../server/src/edge/limits.ts";
import { mirrorObservationEntry } from "../../../server/src/artifacts/observability.ts";

/**
 * The Workspace object start-up, as the production table builds it (0272n).
 *
 * @remarks
 * A Durable Object is constructed as (state, env), so what the object needs besides its bindings
 * is built here and carried on the request that constructs it. These tests pin the production
 * table (not a copy of it) to the three things the object starts with: the observation sink
 * (the Session object own log factory), the Trail lookup, and the mirror reporter.
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

// Catches: the production table starting the object with no sink, which is the state 0249
// recorded as "the line stops at the console and /api/metrics never sees it".
test("the production table starts a Workspace object with the Session log sink", () => {
  const start = dependencies.workspace;
  if (start === undefined) throw new Error("the Workspace start-up is not wired");
  for (const build of [start.observe, start.trails, start.reportMirror]) {
    expect(build).toBeTypeOf("function");
  }
  const env = envWith({ session: sessionWith().namespace });
  expect(start.observe?.(env)).toBeTypeOf("function");
  // No SESSION binding: the sink is absent, not a sink that drops silently, so the object falls
  // back to its console line. That fallback is what 0249 keeps.
  expect(start.observe?.(envWith({}))).toBeUndefined();
  expect(start.trails?.(env)).toBeTypeOf("object");
  expect(start.reportMirror?.(env)).toBeUndefined();
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

// Catches: the Workspace start-up not reaching the object the faces reach, which would leave
// every object with none of the three and the whole wiring inert.
test("every Workspace stub carries the start-up header the Worker built", async () => {
  // One namespace for both halves, as a deployment has: the Worker reaches the object through
  // the binding and the reporter reaches the same object again through it.
  const inner = sessionWith();
  const env = envWith({ workspace: inner.namespace });
  const start = dependencies.workspace;
  if (start === undefined) throw new Error("the Workspace start-up is not wired");
  const namespace = workspaceWithStartUp(env.WORKSPACE, start, env);
  if (namespace === undefined) throw new Error("no Workspace namespace");
  await namespace
    .get(namespace.idFromName("w1"))
    .fetch(new Request("https://workspace.internal/rpc/start"));
  const forwarded = inner.requests[0];
  if (forwarded === undefined) throw new Error("nothing was forwarded");
  // All three are there: the sink (a SESSION binding), the lookup (a DB binding, absent here but
  // built from the env anyway), and the reporter (the same WORKSPACE binding that carries this
  // request, so the object can be reached again after its answer).
  expect(forwarded.headers.get("x-hns-workspace-startup")).toBe("trails,report-mirror");
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
  const db = { prepare: statementOf, batch: () => Promise.resolve([]) };
  // SAFETY: the binding answers the four calls the store makes to open and to list projects;
  // the rows it answers are the whole question this test asks.
  const env = envWith({
    session: session.namespace,
    workspace: workspaces.namespace,
    db: db as never,
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
  // this test is about is the start-up pass that runs after it.
  expect(response.status).toBe(503);
  // Every project's object was reached, and each request carried the start-up.
  expect(workspaces.ids).toStrictEqual(["p1", "p2"]);
  for (const request of workspaces.requests) {
    expect(request.url).toBe("https://workspace.internal/rpc/start");
    expect(request.headers.get("x-hns-workspace-startup")).toContain("trails");
  }
});
