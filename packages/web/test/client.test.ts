import assert from "node:assert/strict";
import { test } from "vitest";
import { createWebClient } from "../src/api/client.ts";
import { ApiError } from "../src/api/errors.ts";

function json(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

test("the path comes from ROUTES and the success body is parsed", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    seen = { url: String(input), init: init ?? {} };
    return json(
      200,
      JSON.stringify({ id: "p-1", name: "renamed", created_at: "2026-11-07T00:00:00.000Z" }),
    );
  };
  const client = createWebClient({ baseUrl: "http://api.test/", fetch: fetchImpl });

  const project = await client.request("PATCH /api/projects/:id", {
    params: { id: "p 1" },
    input: { name: "renamed" },
  });

  assert.equal(project.name, "renamed");
  assert.equal(seen?.url, "http://api.test/api/projects/p%201");
  assert.equal(seen?.init.method, "PATCH");
  assert.equal(seen?.init.body, JSON.stringify({ name: "renamed" }));
});

test("GET input becomes the query string the schema reads", async () => {
  let url = "";
  const fetchImpl: typeof fetch = async (input) => {
    url = String(input);
    return json(200, "[]");
  };
  const client = createWebClient({ baseUrl: "http://api.test", fetch: fetchImpl });

  await client.request("GET /api/conversations", {
    input: { q: "web ui", includeArchived: true },
  });

  assert.equal(url, "http://api.test/api/conversations?q=web+ui&includeArchived=true");
});

test("an empty GET input adds no query marker", async () => {
  let url = "";
  const fetchImpl: typeof fetch = async (input) => {
    url = String(input);
    return json(200, "[]");
  };
  const client = createWebClient({ baseUrl: "http://api.test", fetch: fetchImpl });

  await client.request("GET /api/tasks", { input: {} });

  assert.equal(url, "http://api.test/api/tasks");
});

// Catches: an HTTP error losing its status, code, or route on the way to the caller.
test("an HTTP error becomes an ApiError with status, code, and route", async () => {
  const fetchImpl: typeof fetch = async () =>
    json(404, JSON.stringify({ code: "not_found", message: "no project" }));
  const client = createWebClient({ baseUrl: "http://api.test", fetch: fetchImpl });

  try {
    await client.request("GET /api/projects");
    assert.fail("expected an ApiError");
  } catch (error) {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, "http");
    assert.equal(error.status, 404);
    assert.equal(error.code, "not_found");
    assert.equal(error.route, "GET /api/projects");
    assert.equal(error.message, "no project");
  }
});

test("a network failure becomes an ApiError with no status", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("offline");
  };
  const client = createWebClient({ baseUrl: "http://api.test", fetch: fetchImpl });

  try {
    await client.request("GET /api/state");
    assert.fail("expected an ApiError");
  } catch (error) {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, "network");
    assert.equal(error.status, null);
    assert.equal(error.issues.length, 0);
  }
});

// Catches: a malformed success body being handed to the screen as if it were parsed.
test("a contract violation becomes an ApiError that names the bad fields", async () => {
  const fetchImpl: typeof fetch = async () =>
    json(200, JSON.stringify({ messages: "not-an-array" }));
  const client = createWebClient({ baseUrl: "http://api.test", fetch: fetchImpl });

  try {
    await client.request("GET /api/state");
    assert.fail("expected an ApiError");
  } catch (error) {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, "contract");
    assert.equal(error.status, 200);
    assert.equal(error.route, "GET /api/state");
    assert.ok(error.issues.length > 0);
    assert.match(error.issues.join("; "), /messages/u);
  }
});

// Catches: an aborted fetch reported as a network failure, which React Query cannot cancel.
test("an abort keeps its DOMException", async () => {
  const abort = new DOMException("aborted", "AbortError");
  const fetchImpl: typeof fetch = async () => {
    throw abort;
  };
  const client = createWebClient({ baseUrl: "http://api.test", fetch: fetchImpl });

  try {
    await client.request("GET /api/state");
    assert.fail("expected the abort to surface");
  } catch (error) {
    assert.equal(error, abort);
  }
});

test("a body that is not JSON becomes a contract ApiError", async () => {
  const fetchImpl: typeof fetch = async () => new Response("<html>", { status: 200 });
  const client = createWebClient({ baseUrl: "http://api.test", fetch: fetchImpl });

  try {
    await client.request("GET /api/projects");
    assert.fail("expected an ApiError");
  } catch (error) {
    assert.ok(error instanceof ApiError);
    assert.equal(error.kind, "contract");
    assert.deepEqual(error.issues, ["response body is not JSON"]);
  }
});
