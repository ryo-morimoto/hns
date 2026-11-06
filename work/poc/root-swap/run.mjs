// T-02: what happens when the root is renamed, replaced, or its symlink is repointed.
import { mkdir, mkdtemp, rename, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Denied, Workspace } from "../workspace-core/workspace.mjs";

let pass = 0, fail = 0;
const check = (ok, name, detail) => { ok ? pass++ : fail++; console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail ?? ""); };
const throwsDenied = async (fn) => { try { await fn(); return false; } catch (e) { return e instanceof Denied; } };

const base = await mkdtemp(join(tmpdir(), "hns-swap-"));
const root = join(base, "root");
const connection = new Connection({ command: [localDaemon()] });
const env = new LocalExecutionEnv({ cwd: base, connection });
await env.createDir(root, undefined, ctx);
const open = () => new Workspace({ env, root, journalPath: join(base, "journal.json"), context: ctx }).open();

// 1. Root renamed while open.
{
  const ws = await open();
  const v = (await ws.write({ path: "a.txt", content: "one", expectedVersion: "absent", operationId: "s1" })).version;
  await rename(root, root + "-old");
  check(await throwsDenied(() => ws.read("a.txt")), "renamed root: read denied");
  check(await throwsDenied(() => ws.write({ path: "a.txt", content: "two", expectedVersion: v, operationId: "s2" })), "renamed root: write denied");
  check(ws.auditLog.filter((a) => a.denied).length >= 2, "renamed root: audited", JSON.stringify(ws.auditLog));
  const recreated = await env.exists(root, ctx).then((r) => r.value);
  check(recreated === false, "renamed root: not recreated by the denied write");
  await rename(root + "-old", root);
}

// 2. Root replaced by a different directory at the same path.
{
  const ws = await open();
  await rm(root, { recursive: true });
  await mkdir(root);
  const result = await ws.write({ path: "b.txt", content: "new", expectedVersion: "absent", operationId: "s3" });
  check(result.status === "applied", "replaced root: write succeeds (undetected)", JSON.stringify(result));
}

// 3. Root is a symlink that is repointed.
{
  const targetA = join(base, "target-a");
  const targetB = join(base, "target-b");
  const link = join(base, "link-root");
  await mkdir(targetA); await mkdir(targetB);
  await env.writeFile(join(targetA, "x.txt"), "A", ctx);
  await env.writeFile(join(targetB, "x.txt"), "B", ctx);
  await symlink(targetA, link);
  const ws = await new Workspace({ env, root: link, journalPath: join(base, "journal-link.json"), context: ctx }).open();
  await unlink(link);
  await symlink(targetB, link);
  const read = await ws.read("x.txt");
  check(read.content === "A", "repointed symlink: still reads the original target", read.content);
  check((await env.readTextFile(join(targetB, "x.txt"), ctx)).value === "B", "repointed symlink: new target untouched");
}

await env.cleanup?.(ctx);
await connection.close();
await rm(base, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} passed`);
process.exitCode = fail ? 1 : 0;
