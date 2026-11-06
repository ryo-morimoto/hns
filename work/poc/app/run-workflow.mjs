// Workflows: validation, versioned runs, node outputs, templating.
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
const app = await startApp({ stateDir, root, provider: "faux", fauxScript: [{ text: "plan-out" }, { text: "review-out" }], webDirs });
const api = async (path, options) => {
  const response = await fetch(app.url + path, options);
  return { status: response.status, body: await response.json() };
};
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

const graph = {
  nodes: [
    { id: "plan", type: "agent", prompt: "Plan for {{input}}" },
    { id: "review", type: "agent", prompt: "Review: {{plan}}" },
  ],
  edges: [{ from: "plan", to: "review" }],
};

const invalid = await post("/api/workflows", { name: "bad", graph: { nodes: [{ id: "a", type: "agent", prompt: "x" }, { id: "b", type: "agent", prompt: "y" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] } });
check(invalid.status === 400 && String(invalid.body.error).includes("cycle"), "cycle is rejected", JSON.stringify(invalid));

const created = await post("/api/workflows", { name: "two steps", graph });
check(created.status === 201 && created.body.version === 1, "workflow created", JSON.stringify(created));

const started = await post("/api/workflows/" + created.body.id + "/runs", { input: "ship it" });
check(started.status === 202 && started.body.version === 1, "run accepted and pinned to the version", JSON.stringify(started));

const finished = await waitFor(async () => {
  const run = await api("/api/runs/" + started.body.id);
  return run.body.status === "done" ? run.body : undefined;
});
check(finished !== undefined, "run finishes", JSON.stringify((await api("/api/runs/" + started.body.id)).body).slice(0, 300));

const nodes = finished?.nodes ?? [];
check(nodes.length === 2 && nodes.every((node) => node.status === "done"), "both nodes are done", JSON.stringify(nodes.map((n) => n.status)));
check(nodes[0]?.output === "plan-out" && nodes[1]?.output === "review-out", "node outputs are recorded", JSON.stringify(nodes.map((n) => n.output)));
check(String(nodes[1]?.prompt).includes("plan-out"), "the second prompt interpolates the first output", String(nodes[1]?.prompt));
check(nodes.every((node) => node.conversation_id), "each node has its conversation");

const updated = await api("/api/workflows/" + created.body.id, { method: "PUT", body: JSON.stringify({ graph: { nodes: [{ id: "solo", type: "agent", prompt: "Solo {{input}}" }], edges: [] } }) });
check(updated.status === 200 && updated.body.version === 2, "editing makes a new version", JSON.stringify(updated));

const second = await post("/api/workflows/" + created.body.id + "/runs", { input: "second" });
check(second.body.version === 2, "the new run uses version 2");

await app.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
