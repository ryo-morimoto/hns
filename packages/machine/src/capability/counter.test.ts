import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { GrantCounter } from "./counter.ts";

/**
 * The grant counter: the machine's spend of one grant, kept on disk (C6–C7).
 *
 * @remarks
 * Every case runs against a real temporary directory, because what is being proved is the file:
 * that a spend survives a restart, that two spends at once cannot both read the same remainder,
 * that a refused spend writes nothing, and that a state file that cannot be read or parsed is a
 * refusal rather than a fresh budget. The two-process case starts a second Node process over the
 * same layout, so "the count is on disk" is measured from outside this process.
 */

const run = promisify(execFile);

/** One grant id, as the issuer makes them (0224: `crypto.randomUUID()`). */
const GRANT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** The clock every spend is judged at. */
const NOW = Date.parse("2026-01-01T00:01:00.000Z");

let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "hns-grant-counter-"));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** A fresh state directory under the temporary base. */
async function stateDirectory(name: string): Promise<string> {
  const directory = join(base, name, "grants");
  await mkdir(directory, { recursive: true });
  return directory;
}

/** One spend of one call: the whole budget unless a case narrows it. */
function consumeOf(
  overrides: {
    readonly grantId?: string;
    readonly maxCalls?: number;
    readonly maxBytes?: number;
    readonly bytes?: number;
    readonly now?: number;
  } = {},
) {
  return {
    grantId: overrides.grantId ?? GRANT_ID,
    maxCalls: overrides.maxCalls ?? 10,
    maxBytes: overrides.maxBytes ?? 4096,
    bytes: overrides.bytes ?? 100,
    now: overrides.now ?? NOW,
  };
}

/** The child environment: GIT_* is dropped because no fixture here may inherit a repository. */
function fixtureEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  return env;
}
// C6: the budget is the grant's, and the last call is the last one.
test("C6: maxCalls=1 allows one consume and refuses the second as counter_exhausted", async () => {
  const counter = new GrantCounter(await stateDirectory("calls"));
  const first = await counter.consume(consumeOf({ maxCalls: 1 }));
  expect(first.outcome).toBe("allow");
  if (first.outcome !== "allow") return;
  expect(first.spend.calls).toBe(1);
  const second = await counter.consume(consumeOf({ maxCalls: 1 }));
  expect(second).toMatchObject({ outcome: "deny", decision: { code: "counter_exhausted" } });
});

// C6: a grant that has spent everything cannot spend again however many times it is offered.
test("C6: a grant that has spent its budget stays exhausted", async () => {
  const counter = new GrantCounter(await stateDirectory("stays-exhausted"));
  for (let call = 1; call <= 3; call += 1) {
    expect((await counter.consume(consumeOf({ maxCalls: 3 }))).outcome).toBe("allow");
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(await counter.consume(consumeOf({ maxCalls: 3 }))).toMatchObject({
      outcome: "deny",
      decision: { code: "counter_exhausted" },
    });
  }
  expect(await counter.read(GRANT_ID)).toMatchObject({ calls: 3 });
});

// The bytes are the other half of the budget: output a call may return is spent too.
test("a spend past maxBytes is counter_exhausted, and nothing is written", async () => {
  const counter = new GrantCounter(await stateDirectory("bytes"));
  expect((await counter.consume(consumeOf({ maxBytes: 250 }))).outcome).toBe("allow");
  const over = await counter.consume(consumeOf({ maxBytes: 250, bytes: 200 }));
  expect(over).toMatchObject({ outcome: "deny", decision: { code: "counter_exhausted" } });
  // The refused spend did not count: 100 + 150 still fits 250.
  expect(await counter.consume(consumeOf({ maxBytes: 250, bytes: 150 }))).toMatchObject({
    outcome: "allow",
    spend: { bytes: 250 },
  });
  expect(await counter.read(GRANT_ID)).toMatchObject({ calls: 2, bytes: 250 });
});

// Restart: the count is the file's, not this process's.
test("C6: the count survives a restart and a new counter instance", async () => {
  const directory = await stateDirectory("restart");
  const first = new GrantCounter(directory);
  expect((await first.consume(consumeOf({ maxCalls: 2 }))).outcome).toBe("allow");
  // A new instance over the same directory is what a restarted agent has: no memory of the spend.
  const restarted = new GrantCounter(directory);
  expect((await restarted.consume(consumeOf({ maxCalls: 2 }))).outcome).toBe("allow");
  expect(await restarted.consume(consumeOf({ maxCalls: 2 }))).toMatchObject({
    outcome: "deny",
    decision: { code: "counter_exhausted" },
  });
  // And the state names its grant and the time it was last spent.
  expect(JSON.parse(await readFile(join(directory, GRANT_ID + ".json"), "utf8"))).toStrictEqual({
    v: 1,
    grantId: GRANT_ID,
    calls: 2,
    bytes: 200,
    openedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  });
});

