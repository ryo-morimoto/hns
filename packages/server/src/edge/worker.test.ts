import assert from "node:assert/strict";
import { expect, test } from "vitest";
import worker, { resolveSessionName, type ProjectLookup } from "./worker.ts";
import { StoreUnavailableError } from "./store.ts";
import { project } from "../../test/support/graphql.ts";
import { assetsWith, envWith, sessionCookie, sessionWith } from "../../test/support/edge.ts";

const BASE = "https://hns.test";

test("the production worker denies GraphQL without a session", async () => {
  const response = await worker.fetch(
    new Request(BASE + "/graphql", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    }),
    envWith(),
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "unauthorized" });
});

// Catches: the assembled Worker serving a different GraphQL face than the resolver module.
test("the production worker serves GraphQL and fails closed without the database", async () => {
  const cookie = await sessionCookie("owner");
  const response = await worker.fetch(
    new Request(BASE + "/graphql", {
      method: "POST",
      body: JSON.stringify({ query: "{ projects { __typename ... on QueryFailure { code } } }" }),
      headers: { "content-type": "application/json", cookie },
    }),
    envWith(),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { projects: { __typename: "QueryFailure", code: "UNAVAILABLE" } },
  });
});

// Catches: a correlation id that stops at the edge instead of reaching the DO.
test("the production worker forwards /ws with the request id", async () => {
  const cookie = await sessionCookie("owner");
  const session = sessionWith();
  const response = await worker.fetch(
    new Request(BASE + "/ws", { headers: { cookie, "x-request-id": "caller-2" } }),
    envWith({ session: session.namespace }),
  );
  expect(response.status).toBe(501);
  expect(session.ids.every((id) => id === "default")).toBe(true);
  const forwarded = session.requests.at(0);
  assert.ok(forwarded !== undefined);
  expect(forwarded.url).toContain("/ws");
  expect(forwarded.headers.get("x-request-id")).toBe("caller-2");
  expect(response.headers.get("x-request-id")).toBe("caller-2");
  const recorded = session.requests.at(1);
  assert.ok(recorded !== undefined);
  expect(recorded.method).toBe("POST");
  expect(recorded.url).toContain("/rpc/events");
  expect(recorded.headers.get("x-request-id")).toBe("caller-2");
});

// Catches: the REST face 404ing, or the correlation id stopping before the DO.
test("the production worker forwards the observability API with the request id", async () => {
  const cookie = await sessionCookie("owner");
  const session = sessionWith(new Response('{"ok":true,"events":[]}', { status: 200 }));
  const response = await worker.fetch(
    new Request(BASE + "/api/events?limit=5", {
      headers: { cookie, "x-request-id": "caller-3" },
    }),
    envWith({ session: session.namespace }),
  );
  expect(response.status).toBe(200);
  const forwarded = session.requests.at(0);
  assert.ok(forwarded !== undefined);
  expect(forwarded.url).toContain("/rpc/events?limit=5");
  expect(forwarded.headers.get("x-request-id")).toBe("caller-3");
  expect(response.headers.get("x-request-id")).toBe("caller-3");
});

// Catches: the observability API 404ing or crashing when the SESSION binding is absent.
test("the observability API fails closed without a session binding", async () => {
  const cookie = await sessionCookie("owner");
  const response = await worker.fetch(
    new Request(BASE + "/api/metrics", { headers: { cookie } }),
    envWith(),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "unavailable" });
  expect(response.headers.get("x-request-id")).not.toBeNull();
});

test("the production worker fails closed when the session binding is missing", async () => {
  const cookie = await sessionCookie("owner");
  const response = await worker.fetch(
    new Request(BASE + "/ws", { headers: { cookie } }),
    envWith(),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "unavailable" });
});

// Catches: a project switch that still addresses the one legacy Session object.
test("a project WebSocket addresses that project's Session object", async () => {
  const lookup: ProjectLookup = (_env, id) => Promise.resolve(project(id));
  const resolved = await resolveSessionName(envWith(), "p1", lookup);
  expect(resolved).toStrictEqual({ ok: true, name: "p1" });
});

// Catches: a missing project parameter breaking the conversations the deployment already has.
test("a WebSocket with no project keeps the legacy default object", async () => {
  const lookup: ProjectLookup = () => Promise.reject(new Error("must not be called"));
  expect(await resolveSessionName(envWith(), null, lookup)).toStrictEqual({
    ok: true,
    name: "default",
  });
  expect(
    await resolveSessionName(envWith(), "default", () => Promise.resolve(project("default"))),
  ).toStrictEqual({ ok: true, name: "default" });
});

// Catches: an unknown project creating an empty Session object.
test("an unknown project is refused before any object is addressed", async () => {
  const resolved = await resolveSessionName(envWith(), "missing", () => Promise.resolve(undefined));
  expect(resolved).toStrictEqual({
    ok: false,
    code: "not_found",
    message: "No project has this id.",
  });
});

// Catches: an unreadable database reported as "no such project", hiding an outage.
test("a failed project lookup is unavailable, not not_found", async () => {
  const resolved = await resolveSessionName(envWith(), "p1", () =>
    Promise.reject(new StoreUnavailableError("db down")),
  );
  expect(resolved).toMatchObject({ ok: false, code: "unavailable" });
});

// Catches: a corrupt project row rounded into a retryable outage instead of a defect.
test("a project lookup defect is not turned into an outage", async () => {
  await expect(
    resolveSessionName(envWith(), "p1", () => Promise.reject(new Error("corrupt row"))),
  ).rejects.toThrow(/corrupt row/u);
});

// Catches: a path or an empty string used as a Durable Object name.
test.each(["", "../x", "a/b", "a b", "a".repeat(129)])(
  "an invalid project parameter is refused: %j",
  async (raw) => {
    const resolved = await resolveSessionName(envWith(), raw, () =>
      Promise.reject(new Error("must not be called")),
    );
    expect(resolved).toMatchObject({ ok: false, code: "invalid_request" });
  },
);

test("the production worker serves static GET through ASSETS", async () => {
  const assets = assetsWith(new Response("shell", { status: 200 }));
  const response = await worker.fetch(new Request(BASE + "/"), envWith({ assets: assets.fetcher }));
  expect(response.status).toBe(200);
  expect(assets.requests).toHaveLength(1);
});
