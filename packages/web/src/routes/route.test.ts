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

// Catches: a file address that opens the workspace instead (the panel would never open), and a
// path with directories losing its first segment to the route's own split.
test("a doc hash names one file of the project", () => {
  expect(parseHash("#/p/p1/doc/提案書.docx")).toStrictEqual({
    kind: "file",
    projectId: "p1",
    path: "提案書.docx",
  });
  expect(parseHash("#/p/p1/doc/提案/本文.docx")).toStrictEqual({
    kind: "file",
    projectId: "p1",
    path: "提案/本文.docx",
  });
  expect(parseHash("#/p/p1/doc/%E6%8F%90%E6%A1%88.docx")).toStrictEqual({
    kind: "file",
    projectId: "p1",
    path: "提案.docx",
  });
});

test("a doc hash round-trips a path that needs encoding", () => {
  for (const path of ["提案書.docx", "提案/本文 v2.xlsx", "a+b/c%2Fd.pptx"]) {
    const route = { kind: "file" as const, projectId: "p1", path };
    expect(parseHash(formatHash(route))).toStrictEqual(route);
  }
});

// Catches: a path climbing out of the workspace reaching the server (a read the contract refuses
// anyway, asked for from a URL anyone can type), and an empty path opening the workspace instead
// of the panel's refusal.
test("a doc hash names no file when the path could leave the workspace", () => {
  for (const hash of [
    "#/p/p1/doc/..%2F..%2Fsecret",
    "#/p/p1/doc/../x",
    "#/p/p1/doc/a/../b",
    "#/p/p1/doc/",
    "#/p/p1/doc",
    "#/p/p1/doc/%",
  ]) {
    const route = parseHash(hash);
    expect(route.kind === "file" ? route.path : "not a file").toBe(null);
  }
});
