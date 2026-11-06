// Automations: webhook and schedule triggers, firings, concurrency.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./server.mjs";
import { cronMatches } from "./cron.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 25000) {
  const started = Date.now();
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() - started > timeoutMs) return undefined; await sleep(50); }
}

// --- cron ------------------------------------------------------------------
{
  const at = (h, m, dow = 0) => new Date(2026, 10, 1 + dow, h, m);
  check(cronMatches("*/5 * * * *", at(10, 10)) === true, "cron: step matches");
  check(cronMatches("*/5 * * * *", at(10, 7)) === false, "cron: step rejects");
  check(cronMatches("0 9 * * 1-5", at(9, 0, 1)) === true, "cron: weekday range matches");
  check(cronMatches("0 9 * * 1-5", at(9, 0, 0)) === false, "cron: sunday rejected");
  check(cronMatches("30 8,20 * * *", at(20, 30)) === true, "cron: list");
}

const base = await mkdtemp(join(tmpdir(), "hns-auto-"));
const stateDir = join(base, "state");
const root = join(base, "root");
await mkdir(stateDir); await mkdir(root);
await writeFile(join(root, "a.txt"), "v1");

const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];
const script = Array.from({ length: 20 }, () => ({ text: "auto-out" }));
const app = await startApp({ stateDir, root, provider: "faux", fauxScript: script, webDirs, allowDebug: true });
const api = async (path, options) => {
  const response = await fetch(app.url + path, options);
  return { status: response.status, body: await response.json() };
};
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path, body) => api(path, { method: "PATCH", body: JSON.stringify(body) });

const workflow = await post("/api/workflows", { name: "auto", graph: { nodes: [{ id: "run", type: "agent", prompt: "Do {{input}}" }], edges: [] } });

// --- webhook ---------------------------------------------------------------
const webhook = await post("/api/automations", {
  name: "on push",
  trigger: { type: "webhook" },
  action: { type: "workflow", workflowId: workflow.body.id },
});
check(webhook.status === 201 && typeof webhook.body.token === "string", "webhook automation created with a token", JSON.stringify(webhook));

const accepted = await post("/api/hooks/" + webhook.body.token, { body: "hello hook" });
check(accepted.status === 202, "hook accepted");
const fired = await waitFor(async () => {
  const list = await api("/api/automations/" + webhook.body.id + "/firings");
  return list.body.find((firing) => firing.status === "done");
});
check(fired !== undefined, "firing completes", JSON.stringify((await api("/api/automations/" + webhook.body.id + "/firings")).body).slice(0, 300));
check(fired?.run_id, "firing records the run");
const run = await api("/api/runs/" + fired.run_id);
check(run.body.status === "done" && run.body.input === "hello hook", "the workflow ran with the webhook body", JSON.stringify({ status: run.body.status, input: run.body.input }));

const unknown = await post("/api/hooks/not-a-token", {});
check(unknown.status === 404, "unknown hook is 404");

await patch("/api/automations/" + webhook.body.id, { enabled: false });
const disabled = await post("/api/hooks/" + webhook.body.token, {});
check(disabled.status === 409, "disabled automation refuses the hook");

// --- concurrency -----------------------------------------------------------
const slowWorkflow = await post("/api/workflows", { name: "slow", graph: { nodes: [{ id: "slow", type: "tool", command: "sleep 1; echo slow-done" }], edges: [] } });
const slow = await post("/api/automations", { name: "slow hook", trigger: { type: "webhook" }, action: { type: "workflow", workflowId: slowWorkflow.body.id } });
await post("/api/hooks/" + slow.body.token, { body: "one" });
await sleep(150);
await post("/api/hooks/" + slow.body.token, { body: "two" });
const firings = await waitFor(async () => {
  const list = (await api("/api/automations/" + slow.body.id + "/firings")).body;
  return list.some((firing) => firing.status === "done") && list.some((firing) => firing.status === "skipped") ? list : undefined;
});
check(firings !== undefined, "a second firing while running is skipped", JSON.stringify((await api("/api/automations/" + slow.body.id + "/firings")).body).slice(0, 300));

// --- schedule --------------------------------------------------------------
const scheduled = await post("/api/automations", {
  name: "noon",
  trigger: { type: "schedule", cron: "0 12 * * *" },
  action: { type: "workflow", workflowId: workflow.body.id },
});
check(scheduled.status === 201, "schedule automation created", JSON.stringify(scheduled));
const noon = new Date(2026, 10, 6, 12, 0).toISOString();
await post("/api/debug/tick", { at: noon });
const scheduledFiring = await waitFor(async () => {
  const list = (await api("/api/automations/" + scheduled.body.id + "/firings")).body;
  return list.find((firing) => firing.status === "done");
});
check(scheduledFiring !== undefined, "schedule fires at the matching minute", JSON.stringify((await api("/api/automations/" + scheduled.body.id + "/firings")).body));

await post("/api/debug/tick", { at: noon });
await sleep(200);
const after = (await api("/api/automations/" + scheduled.body.id + "/firings")).body;
check(after.length === 1, "the same minute does not fire twice", String(after.length));

await post("/api/debug/tick", { at: new Date(2026, 10, 6, 12, 1).toISOString() });
await sleep(200);
check((await api("/api/automations/" + scheduled.body.id + "/firings")).body.length === 1, "a different minute without a match does not fire");

await app.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
