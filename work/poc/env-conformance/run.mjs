// T-01: run Pi Durable's ExecutionEnv conformance suite against an environment.
// Usage: node run.mjs [node|local]
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const target = process.argv[2] ?? "node";

const assertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
  deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
  partialDeepEqual: (actual, expected) => assert.partialDeepStrictEqual(actual, expected),
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
  rejects: (operation, messageIncludes) =>
    assert.rejects(operation, (error) => String(error?.message ?? error).includes(messageIncludes)),
};

async function makeEnv(dir) {
  if (target === "local") {
    const { LocalExecutionEnv, Connection, localDaemon } = await import("@earendil-works/pi-env");
    const connection = new Connection({ command: [localDaemon()] });
    return { env: new LocalExecutionEnv({ cwd: dir, connection }), close: () => connection.close() };
  }
  return { env: new NodeExecutionEnv({ cwd: dir }), close: async () => {} };
}

const cases = createEnvConformance({
  assertions,
  listFiles: true,
  withEnv: async (use) => {
    const dir = await mkdtemp(join(tmpdir(), "hns-env-"));
    const { env, close } = await makeEnv(dir);
    try {
      await use(env);
    } finally {
      await env.cleanup?.();
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  },
});

const results = [];
for (const testCase of cases) {
  const started = performance.now();
  let status = "passed";
  let error;
  try {
    const run = testCase.run();
    const timeout = testCase.timeoutMs ?? 60_000;
    await Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeout}ms`)), timeout)),
    ]);
  } catch (e) {
    status = "failed";
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  results.push({ name: testCase.name, status, ms: Math.round(performance.now() - started), error });
  console.log(`${status === "passed" ? "PASS" : "FAIL"} ${testCase.name}${error ? ` — ${error}` : ""}`);
}

const failed = results.filter((r) => r.status === "failed");
console.log(`\n${results.length - failed.length}/${results.length} passed (target=${target})`);
await writeFile("results.json", JSON.stringify({ target, node: process.version, piVersion: "1.5.0", results }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
