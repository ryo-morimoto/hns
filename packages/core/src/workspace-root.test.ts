import { expect, test } from "vitest";
import {
  parseProjectWorkspaceRoot,
  parseWorkspaceRoot,
  WORKSPACE_ROOT_MAX_LENGTH,
  WORKSPACE_ROOT_MAX_SEGMENT_LENGTH,
  workspaceRootProblem,
} from "./workspace-root.ts";

// Catches: an absolute host path stored as a project root, which names another directory or user.
test("an absolute path is refused", () => {
  expect(workspaceRootProblem("/home/someone/project")).toBeDefined();
  expect(() => parseWorkspaceRoot("/abs")).toThrow();
});

// Catches: a parent segment climbing above the machine root, or a link name being resolved.
test.each(["../x", "a/../b", "..", "."])("a relative segment is refused: %s", (value) => {
  expect(workspaceRootProblem(value)).toBeDefined();
  expect(() => parseWorkspaceRoot(value)).toThrow();
});

// Catches: an empty segment collapsing two names into one, or a trailing slash changing the path.
test.each(["a//b", "a/", "//a"])("an empty segment is refused: %s", (value) => {
  expect(workspaceRootProblem(value)).toBeDefined();
});

// Catches: a backslash or NUL reaching the machine, where it means a separator or truncation.
test.each(["a\\b", "a/b\\c", "a\0b"])("a backslash or NUL is refused: %s", (value) => {
  expect(workspaceRootProblem(value)).toBeDefined();
});

// Catches: a root naming hns's own metadata, which the sandbox hides and the machine must not bind.
test.each([".hns", ".hns/x", "a/.hns"])("a .hns segment is refused: %s", (value) => {
  expect(workspaceRootProblem(value)).toBeDefined();
});

// Catches: a drive-letter name that means an absolute path on another platform.
test.each(["C:", "C:/x"])("a drive letter is refused: %s", (value) => {
  expect(workspaceRootProblem(value)).toBeDefined();
});

// Catches: an unbounded root or segment making storage and the machine's open path unbounded.
test("the length bounds are boundaries, not approximations", () => {
  expect(workspaceRootProblem("a".repeat(WORKSPACE_ROOT_MAX_SEGMENT_LENGTH))).toBeUndefined();
  expect(workspaceRootProblem("a".repeat(WORKSPACE_ROOT_MAX_SEGMENT_LENGTH + 1))).toBeDefined();
  const segment = "a".repeat(63);
  const atLimit = [segment, segment, segment, segment].join("/");
  expect(atLimit.length).toBe(WORKSPACE_ROOT_MAX_LENGTH);
  expect(workspaceRootProblem(atLimit)).toBeUndefined();
  const overLimit = ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)].join("/");
  expect(overLimit.length).toBe(WORKSPACE_ROOT_MAX_LENGTH + 4);
  expect(workspaceRootProblem(overLimit)).toBe(
    "workspaceRoot must be at most " + String(WORKSPACE_ROOT_MAX_LENGTH) + " characters",
  );
});

// Catches: the machine ROOT being mistaken for an invalid empty value.
test("the empty root is the machine ROOT and parses", () => {
  expect(parseWorkspaceRoot("")).toBe("");
  expect(workspaceRootProblem("")).toBeUndefined();
});

// Catches: a newly created project silently pointing at the machine ROOT.
test("creating a project requires a non-empty root", () => {
  expect(() => parseProjectWorkspaceRoot("")).toThrow();
  expect(parseProjectWorkspaceRoot("projects/a")).toBe("projects/a");
});

test.each(["projects/a", "a", "a/b/c"])("a canonical root is accepted unchanged: %s", (value) => {
  expect(parseWorkspaceRoot(value)).toBe(value);
  expect(parseProjectWorkspaceRoot(value)).toBe(value);
});

test("a non-string root is refused", () => {
  expect(() => parseWorkspaceRoot(42)).toThrow();
  expect(() => parseProjectWorkspaceRoot(null)).toThrow();
});
