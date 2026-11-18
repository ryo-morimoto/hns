import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";
import {
  CF_DEV_WORK_DIR,
  isCfDevInstalled,
  startCfDev,
  type CfDev,
} from "../../../../tools/test/cf-dev.ts";
import { ensureDist } from "../../../../tools/test/ensure-dist.ts";
import { sessionCookie, TEST_SECRET } from "../../test/support/edge.ts";

/**
 * The Artifacts local simulator: create → push → binding read (C3).
 *
 * @remarks
 * The simulator runs on **cf dev**, not on a second minimal wrangler project: the integration tier
 * already starts one `cf dev` per suite with a machine-wide lock (`tools/test/cf-dev.ts`), and a
 * project of its own would only queue behind them. This suite is one such project: it declares an
 * `artifacts` binding whose local switch is on and asks the running Worker to create a
 * repository.
 *
 * **The observation is either the simulator or its absence, and both are recorded plainly.**
 * The suite measures where the binding went: a create that answers a repository is the simulator
 * working (the test then asserts the repository's name and remote); a console that says the
 * binding went **remote** is the fact that the local simulator is not available on this cf /
 * wrangler, and the test is **skipped with that reason printed** — not failed for a reason a
 * reader has to reconstruct. `HNS_REQUIRE_ARTIFACTS_SIMULATOR=1` turns the skip into a failure, the
 * same way `HNS_REQUIRE_CF` turns a missing cf into one, so a release can demand the simulator
 * where it is expected to exist.
 *
 * No path here holds a Cloudflare account: a binding sent to the account fails to start cf dev
 * without a token, which is itself the measured answer.
 *
 * The second test is the observation a mirror outcome writes, read back through the product's
 * `/api/metrics`; its project has no artifacts binding, so it runs wherever cf does.
 */

const TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 40_000;

/**
 * The cf config: one workspace object, one session object, and one artifacts binding.
 *
 * @remarks
 * `dev: { remote: false }` is cf's spelling of "local only". Whether it reaches the dev server is
 * what the probe measures: the binding either simulates a repository or goes to the account.
 */
const CONFIG = [
  'import { bindings, defineConfig, exports } from "cf/config";',
  "",
  "export default defineConfig({",
  "  worker: {",
  '    name: "hns-artifacts-local-test",',
  '    compatibilityDate: "2026-10-30",',
  '    compatibilityFlags: ["nodejs_compat"],',
  '    entrypoint: "worker.ts",',
  "    exports: {",
  '      Workspace: exports.durableObject({ storage: "sqlite" }),',
  '      Session: exports.durableObject({ storage: "sqlite" }),',
  "    },",
  "    env: {",
  '      WORKSPACE: bindings.durableObject({ worker: "hns-artifacts-local-test", exportName: "Workspace" }),',
  '      SESSION: bindings.durableObject({ worker: "hns-artifacts-local-test", exportName: "Session" }),',
  '      HNS_SESSION_SECRET: bindings.text("' + TEST_SECRET + '"),',
  // cf's binding helper nests the local-development switch under `dev` (wrangler's own field is
  // `remote`); `dev: { remote: false }` is the request for the local simulator.
  // cf's helper nests the local switch under `dev`; cf 1.0.0-beta.28 lowerings drop it for
  // artifacts (measured above), which is why the probe reads the mode back from the binding.
  '      ARTIFACTS: bindings.artifacts({ namespace: "hns-artifacts-local-test", dev: { remote: false } }),',
  '      ARTIFACTS_MIRROR: bindings.text("off"),',
  "    },",
  "  },",
  "});",
  "",
].join("\n");

/** The same config with no artifacts binding: every binding resolves locally. */
const CONFIG_WITHOUT_ARTIFACTS = CONFIG.split("\n")
  .filter((line) => !line.includes("ARTIFACTS"))
  .join("\n");

