// T-03 / T-04: conflicts, crash points, reconciliation, idempotent replay.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Workspace, Crash } from "./workspace.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
  if (ok) { pass++; console.log("PASS", name); }
  else { fail++; console.log("FAIL", name, detail ?? ""); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function makeTarget(kind) {
  const base = await mkdtemp(join(tmpdir(), "hns-ws-"));
  const root = join(base, "root");
  let env, close = async () => {};
  if (kind === "node") {
    env = new NodeExecutionEnv({ cwd: base });
    await env.createDir("root", undefined, ctx);
  } else {
    const connection = new Connection({ command: [localDaemon()] });
    env = new LocalExecutionEnv({ cwd: base, connection });
    close = () => connection.close();
    await env.createDir("root", undefined, ctx);
  }
  const open = (crashAt) => new Workspace({ env, root, journalPath: join(base, "journal.json"), context: ctx, crashAt }).open();
  return { base, root, env, open, close };
}

async function scenario(kind) {
  const t = await makeTarget(kind);
  const ws = await t.open();

  // T-03: two clients from the same version.
  check((await ws.write({ path: "a.txt", content: "v1", expectedVersion: "absent", operationId: "w0" })).status === "applied", `${kind} create`);
  const v1 = (await ws.read("a.txt")).version;
  check((await ws.write({ path: "a.txt", content: "v2", expectedVersion: v1, operationId: "w1" })).status === "applied", `${kind} A writes`);
  const b = await ws.write({ path: "a.txt", content: "v3", expectedVersion: v1, operationId: "w2" });
  check(b.status === "conflict" && b.currentVersion !== v1, `${kind} B conflicts`, JSON.stringify(b));
  check((await ws.read("a.txt")).content === "v2", `${kind} B did not overwrite`);

  // Idempotent replay: a recorder outcome wins over a later external change.
  const v2 = (await ws.read("a.txt")).version;
  const r1 = await ws.write({ path: "a.txt", content: "v4", expectedVersion: v2, operationId: "w3" });
  await t.env.writeFile(join(t.root, "a.txt"), "external", ctx);
  const r2 = await ws.write({ path: "a.txt", content: "v4", expectedVersion: v2, operationId: "w3" });
  check(r1.status === "applied" && eq(r1, r2), `${kind} replay returns recorded result`, JSON.stringify(r2));
  check((await t.env.readTextFile(join(t.root, "a.txt"), ctx)).value === "external", `${kind} replay did not overwrite`);

  // T-04: crash at each point, then recover on a fresh instance.
  for (const step of ["intent", "temp", "rename"]) {
    const base = (await ws.read("a.txt")).version;
    const crashing = await t.open(step);
    let crashed = false;
    try { await crashing.write({ path: "a.txt", content: "after-" + step, expectedVersion: base, operationId: "crash-" + step }); }
    catch (error) { crashed = error instanceof Crash; }
    check(crashed, `${kind} crash at ${step}`);

    const fresh = await t.open();
    const settled = await fresh.recover();
    const state = settled.find((s) => s.operationId === "crash-" + step)?.status ?? "none";
    check(state === (step === "rename" ? "applied" : "pending"), `${kind} recover ${step} -> ${state}`, JSON.stringify(settled));

    const retry = await fresh.write({ path: "a.txt", content: "after-" + step, expectedVersion: base, operationId: "crash-" + step });
    check(retry.status === "applied", `${kind} retry ${step}`, JSON.stringify(retry));
    check((await fresh.read("a.txt")).content === "after-" + step, `${kind} content after retry ${step}`);
  }

  // T-04: rename happened, but a third party changed the file afterwards -> unknown.
  {
    const base = (await ws.read("a.txt")).version;
    const crashing = await t.open("rename");
    try { await crashing.write({ path: "a.txt", content: "ours", expectedVersion: base, operationId: "crash-unknown" }); } catch {}
    await t.env.writeFile(join(t.root, "a.txt"), "stranger", ctx);
    const fresh = await t.open();
    const settled = await fresh.recover();
    const state = settled.find((s) => s.operationId === "crash-unknown")?.status;
    check(state === "unknown", `${kind} recover unknown`, JSON.stringify(settled));
    const retry = await fresh.write({ path: "a.txt", content: "ours", expectedVersion: base, operationId: "crash-unknown" });
    check(retry.status === "unknown", `${kind} replay unknown`, JSON.stringify(retry));
  }

  await t.env.cleanup?.(ctx);
  await t.close();
  await rm(t.base, { recursive: true, force: true });
}

await scenario("node");
await scenario("local");
console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
