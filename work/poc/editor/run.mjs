// Editor: buffer semantics (dirty, conflict, overwrite) and the HTTP path it uses.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { startServer } from "../walking-skeleton/server.mjs";
import { EditorBuffer } from "./buffer.mjs";
import { diffLines } from "./diff.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

// 0. Line diff.
{
  const same = diffLines("a\nb\nc", "a\nb\nc");
  check(!same.tooLarge && same.ops.every((op) => op.type === "same") && same.added === 0 && same.removed === 0, "diff: identical");

  const changed = diffLines("a\nb\nc", "a\nB\nc");
  check(changed.ops.some((op) => op.type === "del" && op.text === "b") && changed.ops.some((op) => op.type === "add" && op.text === "B"), "diff: replaced line", JSON.stringify(changed.ops));

  const inserted = diffLines("a\nc", "a\nb\nc");
  check(inserted.added === 1 && inserted.removed === 0, "diff: insertion", JSON.stringify(inserted));
  const deleted = diffLines("a\nb\nc", "a\nc");
  check(deleted.removed === 1 && deleted.added === 0, "diff: deletion", JSON.stringify(deleted));

  const huge = diffLines(Array.from({ length: 6000 }, (_, i) => String(i)).join("\n"), "x");
  check(huge.tooLarge === true, "diff: line guard");
  const wide = diffLines(Array.from({ length: 3000 }, (_, i) => "a" + i).join("\n"), Array.from({ length: 3000 }, (_, i) => "b" + i).join("\n"));
  check(wide.tooLarge === true, "diff: cell guard");
}

// 1. Buffer state machine with fake IO.
{
  let disk = { content: "one", version: "v1" };
  let counter = 1;
  const read = async () => ({ ...disk });
  const save = async (input) => {
    if (input.expectedVersion !== disk.version) return { status: "conflict", operationId: input.operationId, currentVersion: disk.version };
    disk = { content: input.content, version: "v-" + (++counter) };
    return { status: "applied", operationId: input.operationId, version: disk.version };
  };
  const buffer = new EditorBuffer({ read, save });
  await buffer.open("a.txt");
  check(!buffer.dirty && buffer.baseVersion === "v1", "open: clean");

  buffer.edit("two");
  check(buffer.dirty, "edit: dirty");
  const saved = await buffer.save("op-1");
  check(saved.status === "applied" && !buffer.dirty && buffer.baseVersion === "v-2", "save: applied and clean", JSON.stringify({ saved, baseVersion: buffer.baseVersion }));

  buffer.edit("three");
  disk = { content: "external", version: "v-3" };
  const conflict = await buffer.save("op-2");
  check(conflict.status === "conflict" && buffer.dirty, "save: conflict keeps the local content");
  check(buffer.content === "three" && buffer.conflict?.currentVersion === "v-3", "conflict: local content and version kept");
  check(buffer.conflict?.external?.content === "external", "conflict: external content kept for the diff", JSON.stringify(buffer.conflict));

  await buffer.reload();
  check(buffer.content === "external" && !buffer.dirty && buffer.conflict === null, "reload: takes the workspace content");

  buffer.edit("mine");
  disk = { content: "other", version: "v-4" };
  await buffer.save("op-3");
  const overwritten = await buffer.overwrite("op-4");
  check(overwritten.status === "applied" && disk.content === "mine" && buffer.conflict === null, "overwrite: applies after conflict");
}

// 2. The same buffer over the real HTTP worker.
{
  const base = await mkdtemp(join(tmpdir(), "hns-editor-"));
  const root = join(base, "root");
  const connection = new Connection({ command: [localDaemon()] });
  const env = new LocalExecutionEnv({ cwd: root, connection });
  await env.createDir(root, undefined, ctx);
  await env.writeFile(join(root, "a.txt"), "hello", ctx);
  const app = await startServer({ env, root, journalPath: join(base, "journal.json"), webDir: import.meta.dirname });

  const html = await fetch(app.url + "/");
  check(html.status === 200 && (await html.text()).includes("hns editor"), "GET / serves the UI");

  const list = await (await fetch(app.url + "/list?path=.")).json();
  check(Array.isArray(list) && list.some((entry) => entry.path === "a.txt"), "GET /list lists files", JSON.stringify(list));

  const read = async (path) => (await fetch(app.url + "/read?path=" + encodeURIComponent(path))).json();
  const save = async (input) => (await fetch(app.url + "/write", { method: "POST", body: JSON.stringify(input) })).json();
  const buffer = new EditorBuffer({ read, save });
  await buffer.open("a.txt");
  buffer.edit("hello 2");
  check((await buffer.save("e1")).status === "applied", "HTTP save applies");
  check((await buffer.open("a.txt"), buffer.content === "hello 2"), "HTTP save persists");

  buffer.edit("local edit");
  await env.writeFile(join(root, "a.txt"), "from another process", ctx);
  const conflict = await buffer.save("e2");
  check(conflict.status === "conflict" && buffer.dirty, "HTTP conflict detected", JSON.stringify(conflict));
  check((await env.readTextFile(join(root, "a.txt"), ctx)).value === "from another process", "HTTP conflict did not overwrite");
  check(buffer.conflict?.external?.content === "from another process", "HTTP conflict carries the external content for the diff", JSON.stringify(buffer.conflict));

  await app.close();
  await env.cleanup?.(ctx);
  await connection.close();
  await rm(base, { recursive: true, force: true });
}

// 3. Static assets are served with a JS MIME type.
{
  const base = await mkdtemp(join(tmpdir(), "hns-editor2-"));
  const root = join(base, "root");
  const connection = new Connection({ command: [localDaemon()] });
  const env = new LocalExecutionEnv({ cwd: root, connection });
  await env.createDir(root, undefined, ctx);
  const app = await startServer({ env, root, journalPath: join(base, "journal.json"), webDir: import.meta.dirname });
  const response = await fetch(app.url + "/buffer.mjs");
  check(response.status === 200 && (response.headers.get("content-type") ?? "").includes("javascript"), "static .mjs served as JavaScript");
  await app.close();
  await connection.close();
  await rm(base, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;