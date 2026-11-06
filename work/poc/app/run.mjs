// Integrated MVP: SSE progress, unfinished tasks, and restart.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startApp } from "./server.mjs";

const sha = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return undefined;
    await sleep(50);
  }
}

function openStream(url) {
  const controller = new AbortController();
  const events = [];
  (async () => {
    const response = await fetch(url, { signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = chunk.split("\n").find((piece) => piece.startsWith("data: "));
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});
  return { events, close: () => controller.abort() };
}

const base = await mkdtemp(join(tmpdir(), "hns-app-"));
const stateDir = join(base, "state");
const root = join(base, "root");
await mkdir(stateDir); await mkdir(root);
await writeFile(join(root, "a.txt"), "v1");

const script = [
  { toolCall: "slow_tool", arguments: {} },
  { toolCall: "read_file", arguments: { path: "a.txt" } },
  { toolCall: "write_file", arguments: { path: "a.txt", content: "v2", expectedVersion: sha("v1"), operationId: "e1" } },
  { text: "done1" },
];
const webDirs = [join(import.meta.dirname, "ui"), join(import.meta.dirname, "../editor")];

const first = await startApp({ stateDir, root, provider: "faux", auth: false, fauxScript: script, webDirs });
const stream = openStream(first.url + "/api/stream");
const initial = await waitFor(() => stream.events.length > 0);
check(initial === true, "stream sends the initial state");

await fetch(first.url + "/api/chat", { method: "POST", body: JSON.stringify({ message: "edit a.txt" }) });

const unfinished = await waitFor(() => stream.events.find((state) => state.tasks.length > 0));
check(unfinished !== undefined, "an unfinished task appears while the tool runs", JSON.stringify(stream.events.map((s) => s.tasks.length)));
check(unfinished !== undefined && unfinished.tasks.some((task) => task.state === "running" || task.state === "pending"), "the task is running or pending", JSON.stringify(unfinished?.tasks));

const finished = await waitFor(() => stream.events.find((state) => state.messages.some((m) => m.role === "assistant" && m.text === "done1")));
check(finished !== undefined, "the final state arrives on the stream");
check(finished !== undefined && finished.tasks.length === 0, "no unfinished tasks at the end", JSON.stringify(finished?.tasks));
check(finished !== undefined && finished.messages.filter((m) => m.role === "tool").length === 3, "three tool results", String(finished?.messages.length));

const file = await (await fetch(first.url + "/api/file?path=a.txt")).json();
check(file.content === "v2", "agent edit is on disk");

const page = await fetch(first.url + "/");
check(page.status === 200 && (await page.text()).includes("conversation"), "UI is served");
check((await fetch(first.url + "/buffer.mjs")).status === 200, "shared editor module is served");

stream.close();
await first.close();

// Restart against the same state directory.
const second = await startApp({ stateDir, root, provider: "faux", auth: false, fauxScript: [{ text: "done2" }], webDirs });
const restored = await (await fetch(second.url + "/api/state")).json();
check(restored.messages.some((m) => m.role === "assistant" && m.text === "done1"), "transcript survives restart");
check((await (await fetch(second.url + "/api/file?path=a.txt")).json()).content === "v2", "file survives restart");

const stream2 = openStream(second.url + "/api/stream");
await fetch(second.url + "/api/chat", { method: "POST", body: JSON.stringify({ message: "continue" }) });
const done2 = await waitFor(() => stream2.events.find((state) => state.messages.some((m) => m.role === "assistant" && m.text === "done2")));
check(done2 !== undefined, "conversation continues after restart", JSON.stringify(stream2.events.length));

stream2.close();
await second.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);