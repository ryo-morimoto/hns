import assert from "node:assert/strict";
import { test } from "vitest";
import { formatHash, parseHash } from "../../src/routes/route.ts";

test("workspace and conversation hashes parse", () => {
  assert.deepEqual(parseHash("#/p/p1"), { kind: "workspace", projectId: "p1" });
  assert.deepEqual(parseHash("#/p/p1/c/c1"), {
    kind: "conversation",
    projectId: "p1",
    conversationId: "c1",
  });
});

// Catches: a typo'd or stale URL rendering a conversation that does not exist.
test("unknown hashes fall back to the bare workspace", () => {
  assert.deepEqual(parseHash("#/nope"), { kind: "workspace", projectId: null });
  assert.deepEqual(parseHash(""), { kind: "workspace", projectId: null });
  assert.deepEqual(parseHash("#/p/p1/x/c1"), { kind: "workspace", projectId: "p1" });
  assert.deepEqual(parseHash("#/p/p1/c/%"), { kind: "workspace", projectId: "p1" });
});

test("formatHash round-trips ids that need encoding", () => {
  const route = { kind: "conversation" as const, projectId: "a/b", conversationId: "c d" };

  assert.equal(formatHash(route), "#/p/a%2Fb/c/c%20d");
  assert.deepEqual(parseHash(formatHash(route)), route);
});
