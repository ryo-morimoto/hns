// Integrated MVP: chat → tool edit → UI state → restart → continue.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startApp } from "./server.mjs";

const sha = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return undefined;
    await sleep(100);
  }
}

const base = await mkdtemp(join(tmpdir(), "hns-app-"));
const stateDir = join(base, "state");
const root = join(base, "root");
await mkdir(stateDir); await mkdir(root);
await writeFile(join(root, "a.txt"), "v1");

const script = [
  { toolCall: "read_file", arguments: { path: "a.txt" } },
  { toolCall: "write_file", arguments: { path: "a.txt", content: "v2", expectedVersion: sha("v1"), operationId: "e1" } },
  { text: "done1" },
];
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];

const first = await startApp({ stateDir, root, provider: "faux", fauxScript: script, webDirs });
const stateOf = async (app) => (await fetch(app.url + "/api/state")).json();

await fetch(first.url + "/api/chat", { method: "POST", body: JSON.stringify({ message: "edit a.txt" }) });
const done1 = await waitFor(async () => (await stateOf(first)).messages.some((m) => m.role === "assistant" && m.text === "done1"));
check(done1 === true, "chat turn completes through the UI API", JSON.stringify((await stateOf(first)).messages).slice(0, 300));

const after = await stateOf(first);
check(after.messages.filter((m) => m.role === "tool").length === 2, "two tool results in the transcript", String(after.messages.length));
check((await fetch(first.url + "/api/file?path=a.txt").then((r) => r.json())).content === "v2", "agent edit is on disk");

const page = await fetch(first.url + "/");
check(page.status === 200 && (await page.text()).includes("conversation"), "UI is served");
check((await fetch(first.url + "/buffer.mjs")).status === 200, "shared editor module is served");

await first.close();

// Restart against the same state directory.
const second = await startApp({ stateDir, root, provider: "faux", fauxScript: [{ text: "done2" }], webDirs });
const restored = await stateOf(second);
check(restored.messages.some((m) => m.role === "assistant" && m.text === "done1"), "transcript survives restart", JSON.stringify(restored.messages.map((m) => m.text)).slice(0, 200));
check((await fetch(second.url + "/api/file?path=a.txt").then((r) => r.json())).content === "v2", "file survives restart");

await fetch(second.url + "/api/chat", { method: "POST", body: JSON.stringify({ message: "continue" }) });
const done2 = await waitFor(async () => (await stateOf(second)).messages.some((m) => m.role === "assistant" && m.text === "done2"));
check(done2 === true, "conversation continues after restart", JSON.stringify((await stateOf(second)).messages.map((m) => m.text)).slice(0, 300));

await second.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
