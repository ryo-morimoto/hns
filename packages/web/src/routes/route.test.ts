import { expect, test } from "vitest";
import { formatHash, parseHash } from "./route.ts";

test("workspace and conversation hashes parse", () => {
  expect(parseHash("#/p/p1")).toStrictEqual({ kind: "workspace", projectId: "p1" });
  expect(parseHash("#/p/p1/c/c1")).toStrictEqual({
    kind: "conversation",
    projectId: "p1",
    conversationId: "c1",
  });
});

// Catches: a typo'd or stale URL rendering a conversation that does not exist.
test("unknown hashes fall back to the bare workspace", () => {
  expect(parseHash("#/nope")).toStrictEqual({ kind: "workspace", projectId: null });
  expect(parseHash("")).toStrictEqual({ kind: "workspace", projectId: null });
  expect(parseHash("#/p/p1/x/c1")).toStrictEqual({ kind: "workspace", projectId: "p1" });
  expect(parseHash("#/p/p1/c/%")).toStrictEqual({ kind: "workspace", projectId: "p1" });
});

// Catches: a policy link that opens the workspace (the proposal page unreachable), and a policy
// hash with a malformed segment rendering a policy screen for the wrong workspace.
test("a policy hash names the workspace's policy screen", () => {
  expect(parseHash("#/p/p1/policy")).toStrictEqual({ kind: "policy", projectId: "p1" });
  expect(formatHash({ kind: "policy", projectId: "a/b" })).toBe("#/p/a%2Fb/policy");
  expect(parseHash(formatHash({ kind: "policy", projectId: "a/b" }))).toStrictEqual({
    kind: "policy",
    projectId: "a/b",
  });
  expect(parseHash("#/p/p1/policies")).toStrictEqual({ kind: "workspace", projectId: "p1" });
  expect(parseHash("#/p/p1/policy/c1")).toStrictEqual({ kind: "workspace", projectId: "p1" });
});

test("formatHash round-trips ids that need encoding", () => {
  const route = { kind: "conversation" as const, projectId: "a/b", conversationId: "c d" };

  expect(formatHash(route)).toBe("#/p/a%2Fb/c/c%20d");
  expect(parseHash(formatHash(route))).toStrictEqual(route);
});
