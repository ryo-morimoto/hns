import assert from "node:assert/strict";
import { test } from "vitest";
import type { PackageInfo } from "../select.ts";
import { stageNamed, stagesFor } from "../stages.ts";

// Catches: build or knip sneaking back into the commit hook.
test("build and knip only run before a push", () => {
  assert.deepEqual(
    stagesFor("pre-commit").map((stage) => stage.name),
    ["lint", "fmt", "typecheck", "test"],
  );
  assert.deepEqual(
    stagesFor("pre-push").map((stage) => stage.name),
    ["lint", "fmt", "typecheck", "test", "build", "knip"],
  );
});

// Catches: a hook running a stage that no hook owns.
test("every stage belongs to at least one hook", () => {
  for (const name of ["lint", "fmt", "typecheck", "test", "build", "knip"]) {
    const stage = stageNamed(name);
    assert.ok(stage !== undefined, name);
    assert.ok(stage.hooks.length > 0, name);
  }
  assert.equal(stageNamed("nope"), undefined);
});

// Catches: a root trigger at commit time widening the run to the integration tier.
test("the commit tier never runs the whole runner", () => {
  const packages: PackageInfo[] = [{ dir: "core", name: "@hns/core", dependsOn: [] }];
  const stage = stageNamed("test");
  assert.ok(stage !== undefined);
  const unit = stage.run({ root: "/repo", packages, all: true, tier: "unit" })[0]?.argv ?? [];
  assert.ok(unit.includes("--project"), unit.join(" "));
  assert.ok(unit.includes("core"), unit.join(" "));
  const every = stage.run({ root: "/repo", packages, all: true, tier: "all" })[0]?.argv ?? [];
  assert.equal(every.includes("--project"), false, every.join(" "));
});