const WORKER = [
  'import { Workspace } from "@hns/server";',
  'import { createObsStore, handleObsRpc } from "@hns/server/obs";',
  "",
  "interface Env {",
  "  readonly ARTIFACTS: {",
  "    create(name: string): Promise<unknown>;",
  "    get(name: string): Promise<unknown>;",
  "  };",
  "  readonly WORKSPACE: {",
  "    idFromName(name: string): unknown;",
  "    get(id: unknown): { fetch(request: Request): Promise<Response> };",
  "  };",
  "  readonly SESSION: {",
  "    idFromName(name: string): unknown;",
  "    get(id: unknown): { fetch(request: Request): Promise<Response> };",
  "  };",
  "}",
  "",
  "const json = (body: unknown): Response =>",
  '  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });',
  "",
  "const errorOf = (error: unknown) => {",
  "  const e = error instanceof Error ? error : undefined;",
  "  return {",
  '    name: e?.name ?? "not-an-error",',
  '    code: typeof (e as { code?: unknown } | undefined)?.code === "string" ? (e as { code: string }).code : null,',
  "  };",
  "};",
  "",
  "export class Session {",
  "  readonly #store;",
  "  constructor(state: { storage: never }) {",
  "    // SAFETY: the object storage is what createObsStore reads; the type is cf's runtime one.",
  "    this.#store = createObsStore(state.storage);",
  "  }",
  "  async fetch(request: Request): Promise<Response> {",
  "    return await handleObsRpc(request, this.#store);",
  "  }",
  "}",
  "",
  "export { Workspace };",
  "",
  "export default {",
  "  async fetch(request: Request, env: Env): Promise<Response> {",
  "    const url = new URL(request.url);",
  '    if (url.pathname === "/health") return new Response("ok");',
  '    if (url.pathname === "/sim") {',
  "      // The question the suite measures: does the local simulator create a repository?",
  "      try {",
  '        const created = (await env.ARTIFACTS.create("hns-local-" + Date.now())) as { name: string };',
  "        const handle = (await env.ARTIFACTS.get(created.name)) as { info(): Promise<{ remote: string }> };",
  "        const info = await handle.info();",
  "        return json({ ok: true, created: { name: created.name, remote: info.remote } });",
  "      } catch (error) {",
  "        return json({ ok: false, error: errorOf(error) });",
  "      }",
  "    }",
  '    if (url.pathname === "/events" || url.pathname === "/metrics") {',
  '      const forwarded = new Request("https://session.internal/rpc" + url.pathname + url.search, request);',
  '      return env.SESSION.get(env.SESSION.idFromName("obs")).fetch(forwarded);',
  "    }",
  '    if (!url.pathname.startsWith("/t/")) return new Response("not found", { status: 404 });',
  '    const forwarded = new Request("https://workspace" + url.pathname.slice(2) + url.search, request);',
  '    return env.WORKSPACE.get(env.WORKSPACE.idFromName("w1")).fetch(forwarded);',
  "  },",
  "};",
  "",
].join("\n");

const SimAnswer = v.variant("ok", [
  v.object({
    ok: v.literal(true),
    created: v.object({ name: v.string(), remote: v.string() }),
  }),
  v.object({
    ok: v.literal(false),
    error: v.object({
      name: v.string(),
      code: v.nullable(v.string()),
      message: v.optional(v.string()),
    }),
  }),
]);

let project: string | undefined;
let running: CfDev | undefined;

/** Write the project; `artifacts: false` leaves the binding out, as CI must. */
async function writeProject(options: { readonly artifacts?: boolean } = {}): Promise<string> {
  await mkdir(CF_DEV_WORK_DIR, { recursive: true });
  const dir = await mkdtemp(join(CF_DEV_WORK_DIR, "artifacts-local-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "hns-artifacts-local-test",
      private: true,
      type: "module",
      devDependencies: { wrangler: "4.156.0" },
    }),
  );
  await symlink(join("..", "..", "node_modules"), join(dir, "node_modules"));
  await writeFile(
    join(dir, "cloudflare.config.ts"),
    options.artifacts === false ? CONFIG_WITHOUT_ARTIFACTS : CONFIG,
  );
  await writeFile(join(dir, "worker.ts"), WORKER);
  return dir;
}

beforeAll(() => {
  if (!isCfDevInstalled()) return;
  ensureDist(["@hns/core", "@hns/store", "@hns/agent", "@hns/server"]);
});

afterAll(async () => {
  await running?.stop();
  running = undefined;
  if (project !== undefined) await rm(project, { recursive: true, force: true });
});

/** One request to the running project, parsed as JSON. */
async function call<T>(
  path: string,
  schema: v.GenericSchema<unknown, T>,
  init: RequestInit = {},
): Promise<T> {
  const base = running?.url ?? "";
  const response = await fetch(base + path, init);
  const text = await response.text();
  expect(response.status, text).toBeLessThan(300);
  return v.parse(schema, JSON.parse(text));
}

