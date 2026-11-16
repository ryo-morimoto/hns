import { parse } from "graphql";
import { expect, test } from "vitest";
import { assertWithinLimits, GraphQLRequestLimitError } from "./queries.ts";

const LIMITS = { maxBytes: 2_000, maxDepth: 3, maxComplexity: 4 };

function refuses(query: string): boolean {
  try {
    assertWithinLimits(query, parse(query), LIMITS);
    return false;
  } catch (error) {
    return error instanceof GraphQLRequestLimitError;
  }
}

test("a small query passes every limit", () => {
  expect(refuses("{ projects { __typename } }")).toBe(false);
});

// Catches: a byte limit that counts characters, or one that never fires.
test("a query over the byte limit is refused", () => {
  const aliases = Array.from({ length: 200 }, (_, index) => "a" + String(index) + ": __typename");
  expect(refuses("{ projects { " + aliases.join(" ") + " } }")).toBe(true);
});

// Catches: a depth walk that stops at the first branch or ignores inline fragments.
test("depth counts nested fields and inline fragments", () => {
  expect(refuses("{ a { b { c { d } } } }")).toBe(true);
  expect(refuses("{ a { ... on Query { b { c } } } }")).toBe(false);
});

// Catches: fragments that are not expanded, so a spread hides fields from the count.
test("complexity counts a fragment once per spread", () => {
  expect(refuses("query { a { b } c { d } e }")).toBe(true);
  const fragment = "fragment F on Project { id name } query { projects { ...F } }";
  expect(refuses(fragment)).toBe(false);
});

// Catches: a fragment cycle that makes the walk itself loop (validation would report it later).
test("a fragment cycle ends instead of looping", () => {
  expect(refuses("query { ...F } fragment F on Query { ...F }")).toBe(false);
});
