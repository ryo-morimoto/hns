import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findInSourceTestCode } from "../dist-check.ts";

const roots: string[] = [];

const fixture = (name: string, body: string): string => {
  const root = mkdtempSync(join(tmpdir(), "hns-dist-check-"));
  roots.push(root);
  writeFileSync(join(root, name), body);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Catches: a doctest comment in dist being reported as executable test code.
test("a TSDoc example comment is not test code", () => {
  const root = fixture(
    "code.js",
    [
      "/**",
      " * @example",
      " * ```ts @import.meta.vitest",
      " * expect(1).toBe(1);",
      " * ```",
      " */",
      "export function value() { return 1; }",
      "",
    ].join("\n"),
  );
  expect(findInSourceTestCode(root)).toStrictEqual([]);
});

// Catches: a build that forgets to strip the native in-source guard.
test("a surviving import.meta.vitest guard is refused", () => {
  const root = fixture(
    "code.js",
    'if (import.meta.vitest) { const { test } = import.meta.vitest; test("x", () => {}); }\n',
  );
  const findings = findInSourceTestCode(root);
  expect(findings.some((finding) => finding.what === "import.meta.vitest")).toBe(true);
});

// Catches: define replacing the guard with undefined while leaving the test body behind.
test("a test call left behind by a define-only rewrite is refused", () => {
  const root = fixture("code.js", 'if (undefined) { test("x", () => { expect(1).toBe(1); }); }\n');
  const findings = findInSourceTestCode(root);
  expect(findings.some((finding) => finding.what === "test()")).toBe(true);
});

// Catches: a guard that emits only the aliases of the same Vitest API.
test("another Vitest entry point left behind is refused", () => {
  const root = fixture(
    "code.js",
    'if (undefined) { it("x", () => {}); describe("y", () => {}); }\n',
  );
  const findings = findInSourceTestCode(root);
  expect(findings.map((finding) => finding.what).sort()).toStrictEqual(["describe()", "it()"]);
});

// Catches: a qualified Vitest call such as test.skip or describe.each.
test("a qualified Vitest call left behind is refused", () => {
  const root = fixture("code.js", 'if (undefined) { test.skip("x", () => {}); }\n');
  expect(findInSourceTestCode(root).map((finding) => finding.what)).toStrictEqual(["test.*()"]);
});
