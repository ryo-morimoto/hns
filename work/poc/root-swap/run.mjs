// T-02: root identity, replacement, symlink repoint, and a parent swap during a write.
import { mkdir, mkdtemp, rename, rm, symlink, unlink } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Denied, Workspace } from "../workspace-core/workspace.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };
const denies = async (fn, reason) => { try { await fn(); return false; } catch (e) { return e instanceof Denied && (!reason || e.message === reason); } };

const base = await mkdtemp(join(tmpdir(), "hns-swap-"));
const root = join(base, "root");
const connection = new Connection({ command: [localDaemon()] });
const env = new LocalExecutionEnv({ cwd: base, connection });
await env.createDir(root, undefined, ctx);
const open = (extra = {}) => new Workspace({ env, root, journalPath: join(base, "journal.json"), context: ctx, ...extra }).open();

// 1. Root renamed while open.
{
  const ws = await open();
  const v = (await ws.write({ path: "a.txt", content: "one", expectedVersion: "absent", operationId: "s1" })).version;
  await rename(root, root + "-old");
  check(await denies(() => ws.read("a.txt")), "renamed root: read denied");
  check(await denies(() => ws.write({ path: "a.txt", content: "two", expectedVersion: v, operationId: "s2" })), "renamed root: write denied");
  check(ws.auditLog.filter((a) => a.denied).length >= 2, "renamed root: audited");
  check(getOrThrow(await env.exists(root, ctx)) === false, "renamed root: not recreated");
  await rename(root + "-old", root);
}

// 2. Root replaced by a different directory at the same path.
{
  const ws = await open();
  await rm(root, { recursive: true });
  await mkdir(root);
  const reopened = await open().then(() => undefined, (e) => e);
  check(reopened instanceof Denied, "replaced root: open denied", String(reopened));
  const raced = await ws.write({ path: "b.txt", content: "new", expectedVersion: "absent", operationId: "s3" }).then(() => undefined, (e) => e);
  check(raced instanceof Denied, "replaced root: write denied");
  check(!readdirSync(root).includes("b.txt"), "replaced root: nothing written");
}

// 3. Marker tampered with.
{
  await env.writeFile(join(root, ".hns/root.json"), JSON.stringify({ id: "someone-else" }), ctx);
  const tampered = await open().then(() => undefined, (e) => e);
  check(tampered instanceof Denied, "tampered marker: open denied", String(tampered));
}

// 4. Parent directory swapped to a symlink between the checks and the rename.
{
  const fresh = await mkdtemp(join(tmpdir(), "hns-race-"));
  const r = join(fresh, "root");
  const outside = join(fresh, "outside");
  await env.createDir(join(r, "d"), { recursive: true }, ctx);
  await env.createDir(outside, undefined, ctx);
  const ws = await new Workspace({
    env, root: r, journalPath: join(fresh, "journal.json"), context: ctx,
    beforeRename: async () => {
      await rename(join(r, "d"), join(r, "d-old"));
      await symlink(outside, join(r, "d"));
    },
  }).open();
  const result = await ws.write({ path: "d/f.txt", content: "x", expectedVersion: "absent", operationId: "race" });
  check(result.status === "unknown", "parent swap: unknown", JSON.stringify(result));
  check(!readdirSync(outside).includes("f.txt"), "parent swap: nothing escaped");
  await rm(fresh, { recursive: true, force: true });
}

// 5. Root is a symlink that is repointed.
{
  const targetA = join(base, "target-a");
  const targetB = join(base, "target-b");
  const link = join(base, "link-root");
  await env.createDir(targetA, undefined, ctx); await env.createDir(targetB, undefined, ctx);
  await env.writeFile(join(targetA, "x.txt"), "A", ctx);
  await env.writeFile(join(targetB, "x.txt"), "B", ctx);
  await symlink(targetA, link);
  const ws = await new Workspace({ env, root: link, journalPath: join(base, "journal-link.json"), context: ctx }).open();
  await unlink(link);
  await symlink(targetB, link);
  const read = await ws.read("x.txt");
  check(read.content === "A", "repointed symlink: still reads the original target");
  check((await env.readTextFile(join(targetB, "x.txt"), ctx)).value === "B", "repointed symlink: new target untouched");
}

await env.cleanup?.(ctx);
await connection.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;