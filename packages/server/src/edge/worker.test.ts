import assert from "node:assert/strict";
import { expect, test } from "vitest";
import worker from "./worker.ts";
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

test("the production worker fails closed when the session binding is missing", async () => {
  const cookie = await sessionCookie("owner");
  const response = await worker.fetch(
    new Request(BASE + "/ws", { headers: { cookie } }),
    envWith(),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "unavailable" });
});

test("the production worker serves static GET through ASSETS", async () => {
  const assets = assetsWith(new Response("shell", { status: 200 }));
  const response = await worker.fetch(new Request(BASE + "/"), envWith({ assets: assets.fetcher }));
  expect(response.status).toBe(200);
  expect(assets.requests).toHaveLength(1);
});
