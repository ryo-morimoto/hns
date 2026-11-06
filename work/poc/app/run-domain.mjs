// Control Plane domain: projects, tasks, conversations.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./server.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 15000) {
  const started = Date.now();
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() - started > timeoutMs) return undefined; await sleep(50); }
}

const base = await mkdtemp(join(tmpdir(), "hns-domain-"));
const stateDir = join(base, "state");
const root = join(base, "root");
await mkdir(stateDir); await mkdir(root);
await writeFile(join(root, "a.txt"), "v1");

const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];
const app = await startApp({ stateDir, root, provider: "faux", fauxScript: [{ text: "hello2" }], webDirs });
const api = async (path, options) => {
  const response = await fetch(app.url + path, options);
  return { status: response.status, body: await response.json() };
};
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path, body) => api(path, { method: "PATCH", body: JSON.stringify(body) });

const projects = await api("/api/projects");
check(projects.status === 200 && projects.body.some((p) => p.id === "default"), "default project exists");

const created = await post("/api/projects", { name: "p1" });
check(created.status === 201 && created.body.name === "p1", "project created", JSON.stringify(created));
const renamed = await patch("/api/projects/" + created.body.id, { name: "p1-renamed" });
check(renamed.status === 200 && renamed.body.name === "p1-renamed", "project renamed", JSON.stringify(renamed));

const task = await post("/api/tasks", { projectId: created.body.id, title: "write the docs" });
check(task.status === 201 && task.body.status === "todo", "task created as todo", JSON.stringify(task));
const doing = await patch("/api/tasks/" + task.body.id, { status: "doing" });
check(doing.status === 200 && doing.body.status === "doing", "task moved to doing");
const done = await patch("/api/tasks/" + task.body.id, { status: "done" });
check(done.status === 200 && done.body.status === "done", "task moved to done");
const invalid = await patch("/api/tasks/" + task.body.id, { status: "nope" });
check(invalid.status === 400, "invalid status rejected", JSON.stringify(invalid));
const listed = await api("/api/tasks?projectId=" + created.body.id);
check(listed.body.length === 1 && listed.body[0].id === task.body.id, "tasks listed per project");

const conversations = await api("/api/conversations");
check(conversations.body.some((c) => c.title === "main"), "root conversation is registered", JSON.stringify(conversations.body));
const second = await post("/api/conversations", { projectId: created.body.id, title: "second" });
check(second.status === 201 && second.body.project_id === created.body.id, "conversation created in project", JSON.stringify(second));
const projectConversations = await api("/api/conversations?projectId=" + created.body.id);
check(projectConversations.body.length === 1 && projectConversations.body[0].id === second.body.id, "conversations listed per project");

await post("/api/chat", { message: "hello", conversationId: second.body.id });
const answered = await waitFor(async () => {
  const state = await api("/api/state?conversationId=" + second.body.id);
  return state.body.messages.some((m) => m.role === "assistant" && m.text === "hello2");
});
check(answered === true, "chat works on a second conversation");
const rootState = await api("/api/state");
check(!rootState.body.messages.some((m) => m.text === "hello2"), "the root conversation is untouched");

await app.close();

// Persistence of the control plane across a restart.
const again = await startApp({ stateDir, root, provider: "faux", fauxScript: [], webDirs });
const projectsAfter = await (await fetch(again.url + "/api/projects")).json();
const tasksAfter = await (await fetch(again.url + "/api/tasks")).json();
check(projectsAfter.some((p) => p.name === "p1-renamed"), "projects survive restart");
check(tasksAfter.some((t) => t.status === "done"), "tasks survive restart");
await again.close();

await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);