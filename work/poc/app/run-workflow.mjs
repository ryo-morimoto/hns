// Workflows: validation, versions, agent/tool/human nodes, and resume after a restart.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

const base = await mkdtemp(join(tmpdir(), "hns-wf-"));
const stateDir = join(base, "state");
const root = join(base, "root");
await mkdir(stateDir); await mkdir(root);
await writeFile(join(root, "a.txt"), "v1");

const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];
const script = Array.from({ length: 8 }, (_, i) => ({ text: i === 1 ? "review-out" : "plan-out" }));
const app = await startApp({ stateDir, root, provider: "faux", fauxScript: script, webDirs });
const api = async (path, options) => {
  const response = await fetch(app.url + path, options);
  return { status: response.status, body: await response.json() };
};
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

// --- agent chain + versions -------------------------------------------------
const graph = {
  nodes: [
    { id: "plan", type: "agent", prompt: "Plan for {{input}}" },
    { id: "review", type: "agent", prompt: "Review: {{plan}}" },
  ],
  edges: [{ from: "plan", to: "review" }],
};
const invalid = await post("/api/workflows", { name: "bad", graph: { nodes: [{ id: "a", type: "agent", prompt: "x" }, { id: "b", type: "agent", prompt: "y" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] } });
check(invalid.status === 400 && String(invalid.body.error).includes("cycle"), "cycle is rejected");

const created = await post("/api/workflows", { name: "two steps", graph });
check(created.status === 201 && created.body.version === 1, "workflow created");
const started = await post("/api/workflows/" + created.body.id + "/runs", { input: "ship it" });
check(started.status === 202 && started.body.version === 1, "run pinned to version 1");

const finished = await waitFor(async () => {
  const run = await api("/api/runs/" + started.body.id);
  return run.body.status === "done" ? run.body : undefined;
});
check(finished !== undefined, "agent chain finishes");
check(finished?.nodes.every((node) => node.status === "done"), "both nodes are done");
check(String(finished?.nodes[1]?.prompt).includes("plan-out"), "the second prompt interpolates the first output");

const updated = await api("/api/workflows/" + created.body.id, { method: "PUT", body: JSON.stringify({ graph: { nodes: [{ id: "solo", type: "agent", prompt: "Solo {{input}}" }], edges: [] } }) });
check(updated.status === 200 && updated.body.version === 2, "editing makes a new version");

// --- tool + human -----------------------------------------------------------
const mixed = await post("/api/workflows", { name: "mixed", graph: {
  nodes: [
    { id: "plan", type: "agent", prompt: "Plan for {{input}}" },
    { id: "check", type: "tool", command: "echo tool-{{input}}" },
    { id: "approve", type: "human", prompt: "Approve: {{check}}" },
  ],
  edges: [{ from: "plan", to: "check" }, { from: "check", to: "approve" }],
} });
check(mixed.status === 201, "mixed workflow created", JSON.stringify(mixed));

const waiting = await post("/api/workflows/" + mixed.body.id + "/runs", { input: "ship" });
const paused = await waitFor(async () => {
  const run = await api("/api/runs/" + waiting.body.id);
  return run.body.status === "waiting" ? run.body : undefined;
});
check(paused !== undefined, "run pauses at the human node", JSON.stringify((await api("/api/runs/" + waiting.body.id)).body).slice(0, 300));
const toolNode = paused?.nodes.find((node) => node.node_id === "check");
const humanNode = paused?.nodes.find((node) => node.node_id === "approve");
check(toolNode?.status === "done" && String(toolNode?.output).includes("tool-ship"), "tool node ran and captured output", JSON.stringify(toolNode));
check(humanNode?.status === "waiting" && String(humanNode?.prompt).includes("tool-ship"), "human prompt carries the tool output", JSON.stringify(humanNode));

const resumed = await post("/api/runs/" + waiting.body.id + "/nodes/approve", { output: "ok" });
check(resumed.status === 202, "human node accepted", JSON.stringify(resumed));
const done = await waitFor(async () => {
  const run = await api("/api/runs/" + waiting.body.id);
  return run.body.status === "done" ? run.body : undefined;
});
check(done !== undefined, "run finishes after the human node");
check(done?.nodes.find((node) => node.node_id === "approve")?.output === "ok", "human output recorded");

// --- restart while waiting --------------------------------------------------
const waiting2 = await post("/api/workflows/" + mixed.body.id + "/runs", { input: "again" });
await waitFor(async () => (await api("/api/runs/" + waiting2.body.id)).body.status === "waiting");
await app.close();

const second = await startApp({ stateDir, root, provider: "faux", fauxScript: [], webDirs });
const restored = await (await fetch(second.url + "/api/runs/" + waiting2.body.id)).json();
check(restored.status === "waiting", "a waiting run survives restart", restored.status);
await fetch(second.url + "/api/runs/" + waiting2.body.id + "/nodes/approve", { method: "POST", body: JSON.stringify({ output: "later" }) });
const resumedAfterRestart = await waitFor(async () => {
  const run = await (await fetch(second.url + "/api/runs/" + waiting2.body.id)).json();
  return run.status === "done" ? run : undefined;
});
check(resumedAfterRestart !== undefined, "the run resumes after restart", JSON.stringify(resumedAfterRestart)?.slice(0, 200));

await second.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);