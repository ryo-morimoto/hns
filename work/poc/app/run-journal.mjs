// The journal should cover the whole product, not just one path.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./server.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() - started > timeoutMs) return undefined; await sleep(50); }
}
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];

const base = await mkdtemp(join(tmpdir(), "hns-journal-"));
await mkdir(join(base, "state")); await mkdir(join(base, "root"));
const script = [
  { text: "ok" }, { text: "ok" },
  { toolCall: "read_file", arguments: { path: "a.txt" } }, { text: "read it" },
  ...Array.from({ length: 4 }, () => ({ text: "ok" })),
];
const app = await startApp({ stateDir: join(base, "state"), root: join(base, "root"), provider: "faux", auth: false, fauxScript: script, webDirs, limits: { turnsPerMinute: 1 } });
const call = async (path, options) => { const response = await fetch(app.url + path, options); return { status: response.status, body: await response.json().catch(() => ({})) }; };
const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body) });

// Projects and tasks.
const project = (await post("/api/projects", { name: "journal" })).body;
const task = (await post("/api/tasks", { projectId: project.id, title: "record" })).body;
await call("/api/tasks/" + task.id, { method: "PATCH", body: JSON.stringify({ status: "doing" }) });
// Secret (service scope).
await call("/api/secrets/service/note", { method: "PUT", body: JSON.stringify({ value: "x" }) });
// File write through the API.
await call("/api/file", { method: "PUT", body: JSON.stringify({ path: "a.txt", content: "x", expectedVersion: "absent", operationId: "j1" }) });

// Workflow run.
const workflow = (await post("/api/workflows", { name: "wf", graph: { nodes: [{ id: "step", type: "agent", prompt: "Do {{input}}" }], edges: [] } })).body;
await post("/api/workflows/" + workflow.id + "/runs", { input: "x" });
await waitFor(async () => (await call("/api/events?limit=300")).body.some((event) => event.event === "workflow.run.finished"));

// Automation firing a workflow.
const automation = (await post("/api/automations", { name: "auto", trigger: { type: "webhook" }, action: { type: "workflow", workflowId: workflow.id } })).body;
await post("/api/hooks/" + automation.token, { body: "from hook" });
await waitFor(async () => (await call("/api/events?limit=300")).body.some((event) => event.event === "automation.finished"));

// Chat, then a rate-limited second turn.
await post("/api/chat", { message: "hi" });
await waitFor(async () => (await call("/api/events?limit=300")).body.some((event) => event.event === "chat.settled"));
const limited = await post("/api/chat", { message: "again" });
check(limited.status === 429, "the second turn is rate limited");

const events = (await call("/api/events?limit=500")).body;
const names = new Set(events.map((event) => event.event));
const expected = [
  "server.start", "project.created", "task.created", "task.updated", "secret.put", "file.write",
  "workflow.created", "workflow.run.started", "workflow.node.started", "workflow.node.finished", "workflow.run.finished",
  "automation.created", "automation.fired", "automation.finished",
  "chat.submitted", "chat.settled", "chat.rate_limited", "agent.response", "tool.call", "tool.result",
];
const missing = expected.filter((name) => !names.has(name));
check(missing.length === 0, "every lifecycle leaves an event", "missing: " + missing.join(", "));

const metrics = (await call("/api/metrics")).body;
check(Array.isArray(metrics.byEvent) && metrics.byEvent.length >= 5, "events are aggregated by name", JSON.stringify(metrics.byEvent?.slice(0, 5)));
check(metrics.workflowRuns.some((row) => row.status === "done"), "workflow runs are in the metrics", JSON.stringify(metrics.workflowRuns));
await app.close();

// Auth denials.
{
  const base2 = await mkdtemp(join(tmpdir(), "hns-journal2-"));
  await mkdir(join(base2, "state")); await mkdir(join(base2, "root"));
  const closed = await startApp({ stateDir: join(base2, "state"), root: join(base2, "root"), provider: "faux", auth: true, fauxScript: [], webDirs });
  await fetch(closed.url + "/api/state");
  await sleep(100);
  const denied = await (await fetch(closed.url + "/api/events", { headers: { authorization: "Bearer " + closed.token } })).json();
  check(denied.some((event) => event.event === "auth.denied"), "denied access is in the journal", JSON.stringify(denied.slice(0, 2)));
  await closed.close();
  await rm(base2, { recursive: true, force: true });
}

await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);