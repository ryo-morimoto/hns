// Requirement 20: rename, archive, delete, and search conversations.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./server.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

const base = await mkdtemp(join(tmpdir(), "hns-conv-"));
await mkdir(join(base, "state")); await mkdir(join(base, "root"));
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];
const app = await startApp({ stateDir: join(base, "state"), root: join(base, "root"), provider: "faux", auth: false, fauxScript: [{ text: "a" }, { text: "b" }], webDirs });
const call = async (path, options) => { const response = await fetch(app.url + path, options); return { status: response.status, body: await response.json().catch(() => ({})) }; };
const post = (path, body) => call(path, { method: "POST", body: JSON.stringify(body) });

const project = (await post("/api/projects", { name: "p" })).body;
const alpha = (await post("/api/conversations", { projectId: project.id, title: "alpha" })).body;
const beta = (await post("/api/conversations", { projectId: project.id, title: "beta" })).body;
check(alpha.title === "alpha" && beta.title === "beta", "two conversations created");

let list = (await call("/api/conversations?projectId=" + project.id)).body;
check(list.length === 2, "they are listed", JSON.stringify(list.map((c) => c.title)));

const renamed = await call("/api/conversations/" + alpha.id, { method: "PATCH", body: JSON.stringify({ title: "alpha-renamed" }) });
check(renamed.status === 200 && renamed.body.title === "alpha-renamed", "rename works", JSON.stringify(renamed));

const found = (await call("/api/conversations?q=renamed")).body;
check(found.length === 1 && found[0].id === alpha.id, "search by title finds it", JSON.stringify(found.map((c) => c.title)));

await call("/api/conversations/" + alpha.id, { method: "PATCH", body: JSON.stringify({ archived: true }) });
list = (await call("/api/conversations?projectId=" + project.id)).body;
check(!list.some((c) => c.id === alpha.id), "an archived conversation is hidden by default");
const archived = (await call("/api/conversations?projectId=" + project.id + "&includeArchived=1")).body;
check(archived.some((c) => c.id === alpha.id), "it is listed when archived are included");

const deleted = await call("/api/conversations/" + beta.id, { method: "DELETE" });
check(deleted.status === 200 && deleted.body.deleted === true, "delete is soft", JSON.stringify(deleted));
list = (await call("/api/conversations?projectId=" + project.id)).body;
check(!list.some((c) => c.id === beta.id), "the deleted conversation is hidden");
check((await call("/api/state?conversationId=" + beta.id)).status === 404, "its state is not served");
check((await post("/api/chat", { message: "x", conversationId: beta.id })).status === 404, "chatting into it is refused");

const rootId = (await call("/api/conversations")).body.find((c) => c.title === "main")?.id;
check((await call("/api/conversations/" + rootId, { method: "DELETE" })).status === 400, "the root conversation cannot be deleted");

// Chat activity updates the ordering and touches the record.
await post("/api/chat", { message: "hello", conversationId: alpha.id });
await new Promise((resolve) => setTimeout(resolve, 300));
const after = (await call("/api/conversations?projectId=" + project.id + "&includeArchived=1")).body;
check(after.find((c) => c.id === alpha.id)?.updated_at !== null, "chat touches updated_at");

const events = (await call("/api/events?limit=200")).body;
const names = new Set(events.map((event) => event.event));
check(["conversation.created", "conversation.updated", "conversation.deleted"].every((name) => names.has(name)), "conversation lifecycle is journaled", JSON.stringify([...names].filter((n) => n.startsWith("conversation"))));

await app.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
