// End to end: read → conditional write → conflict → events → reconnect → external change → overflow.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { startServer } from "./server.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

const base = await mkdtemp(join(tmpdir(), "hns-walk-"));
const root = join(base, "root");
const connection = new Connection({ command: [localDaemon()] });
const env = new LocalExecutionEnv({ cwd: base, connection });
await env.createDir(root, undefined, ctx);
const app = await startServer({ env, root, journalPath: join(base, "journal.json") });

const post = async (path, body) => {
  const res = await fetch(app.url + path, { method: "POST", body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const get = async (path) => {
  const res = await fetch(app.url + path);
  return { status: res.status, body: await res.json() };
};
const nextEvent = async (cursor) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${app.url}/events?cursor=${cursor}&limit=1`, { signal: controller.signal });
    const [first] = (await res.text()).trim().split("\n");
    return JSON.parse(first);
  } finally { clearTimeout(timer); }
};

// create, read, stale write
const w1 = await post("/write", { path: "a.txt", content: "hello", expectedVersion: "absent", operationId: "w1" });
check(w1.status === 200 && w1.body.status === "applied", "create applies", JSON.stringify(w1));
const read = await get("/read?path=a.txt");
check(read.status === 200 && read.body.content === "hello", "read returns content", JSON.stringify(read));

const stale = await post("/write", { path: "a.txt", content: "stale", expectedVersion: "absent", operationId: "w2" });
check(stale.status === 409 && stale.body.status === "conflict", "stale write conflicts", JSON.stringify(stale));

const w3 = await post("/write", { path: "a.txt", content: "hello2", expectedVersion: read.body.version, operationId: "w3" });
check(w3.status === 200 && w3.body.status === "applied", "guarded write applies", JSON.stringify(w3));

// replay from zero
const e1 = await nextEvent("0");
const e2 = await nextEvent(e1.seq);
check(e1.kind === "created" && e1.path === "a.txt", "event 1 created", JSON.stringify(e1));
check(e2.kind === "changed" && e2.version === w3.body.version, "event 2 changed", JSON.stringify(e2));

// reconnect after a gap
const w4 = await post("/write", { path: "a.txt", content: "hello3", expectedVersion: w3.body.version, operationId: "w4" });
const missed = await nextEvent(e2.seq);
check(w4.status === 200 && missed.kind === "changed" && missed.seq > e2.seq, "reconnect replays the gap", JSON.stringify(missed));

// external change, bypassing Workspace
await post("/debug/touch", { path: "a.txt", content: "from-bash" });
const external = await nextEvent(missed.seq);
check(external.kind === "changed" && external.path === "a.txt", "external change is reported", JSON.stringify(external));
const afterExternal = await get("/read?path=a.txt");
check(afterExternal.body.content === "from-bash", "external change is visible", JSON.stringify(afterExternal));

// overflow, then a change is re-reported even if the version is known
const overflow = await post("/debug/overflow", {});
const overflowEvent = await nextEvent(external.seq);
check(overflowEvent.kind === "overflow", "overflow is reported", JSON.stringify(overflowEvent));
await post("/debug/touch", { path: "a.txt", content: "from-bash-2" });
const afterOverflow = await nextEvent(overflowEvent.seq);
check(afterOverflow.kind === "changed" && afterOverflow.version === (await get("/read?path=a.txt")).body.version, "change after overflow", JSON.stringify(afterOverflow));

// root confinement through the API, with an audit record
const escape = await post("/write", { path: "../x.txt", content: "x", expectedVersion: "absent", operationId: "w5" });
check(escape.status === 403, "path traversal rejected", JSON.stringify(escape));
const audit = await get("/audit");
check(audit.body.some((a) => a.denied && a.operationId === "w5" && a.path === "../x.txt"), "denial is audited", JSON.stringify(audit.body));

await app.close();
await env.cleanup?.(ctx);
await connection.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;