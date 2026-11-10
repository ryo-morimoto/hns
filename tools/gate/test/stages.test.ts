import { expect, test } from "vitest";
import type { PackageInfo } from "../select.ts";
import { stageNamed, stagesFor } from "../stages.ts";

// Catches: build or knip sneaking back into the commit hook.
test("build and knip only run before a push", () => {
  expect(stagesFor("pre-commit").map((stage) => stage.name)).toStrictEqual(["lint", "fmt", "typecheck", "test"]);
  expect(stagesFor("pre-push").map((stage) => stage.name)).toStrictEqual(["lint", "fmt", "typecheck", "test", "build", "knip"]);
});

// Catches: a hook running a stage that no hook owns.
test("every stage belongs to at least one hook", () => {
  for (const name of ["lint", "fmt", "typecheck", "test", "build", "knip"]) {
    const stage = stageNamed(name);
    expect.assert(stage !== undefined, name);
    expect(stage.hooks.length, name).toBeGreaterThan(0);
  }
  expect(stageNamed("nope")).toBe(undefined);
});

// Catches: a root trigger at commit time widening the run to the integration tier.
test("the commit tier never runs the whole runner", () => {
  const packages: PackageInfo[] = [{ dir: "core", name: "@hns/core", dependsOn: [] }];
  const stage = stageNamed("test");
  expect.assert(stage !== undefined);
  const unit = stage.run({ root: "/repo", packages, all: true, tier: "unit" })[0]?.argv ?? [];
  expect(unit.includes("--project"), unit.join(" ")).toBe(true);
  expect(unit.includes("core"), unit.join(" ")).toBe(true);
  const every = stage.run({ root: "/repo", packages, all: true, tier: "all" })[0]?.argv ?? [];
  expect(every.includes("--project"), every.join(" ")).toBe(false);
});
