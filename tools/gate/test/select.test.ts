import assert from "node:assert/strict";
import { test } from "vitest";
import { orderByDependency, select } from "../select.ts";
import type { PackageInfo, StagedEntry } from "../select.ts";

const packages: PackageInfo[] = [
  { dir: "agent", name: "@hns/agent", dependsOn: ["@hns/core", "@hns/workspace"] },
  { dir: "core", name: "@hns/core", dependsOn: [] },
  { dir: "store", name: "@hns/store", dependsOn: ["@hns/core"] },
  { dir: "web", name: "@hns/web", dependsOn: ["@hns/core"] },
  { dir: "workspace", name: "@hns/workspace", dependsOn: ["@hns/core"] },
];

const staged = (path: string, status = "M", previousPath?: string): StagedEntry =>
  previousPath === undefined ? { status, path } : { status, path, previousPath };

const names = (selection: ReturnType<typeof select>): string[] =>
  selection.packages.map((pkg) => pkg.name).sort();

// Catches: a docs-only commit paying for the whole suite again.
test("docs and work changes select no package", () => {
  const selection = select([staged("docs/testing.md"), staged("work/BOARD.md")], packages);
  assert.deepEqual(selection.packages, []);
  assert.equal(selection.ignored.length, 2);
});

// Catches: a web-only change running core and workspace tests.
test("a package change selects that package and nothing else", () => {
  const selection = select([staged("packages/web/src/app/Shell.tsx")], packages);
  assert.deepEqual(names(selection), ["@hns/web"]);
});

// Catches: changing core without re-checking the packages that import it.
test("a core change selects every dependent package", () => {
  const selection = select([staged("packages/core/src/types.ts")], packages);
  assert.deepEqual(names(selection), [
    "@hns/agent",
    "@hns/core",
    "@hns/store",
    "@hns/web",
    "@hns/workspace",
  ]);
});

// Catches: a lockfile bump silently skipping packages that may need a rebuild.
test("a root trigger forces every package", () => {
  const selection = select([staged("package-lock.json")], packages);
  assert.equal(selection.forcedAll, true);
  assert.equal(selection.packages.length, packages.length);
});

// Catches: editing the gate itself without re-checking the repository.
test("a change under tools forces every package", () => {
  const selection = select([staged("tools/gate/main.ts")], packages);
  assert.equal(selection.forcedAll, true);
});

// Catches: editing the hook wiring without running the gate on that commit.
test("a change to the hook config forces every package", () => {
  const selection = select([staged(".pre-commit-config.yaml")], packages);
  assert.equal(selection.forcedAll, true);
});

// Catches: a deletion being dropped from the check set by --diff-filter=ACMR.
test("deleted files still select their package", () => {
  const selection = select([staged("packages/store/src/rows.ts", "D")], packages);
  assert.deepEqual(names(selection), ["@hns/store"]);
});

// Catches: a same-package rename selecting nothing.
test("a rename selects the new path's package", () => {
  const selection = select([staged("packages/web/src/app/New.tsx", "R")], packages);
  assert.deepEqual(names(selection), ["@hns/web"]);
});

// Catches: moving a file out of a package skipping that package's tests and typecheck.
test("a rename out of a package still selects the package that lost the file", () => {
  const selection = select([staged("work/rows.ts", "R", "packages/store/src/rows.ts")], packages);
  assert.deepEqual(names(selection), ["@hns/store"]);
});

// Catches: a cross-package move checking only the destination.
test("a cross-package rename selects both packages", () => {
  const selection = select(
    [staged("packages/web/src/rows.ts", "R", "packages/store/src/rows.ts")],
    packages,
  );
  assert.deepEqual(names(selection), ["@hns/store", "@hns/web"]);
});

// Catches: a package README escaping oxfmt because of a blanket *.md ignore.
test("package markdown selects its package", () => {
  const selection = select([staged("packages/store/README.md")], packages);
  assert.deepEqual(names(selection), ["@hns/store"]);
});

// Catches: a future apps/ workspace being silently skipped.
test("an unmodelled workspace root forces every package", () => {
  const selection = select([staged("apps/web/src/main.tsx")], packages);
  assert.equal(selection.forcedAll, true);
});

// Catches: a new workspace under packages/ being skipped because it is unknown.
test("an unknown package forces every package", () => {
  const selection = select([staged("packages/server/src/app.ts")], packages);
  assert.equal(selection.forcedAll, true);
  assert.deepEqual(selection.unknown, ["packages/server/src/app.ts"]);
});

// Catches: build running before the packages it consumes are rebuilt.
test("dependencies come before dependents", () => {
  const ordered = orderByDependency(packages).map((pkg) => pkg.dir);
  assert.ok(ordered.indexOf("core") < ordered.indexOf("workspace"));
  assert.ok(ordered.indexOf("workspace") < ordered.indexOf("agent"));
});
