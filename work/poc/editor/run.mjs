// Editor: buffer semantics (dirty, conflict, overwrite) and the HTTP path it uses.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { startServer } from "../walking-skeleton/server.mjs";
import { EditorBuffer } from "./buffer.mjs";
import { diffHunks, diffLines } from "./diff.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };

// 0. Line diff: no size cap, correct, and fast on large inputs.
{
  const same = diffLines("a\nb\nc", "a\nb\nc");
  check(same.ops.every((op) => op.type === "same") && same.added === 0 && same.removed === 0, "diff: identical");

  const changed = diffLines("a\nb\nc", "a\nB\nc");
  check(changed.ops.some((op) => op.type === "del" && op.text === "b") && changed.ops.some((op) => op.type === "add" && op.text === "B"), "diff: replaced line", JSON.stringify(changed.ops));

  const inserted = diffLines("a\nc", "a\nb\nc");
  check(inserted.added === 1 && inserted.removed === 0, "diff: insertion", JSON.stringify(inserted));
  const deleted = diffLines("a\nb\nc", "a\nc");
  check(deleted.removed === 1 && deleted.added === 0, "diff: deletion", JSON.stringify(deleted));

  // Reconstruction: reading the before/after back out of the ops must equal the inputs.
  const before = (ops) => ops.filter((op) => op.type !== "add").map((op) => op.text).join("\n");
  const after = (ops) => ops.filter((op) => op.type !== "del").map((op) => op.text).join("\n");
  let fuzzOk = true, seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const make = () => Array.from({ length: rand(40) }, () => "line" + rand(8)).join("\n");
    const a = make(), b = make();
    const result = diffLines(a, b);
    if (before(result.ops) !== a || after(result.ops) !== b) { fuzzOk = false; break; }
  }
  check(fuzzOk, "diff: 200 random cases reconstruct both sides");

  // A single edit in a 100k-line file: patience anchors keep the work local.
  const big = Array.from({ length: 100_000 }, (_, i) => "line " + i);
  const bigAfter = [...big];
  bigAfter[50_000] = "line 50000 changed";
  const started = performance.now();
  const bigResult = diffLines(big.join("\n"), bigAfter.join("\n"));
  const bigMs = performance.now() - started;
  check(bigResult.added === 1 && bigResult.removed === 1 && bigMs < 1_000, "diff: 100k lines with one edit", `${Math.round(bigMs)}ms, +${bigResult.added}/-${bigResult.removed}`);

  // Two unrelated 20k-line files: no alignment possible, but it must not refuse or hang.
  const left = Array.from({ length: 20_000 }, (_, i) => "a" + i);
  const right = Array.from({ length: 20_000 }, (_, i) => "b" + i);
  const wideStart = performance.now();
  const wide = diffLines(left.join("\n"), right.join("\n"));
  const wideMs = performance.now() - wideStart;
  check(wide.added === 20_000 && wide.removed === 20_000 && wideMs < 2_000, "diff: 20k vs 20k divergent", `${Math.round(wideMs)}ms`);

  // Hunks: long unchanged stretches collapse, the change keeps its context.
  const many = Array.from({ length: 2_000 }, (_, i) => "n" + i);
  const manyAfter = [...many];
  manyAfter[1_000] = "changed";
  const hunks = diffHunks(diffLines(many.join("\n"), manyAfter.join("\n")).ops, 3);
  const changedHunk = hunks.hunks.find((part) => part.type === "hunk" && part.ops.some((op) => op.type === "add"));
  const skipTotal = hunks.hunks.filter((part) => part.type === "skip").reduce((sum, part) => sum + part.count, 0);
  const contextOk = changedHunk !== undefined && changedHunk.ops.slice(0, 3).every((op) => op.type === "same") && changedHunk.ops.slice(-3).every((op) => op.type === "same");
  check(contextOk && changedHunk.ops.length === 8 && skipTotal === 1_993, "hunks: collapsed unchanged lines with 3 lines of context", JSON.stringify({ length: changedHunk?.ops.length, skipTotal }));
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