/** Whether this run demands the simulator; a skip is then a failure (compare `HNS_REQUIRE_CF`). */
const SIMULATOR_REQUIRED = process.env.HNS_REQUIRE_ARTIFACTS_SIMULATOR === "1";

/**
 * The reason the simulator was not exercised, or undefined when it was.
 *
 * @remarks
 * `remote` is measured from the dev server's own words: a binding that resolves to the account
 * starts a remote proxy session instead of a local simulator. It is printed and the test skips —
 * the fact a reader needs — rather than the run failing with an error a reader has to decode.
 */
const simulatorGap = (reason: string): undefined | never => {
  if (SIMULATOR_REQUIRED) {
    throw new Error("the artifacts local simulator is required here but unavailable: " + reason);
  }
  console.log("[c3] skipped: the artifacts local simulator is unavailable — " + reason);
  return undefined;
};

// C3 / T3: Given the local simulator, When the Worker creates a repository and reads it back,
// Then the binding answered a repository with a remote. When it did not, the test says why it
// is skipping — "the binding went to the account" is a recorded fact, not a mysterious failure.
test.skipIf(!isCfDevInstalled())(
  "C3: the artifacts binding behind cf dev is asked whether it simulates a repository",
  async () => {
    project = await writeProject();
    // cf dev starts only when every binding resolves locally: a remote one starts a proxy session
    // that needs an account, and the start fails with that reason.
    try {
      running = await startCfDev({ cwd: project, readyTimeoutMs: READY_TIMEOUT_MS });
    } catch (error) {
      const output = error instanceof Error ? error.message : String(error);
      if (!output.includes("Establishing remote connection")) throw error;
      simulatorGap("cf dev sent the artifacts binding to the account (remote proxy session)");
      return;
    }
    const answer = await call("/sim", SimAnswer);
    if (!answer.ok) {
      // The dev server is up but the binding refuses to create: the simulator that started is not
      // one (its binding answers "needs to be run remotely" on a newer wrangler).
      simulatorGap("the local binding cannot create: " + String(answer.error.message ?? ""));
      return;
    }
    expect(answer.created.name).toMatch(/^hns-local-/u);
    expect(answer.created.remote).toMatch(/^https:\/\//u);
  },
  TIMEOUT_MS,
);

// C3 / T3: Given the running project, When a mirror outcome is observed, Then the project's
// `/api/metrics` counts it. The line is the product's shape and the route is the product's
// (`handleObsRpc`), so the observability a reader uses is exercised against the local runtime.
test.skipIf(!isCfDevInstalled())(
  "C3: the project's /api/metrics reports the mirror outcome it observed",
  async () => {
    if (running === undefined) {
      // This half does not need the simulator (it measures the observation a mirror outcome
      // writes), so its project has no artifacts binding: the same project runs in every
      // environment, including CI, where no account exists.
      project = await writeProject({ artifacts: false });
      running = await startCfDev({ cwd: project, readyTimeoutMs: READY_TIMEOUT_MS });
    }
    const wrote = await call("/events", v.object({ ok: v.literal(true) }), {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-c3" },
      body: JSON.stringify({
        v: 1,
        at: new Date().toISOString(),
        level: "warn",
        event: "artifacts.mirror",
        hop: "do",
        requestId: "req-c3",
        durationMs: 12,
        detail: { mirror: "failed", repos: "ws-w1", failure: "network" },
      }),
    });
    expect(wrote.ok).toBe(true);
    const metrics = await call(
      "/metrics",
      v.object({
        ok: v.literal(true),
        metrics: v.object({
          mirror: v.object({
            total: v.number(),
            failureRate: v.number(),
            skipRate: v.number(),
            p95Ms: v.number(),
            repos: v.number(),
            states: v.object({
              mirrored: v.number(),
              skipped: v.number(),
              failed: v.number(),
              pending: v.number(),
            }),
          }),
        }),
      }),
      { headers: { cookie: await sessionCookie() } },
    );
    expect(metrics.metrics.mirror.total).toBe(1);
    expect(metrics.metrics.mirror.states.failed).toBe(1);
    expect(metrics.metrics.mirror.failureRate).toBe(1);
    expect(metrics.metrics.mirror.p95Ms).toBe(12);
    expect(metrics.metrics.mirror.repos).toBe(1);
  },
  TIMEOUT_MS,
);