// Concurrency: two spends of one grant at the same instant cannot both read the same remainder.
test("C6: concurrent consumes of one grant never overspend it", async () => {
  const counter = new GrantCounter(await stateDirectory("concurrent"));
  const results = await Promise.all(
    Array.from({ length: 16 }, async () => await counter.consume(consumeOf({ maxCalls: 5 }))),
  );
  const allowed = results.filter((result) => result.outcome === "allow").length;
  const refused = results.filter(
    (result) => result.outcome === "deny" && result.decision.code === "counter_exhausted",
  ).length;
  expect(allowed).toBe(5);
  expect(refused).toBe(11);
  expect(await counter.read(GRANT_ID)).toMatchObject({ calls: 5 });
});
// Two processes over one state file: the second process starts from what the first wrote.
test("C6: two processes spend one grant from the same file", async () => {
  const directory = await stateDirectory("processes");
  const counterUrl = new URL("./counter.ts", import.meta.url).href;
  const script = [
    "import { GrantCounter } from " + JSON.stringify(counterUrl) + ";",
    "const counter = new GrantCounter(process.argv[1]);",
    "const result = await counter.consume({ grantId: " + JSON.stringify(GRANT_ID) + ",",
    "  maxCalls: 1, maxBytes: 4096, bytes: 10, now: " + String(NOW) + " });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const child = async () =>
    await run(
      process.execPath,
      ["--conditions=source", "--input-type=module", "-e", script, directory],
      {
        env: fixtureEnv(),
      },
    );
  expect(JSON.parse((await child()).stdout)).toMatchObject({ outcome: "allow" });
  // The same grant, a second process, its own fresh GrantCounter: the budget is already spent.
  expect(JSON.parse((await child()).stdout)).toMatchObject({
    outcome: "deny",
    decision: { code: "counter_exhausted" },
  });
});

// C7: a state file that is not this contract's shape is a refusal, not a fresh budget.
test("C7: a corrupt state file denies instead of resetting the budget", async () => {
  const cases = [
    ["not-json", "{not json"],
    ["wrong-shape", JSON.stringify({ v: 1, grantId: GRANT_ID })],
    [
      "another-grant",
      JSON.stringify({ v: 1, grantId: "other", calls: 0, bytes: 0, openedAt: "t", updatedAt: "t" }),
    ],
    [
      "negative",
      JSON.stringify({
        v: 1,
        grantId: GRANT_ID,
        calls: -1,
        bytes: 0,
        openedAt: "t",
        updatedAt: "t",
      }),
    ],
  ] as const;
  for (const [name, body] of cases) {
    const directory = await stateDirectory("corrupt-" + name);
    await writeFile(join(directory, GRANT_ID + ".json"), body, { mode: 0o600 });
    const counter = new GrantCounter(directory);
    expect(await counter.consume(consumeOf()), name).toMatchObject({
      outcome: "deny",
      decision: { code: "unsupported" },
    });
    // Nothing was written over the corrupt file: the refusal did not "fix" it.
    expect(await readFile(join(directory, GRANT_ID + ".json"), "utf8")).toBe(body);
  }
});

// C7: a directory that cannot be written is a refused spend, not a spend.
test("C7: a state directory that cannot be written denies the call", async () => {
  const directory = await stateDirectory("unwritable");
  await chmod(directory, 0o500);
  try {
    const counter = new GrantCounter(directory);
    const result = await counter.consume(consumeOf());
    expect(result).toMatchObject({ outcome: "deny", decision: { code: "counter_exhausted" } });
  } finally {
    await chmod(directory, 0o700);
  }
});

// C7: a state file that cannot be read is a refused spend.
test("C7: a state file that cannot be read denies the call", async () => {
  const directory = await stateDirectory("unreadable");
  const counter = new GrantCounter(directory);
  expect((await counter.consume(consumeOf())).outcome).toBe("allow");
  await chmod(join(directory, GRANT_ID + ".json"), 0o000);
  try {
    // The file cannot be read, so the remainder is unknown: fail closed.
    expect(await counter.consume(consumeOf())).toMatchObject({
      outcome: "deny",
      decision: { code: "unsupported" },
    });
  } finally {
    await chmod(join(directory, GRANT_ID + ".json"), 0o600);
  }
});

// The state is the machine's alone: the directory is 0700 and every file 0600.
test("the state directory and its files are the operator's alone", async () => {
  const root = join(base, "modes");
  await mkdir(root, { recursive: true });
  const directory = join(root, "grants");
  const counter = new GrantCounter(directory);
  expect((await counter.consume(consumeOf())).outcome).toBe("allow");
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, GRANT_ID + ".json"))).mode & 0o777).toBe(0o600);
  // A spend leaves no temp file behind.
  expect(await readdir(directory)).toStrictEqual([GRANT_ID + ".json"]);
});

// A grant id that would escape the directory is refused before it names a file.
test("a grant id that is not a file id is refused", async () => {
  const directory = await stateDirectory("bad-id");
  const counter = new GrantCounter(directory);
  for (const grantId of ["../escape", "a/b", ".hidden", "with space", ""]) {
    expect(await counter.consume(consumeOf({ grantId })), grantId).toMatchObject({
      outcome: "deny",
      decision: { code: "grant_invalid" },
    });
  }
  expect(await readdir(directory)).toStrictEqual([]);
});
