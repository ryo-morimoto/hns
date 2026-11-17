import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  ensureDist,
  inspectDist,
  judgeLock,
  parseLock,
  parseManifest,
  withBuildQueue,
  type LockSnapshot,
} from "./ensure-dist.ts";

const directories: string[] = [];

/** A fresh temporary directory this test may fill, removed after it. */
function fixtureRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "hns-ensure-dist-lock-"));
  directories.push(directory);
  return directory;
}

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

// Catches: a directory named like the exports file counting as built, so the suite imports a
// directory and fails on the first request.
test("an export that names a directory is missing", () => {
  const directory = pack();
  rmSync(join(directory, "dist", "index.js"));
  mkdirSync(join(directory, "dist", "index.js"));
  expect(inspectDist(directory)).toBe("missing");
});

// Catches: an export that names a file outside the package being built and found, so the dist/ the
// build would write is never the file the suite bundles.
test("an export that points outside the package is refused", () => {
  const directory = pack();
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ exports: { ".": { import: "../../elsewhere/index.js" } } }),
  );
  expect(() => inspectDist(directory)).toThrow(/outside the package/u);
});

test("a lock record round-trips, and a torn one parses to null", () => {
  const record = { pid: 42, at: 1_700_000_000_000, token: "a-token" };
  expect(parseLock(JSON.stringify(record))).toStrictEqual(record);
  expect(parseLock('{"pid":')).toBeNull();
  expect(parseLock(JSON.stringify({ pid: 0, at: 1, token: "" }))).toBeNull();
});

/** The lock as it sits on disk, for a test that needs the snapshot withBuildQueue would read. */
function snapshotOf(path: string): LockSnapshot {
  const record = parseLock(readFileSync(join(path, "owner.json"), "utf8"));
  return record === null ? { state: "unreadable", ageMs: 0 } : { state: "held", record, ageMs: 0 };
}

function readLockToken(path: string): string | undefined {
  const snapshot = snapshotOf(path);
  return snapshot.state === "held" ? snapshot.record.token : undefined;
}

const held: LockSnapshot = {
  state: "held",
  record: { pid: 42, at: 0, token: "a-token" },
  ageMs: 0,
};

// Catches: a lock whose owner died blocking every later suite until its age ran out. The owner is
// checked first, so a killed worker's lock frees the queue at once.
test("a lock whose owner is gone is abandoned at any age", () => {
  expect(judgeLock(held, false)).toBe("abandoned");
});

// Catches: a live builder losing its lock, so two suites build the same package at once.
test("a young lock whose owner lives is held", () => {
  expect(judgeLock(held, true)).toBe("held");
});

// Catches: a lock that outlived every build keeping a suite waiting forever.
test("a lock older than two builds is abandoned even when its pid is recycled", () => {
  expect(judgeLock({ ...held, ageMs: 2 * 120_000 }, true)).toBe("abandoned");
});

test("an absent lock is free, and a torn one is held only while its writer runs", () => {
  expect(judgeLock({ state: "absent" }, false)).toBe("free");
  expect(judgeLock({ state: "unreadable", ageMs: 100 }, true)).toBe("held");
  expect(judgeLock({ state: "unreadable", ageMs: 5_000 }, true)).toBe("abandoned");
});

// Catches: an orphan lock left by SIGKILL or a cancelled gate stalling every later suite. A
// worker that dies between its mkdir and its release leaves the directory behind; ensureDist must
// take it over at once because the pid is gone, not wait out the lock's ceiling.
test("an orphan lock does not stall the next build queue", () => {
  const lock = join(fixtureRoot(), "build.lock");
  mkdirSync(lock, { recursive: true });
  // A pid that cannot be alive: the maximum Linux pid is 4194304.
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: 4_194_305, at: Date.now(), token: "orphan" }),
  );
  const started = Date.now();
  const result = withBuildQueue(lock, () => "ran");
  // Taken over at once because the owner is dead, and released, so nothing is left behind.
  expect(result).toBe("ran");
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(existsSync(lock)).toBe(false);
});

// Catches: a lock whose record never landed, or an older shape, blocking forever. The writer needs
// milliseconds, so an unreadable record is taken over once it is older than that.
test("an old unreadable lock is taken over", () => {
  const lock = join(fixtureRoot(), "build.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), "{");
  const started = Date.now();
  expect(withBuildQueue(lock, () => "ran")).toBe("ran");
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(existsSync(lock)).toBe(false);
});

// Catches: two suites building the same package at once, which is the race objects.test.ts
// warned about. A waiter must not take a young lock whose owner is alive: another process, which
// is what a sibling worker is, may hold it while it builds.
test("a young lock whose live owner holds it is not taken", () => {
  const lock = join(fixtureRoot(), "build.lock");
  const marker = join(fixtureRoot(), "ran");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({ pid: holder.pid, at: Date.now(), token: "holder" }),
    );
    // judgeLock is what withBuildQueue consults; a live owner is "held", never "abandoned".
    expect(judgeLock(snapshotOf(lock), true)).toBe("held");
    expect(readLockToken(lock)).toBe("holder");
  } finally {
    holder.kill("SIGKILL");
  }
  expect(existsSync(marker)).toBe(false);
});
