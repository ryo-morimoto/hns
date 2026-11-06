import { test } from "vitest";
import assert from "node:assert/strict";
import * as v from "valibot";
import {
  parseRequest,
  parseResponse,
  type RouteRequest,
  type RouteResponse,
} from "../src/contract.ts";
import { FileWriteRequestSchema } from "../src/schemas.ts";

const at = "2026-11-07T00:00:00.000Z";

test("a valid request parses and keeps its type", () => {
  const parsed = parseRequest("POST /api/chat", { message: "hello", conversationId: "c1" });

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const message: string = parsed.value.message;
  assert.equal(message, "hello");
});

test("an invalid request is a typed error, not a throw", () => {
  const parsed = parseRequest("POST /api/chat", { message: "" });

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.route, "POST /api/chat");
  assert.equal(parsed.error.kind, "request");
  assert.ok(parsed.error.issues.length > 0);
});

test("a route without a body parses to undefined", () => {
  const parsed = parseRequest("GET /api/health", {});

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value, undefined);
});

test("query parameters are parsed with the route", () => {
  assert.equal(parseRequest("GET /api/tasks", { projectId: "p1" }).ok, true);
  assert.equal(parseRequest("GET /api/tasks", { projectId: 1 }).ok, false);
});

test("a response parses", () => {
  const parsed = parseResponse("GET /api/projects", [{ id: "p1", name: "hns", created_at: at }]);

  assert.equal(parsed.ok, true);
});

test("an invalid response is a typed error", () => {
  const parsed = parseResponse("GET /api/projects", [{ id: "p1", name: "hns" }]);

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.kind, "response");
});

test("a route without a request has the undefined request type", () => {
  const noBody: RouteRequest<"GET /api/health"> = undefined;

  assert.equal(noBody, undefined);
});

const invalidProject: RouteResponse<"GET /api/projects"> = [
  // @ts-expect-error(#0037): a plain string is not a ProjectId, so the row must come from a parser.
  { id: "p1", name: "hns", created_at: at },
];

void invalidProject;
// Catches: operationId was free text, so it could become a path segment.
test("a file write refuses an operationId that is not a token", () => {
  const base = { path: "a.txt", content: "x", expectedVersion: "absent" };

  assert.equal(
    v.parse(FileWriteRequestSchema, { ...base, operationId: "w_1-2" }).operationId,
    "w_1-2",
  );
  for (const operationId of ["../x", "a/b", "a b", "x".repeat(65), ""]) {
    assert.throws(
      () => v.parse(FileWriteRequestSchema, { ...base, operationId }),
      String(operationId),
    );
  }
});

// Catches: query schemas declared booleans/numbers that the wire sends as strings.
test("query schemas take the strings the wire sends", () => {
  const listed = parseRequest("GET /api/conversations", { includeArchived: "1", q: "hello" });
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.equal(listed.value.includeArchived, true);
  assert.equal(parseRequest("GET /api/conversations", { includeArchived: "yes" }).ok, false);

  const events = parseRequest("GET /api/events", { limit: "50" });
  assert.equal(events.ok, true);
  if (!events.ok) return;
  assert.equal(events.value.limit, 50);
  assert.equal(parseRequest("GET /api/events", { limit: "0" }).ok, false);
});
