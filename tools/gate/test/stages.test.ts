import assert from "node:assert/strict";
import { expect, test } from "vitest";
import type { PackageInfo } from "../select.ts";
import { stageNamed, stagesFor } from "../stages.ts";

// Catches: build or knip sneaking back into the commit hook.
test("build and knip only run before a push", () => {
  expect(stagesFor("pre-commit").map((stage) => stage.name)).toStrictEqual([
    "lint",
    "fmt",
    "codegen",
    "typecheck",
    "test",
  ]);
  expect(stagesFor("pre-push").map((stage) => stage.name)).toStrictEqual([
    "lint",
    "fmt",
    "codegen",
    "typecheck",
    "test",
    "build",
    "deploy",
    "knip",
  ]);
});

// Catches: a hook running a stage that no hook owns.
test("every stage belongs to at least one hook", () => {
  for (const name of ["lint", "fmt", "codegen", "typecheck", "test", "build", "deploy", "knip"]) {
    const stage = stageNamed(name);
    assert.ok(stage !== undefined, name);
    expect(stage.hooks.length, name).toBeGreaterThan(0);
  }
  expect(stageNamed("nope")).toBe(undefined);
});

// Catches: the dry-run check disappearing from the push gate, or running with credentials.
test("the deploy stage builds the development config", () => {
  const stage = stageNamed("deploy");
  assert.ok(stage !== undefined);
  expect(stage.hooks).toStrictEqual(["pre-push"]);
  const runs = stage.run({ root: "/repo", packages: [], all: true, tier: "all" });
  const env = {
    XDG_CONFIG_HOME: "/repo/.work/cf/config",
    XDG_CACHE_HOME: "/repo/.cache",
  };
  expect(runs).toStrictEqual([
    {
      cwd: "/repo/tools/deploy",
      argv: ["/repo/node_modules/.bin/cf", "deploy", "--dry-run", "--mode", "development"],
      env,
    },
    {
      cwd: "/repo/tools/deploy/gateway",
      argv: ["/repo/node_modules/.bin/cf", "deploy", "--dry-run", "--mode", "development"],
      env,
    },
  ]);
});

// Catches: codegen running for a change that cannot affect the schema or a document, or
// skipping the regeneration when it can.
test("codegen runs only when the artifacts can change", () => {
  const stage = stageNamed("codegen");
  assert.ok(stage !== undefined);
  // record has no path to server, so the closure cannot pull codegen in.
  const record: PackageInfo = { dir: "record", name: "@hns/record", dependsOn: [] };
  expect(stage.run({ root: "/repo", packages: [record], all: false, tier: "unit" })).toStrictEqual([]);
  const web: PackageInfo = { dir: "web", name: "@hns/web", dependsOn: [] };
  const runs = stage.run({ root: "/repo", packages: [web], all: false, tier: "unit" });
  expect(runs.map((run) => run.argv.join(" "))).toStrictEqual([
    process.execPath + " --conditions=source tools/codegen/graphql.ts",
    "/repo/node_modules/.bin/relay-compiler",
    process.execPath + " --conditions=source tools/codegen/verify.ts",
  ]);
});

// Catches: a root trigger at commit time widening the run to the integration tier.
test("the commit tier never runs the whole runner", () => {
  const packages: PackageInfo[] = [{ dir: "core", name: "@hns/core", dependsOn: [] }];
  const stage = stageNamed("test");
  assert.ok(stage !== undefined);
  const unit = stage.run({ root: "/repo", packages, all: true, tier: "unit" })[0]?.argv ?? [];
  expect(unit.includes("--project"), unit.join(" ")).toBe(true);
  expect(unit.includes("core"), unit.join(" ")).toBe(true);
  const every = stage.run({ root: "/repo", packages, all: true, tier: "all" })[0]?.argv ?? [];
  expect(every.includes("--project"), every.join(" ")).toBe(false);
});