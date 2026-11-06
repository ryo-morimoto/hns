// Requirement 13: the app token gates the API; webhooks use their own token.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./server.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

const base = await mkdtemp(join(tmpdir(), "hns-auth-"));
const stateDir = join(base, "state");
const root = join(base, "root");
await mkdir(stateDir); await mkdir(root);
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];
const app = await startApp({ stateDir, root, provider: "faux", fauxScript: [{ text: "x" }], webDirs });

const status = async (path, headers = {}) => (await fetch(app.url + path, { headers })).status;
const bearer = (token) => ({ authorization: "Bearer " + token });

check(typeof app.token === "string" && app.token.length >= 16, "a token is generated");
check(await status("/api/state") === 401, "api without a token is 401");
check(await status("/api/state", bearer("wrong")) === 401, "wrong token is 401");
check(await status("/api/state", bearer(app.token)) === 200, "bearer token works");
check(await status("/api/state?token=" + app.token) === 200, "query token works");
check(await status("/") === 200, "the UI shell itself is public");

// A hook has its own token and must not need the app token.
const authHeaders = { ...bearer(app.token), "content-type": "application/json" };
const workflow = await (await fetch(app.url + "/api/workflows", { method: "POST", headers: authHeaders, body: JSON.stringify({ name: "w", graph: { nodes: [{ id: "a", type: "agent", prompt: "p" }], edges: [] } }) })).json();
const automation = await (await fetch(app.url + "/api/automations", { method: "POST", headers: authHeaders, body: JSON.stringify({ name: "h", trigger: { type: "webhook" }, action: { type: "workflow", workflowId: workflow.id } }) })).json();
const hook = await fetch(app.url + "/api/hooks/" + automation.token, { method: "POST", body: JSON.stringify({ body: "x" }) });
check(hook.status === 202, "webhook does not need the app token", String(hook.status));

await app.close();

// The token survives a restart (it lives in the state directory).
const again = await startApp({ stateDir, root, provider: "faux", fauxScript: [], webDirs });
check(again.token === app.token, "the token is stable across restarts");
check((await fetch(again.url + "/api/state", { headers: bearer(app.token) })).status === 200, "the old token still works");
await again.close();

await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);