import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ensureDist, inspectDist, parseManifest } from "./ensure-dist.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

/** A package directory whose export names ./dist/index.js. */
function pack(): string {
  const directory = mkdtempSync(join(tmpdir(), "hns-ensure-dist-"));
  directories.push(directory);
  mkdirSync(join(directory, "src"));
  mkdirSync(join(directory, "dist"));
  for (const name of ["package.json", "tsdown.config.ts", "tsconfig.build.json"]) {
    writeFileSync(join(directory, name), "{}");
  }
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ exports: { ".": { import: "./dist/index.js" } } }),
  );
  writeFileSync(join(directory, "src", "index.ts"), "");
  writeFileSync(join(directory, "dist", "index.js"), "");
  // Every build input an hour old, so only the files a test ages decide the comparison.
  for (const name of ["package.json", "tsdown.config.ts", "tsconfig.build.json"]) {
    age(join(directory, name), 3600);
  }
  age(join(directory, "src", "index.ts"), 3600);
  return directory;
}

/** One clock reading for every fixture, so two aged files never land on the same millisecond. */
const NOW = Date.now();

/** Move a file's mtime back by seconds, so the comparison under test decides the outcome. */
function age(path: string, secondsAgo: number): void {
  utimesSync(path, (NOW - secondsAgo * 1000) / 1000, (NOW - secondsAgo * 1000) / 1000);
}

test("each export keeps the dist file its import path names", () => {
  const text = JSON.stringify({
    name: "@hns/example",
    exports: {
      ".": { source: "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./objects": {
        source: "./src/objects.ts",
        types: "./dist/objects.d.ts",
        import: "./dist/objects.js",
      },
    },
  });
  expect(parseManifest("package.json", text)).toStrictEqual({
    exports: {
      ".": { import: "./dist/index.js" },
      "./objects": { import: "./dist/objects.js" },
    },
  });
});

// Catches: an export with no import path counting as built, so a suite bundles a dist/ that was
// never produced and fails on the first request instead of building.
test("an export with no import path is refused", () => {
  const text = JSON.stringify({ exports: { ".": { source: "./src/index.ts" } } });
  expect(() => parseManifest("packages/x/package.json", text)).toThrow(
    /packages\/x\/package\.json/u,
  );
});

test("a manifest with no exports map is refused", () => {
  expect(() => parseManifest("package.json", JSON.stringify({ name: "@hns/example" }))).toThrow(
    /expected an exports map/u,
  );
});

test("a dist newer than every source is current", () => {
  const directory = pack();
  age(join(directory, "dist", "index.js"), 1800);
  expect(inspectDist(directory)).toBe("current");
});

// Catches: a stale dist/ counting as current, so a standalone run after a source edit bundles
// the previous output.
test("a source newer than its dist is stale", () => {
  const directory = pack();
  age(join(directory, "dist", "index.js"), 7200);
  expect(inspectDist(directory)).toBe("stale");
});

test("a unit test newer than dist does not make it stale, because the build leaves it out", () => {
  const directory = pack();
  age(join(directory, "dist", "index.js"), 1800);
  writeFileSync(join(directory, "src", "index.test.ts"), "");
  expect(inspectDist(directory)).toBe("current");
});

// Catches: a removed dist/ counting as current, so the suite runs against no package at all.
test("an export with no dist file is missing", () => {
  const directory = pack();
  rmSync(join(directory, "dist", "index.js"));
  expect(inspectDist(directory)).toBe("missing");
});

// Catches: a fresh checkout, where src/ exists but dist/ does not, being read as a broken package
// instead of one to build.
test("a directory with no dist is unbuilt", () => {
  const directory = pack();
  rmSync(join(directory, "dist"), { recursive: true });
  expect(inspectDist(directory)).toBe("unbuilt");
});

// Catches: a missing src/ being taken for unbuilt, which would hide a package that lost its code.
test("a package with no src is refused", () => {
  const directory = pack();
  rmSync(join(directory, "src"), { recursive: true });
  expect(() => inspectDist(directory)).toThrow(/src/u);
});

// Catches: ensureDist calling the build for nothing. The per-package check and the lock are what
// keep the in-test build count at zero during a check, which builds every package first.
test("nothing is built when the list asks for no package", () => {
  const built: string[] = [];
  expect(ensureDist([], (name) => built.push(name))).toStrictEqual([]);
  expect(built).toStrictEqual([]);
});

test("a package name without the scope is refused", () => {
  expect(() => ensureDist(["core"])).toThrow(/expected a workspace package name/u);
});

// Catches: a name that walks out of packages/ reaching the build or the filesystem.
test("a name that is not a workspace package is refused", () => {
  expect(() => ensureDist(["../../etc"])).toThrow(/expected a workspace package name/u);
  expect(() => ensureDist(["@hns/missing-package"])).toThrow(/no package\.json/u);
});
