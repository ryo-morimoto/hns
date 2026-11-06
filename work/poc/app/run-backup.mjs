// Requirement 16: a consistent backup and restore of the state directory.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "./server.mjs";
import { backupState, restoreState } from "./backup.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

const base = await mkdtemp(join(tmpdir(), "hns-bak-"));
const stateDir = join(base, "state");
const root = join(base, "root");
const backupDir = join(base, "backup");
await mkdir(stateDir); await mkdir(root);
await writeFile(join(root, "a.txt"), "v1");

const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];
const app = await startApp({ stateDir, root, provider: "faux", auth: false, fauxScript: [{ text: "x" }], webDirs });
const postAt = async (url, path, body) => (await fetch(url + path, { method: "POST", body: JSON.stringify(body) })).json();
const project = await postAt(app.url, "/api/projects", { name: "before-backup" });
await postAt(app.url, "/api/tasks", { projectId: project.id, title: "keep me" });

await backupState(stateDir, backupDir);
check(true, "backup completes while the app runs");
await app.close();

// Mutate after the backup.
const later = await startApp({ stateDir, root, provider: "faux", auth: false, fauxScript: [], webDirs });
await postAt(later.url, "/api/projects", { name: "after-backup" });
await later.close();

await restoreState(backupDir, stateDir);
const restored = await startApp({ stateDir, root, provider: "faux", auth: false, fauxScript: [], webDirs });
const projects = await (await fetch(restored.url + "/api/projects")).json();
const tasks = await (await fetch(restored.url + "/api/tasks")).json();
check(projects.some((p) => p.name === "before-backup"), "the backup's project is back");
check(!projects.some((p) => p.name === "after-backup"), "work after the backup is gone");
check(tasks.some((t) => t.title === "keep me"), "tasks come back");
check((await readFile(join(root, "a.txt"), "utf8")) === "v1", "workspace files are untouched by restore");
await restored.close();

await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);