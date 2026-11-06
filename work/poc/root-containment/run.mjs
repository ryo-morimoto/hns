// T-02: root containment, across local, daemon, and RemoteExecutionEnv.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { LocalExecutionEnv, RemoteExecutionEnv, Connection, localDaemon } from "@earendil-works/pi-env";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";

class Denied extends Error {}

function normalizeRelative(relativePath) {
  if (relativePath.length === 0) throw new Denied("empty path");
  if (relativePath.includes("\0")) throw new Denied("NUL byte");
  if (relativePath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relativePath)) throw new Denied("absolute path");
  const parts = relativePath.split(/[\\/]+/);
  if (parts.some((p) => p === "..")) throw new Denied("parent segment");
  return parts.filter((p) => p !== "" && p !== ".").join("/");
}

async function canonicalForWrite(env, absolutePath) {
  try { return getOrThrow(await env.canonicalPath(absolutePath, ctx)); }
  catch (error) {
    if (error?.code !== "not_found") throw error;
    const parent = getOrThrow(await env.joinPath([absolutePath, ".."], ctx));
    if (parent === absolutePath) throw new Denied("cannot resolve");
    const name = absolutePath.slice(parent.length + (parent.endsWith("/") ? 0 : 1));
    return getOrThrow(await env.joinPath([await canonicalForWrite(env, parent), name], ctx));
  }
}

async function resolveInRoot(env, root, relativePath) {
  const rel = normalizeRelative(relativePath);
  const canonicalRoot = getOrThrow(await env.canonicalPath(root, ctx));
  const absolute = getOrThrow(await env.joinPath([canonicalRoot, rel], ctx));
  const canonical = await canonicalForWrite(env, absolute);
  if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + sep)) throw new Denied("escapes root");
  return canonical;
}

const cases = [
  ["normal file", "inside.txt", "ok"],
  ["nested traversal", "../outside/secret.txt", "denied"],
  ["deep traversal", "a/b/../../outside/secret.txt", "denied"],
  ["absolute path", "ABSOLUTE", "denied"],
  ["symlink to file outside", "link-file.txt", "denied"],
  ["symlink dir outside", "link-dir/secret.txt", "denied"],
  ["dot-slash inside", "./inside.txt", "ok"],
];

async function runFor(name, makeEnv) {
  const dir = await mkdtemp(join(tmpdir(), "hns-root-"));
  const root = join(dir, "root");
  const outside = join(dir, "outside");
  await mkdir(root); await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await writeFile(join(root, "inside.txt"), "inside\n");
  await symlink(join(outside, "secret.txt"), join(root, "link-file.txt"));
  await symlink(outside, join(root, "link-dir"));

  const { env, close } = await makeEnv(root);
  let failed = 0;
  for (const [label, path, expected] of cases) {
    const target = path === "ABSOLUTE" ? join(outside, "secret.txt") : path;
    try {
      const resolved = await resolveInRoot(env, root, target);
      const content = getOrThrow(await env.readTextFile(resolved, ctx));
      const got = content.startsWith("inside") ? "ok" : "leaked";
      if (got !== expected) { failed++; console.log("FAIL", name, label, got); }
      else console.log("PASS", name, label, "(" + got + ")");
    } catch (error) {
      const got = error instanceof Denied ? "denied" : "error:" + (error?.code ?? error?.message);
      if (got !== expected) { failed++; console.log("FAIL", name, label, got); }
      else console.log("PASS", name, label, "(" + got + ")");
    }
  }
  await close();
  await rm(dir, { recursive: true, force: true });
  return { failed, total: cases.length };
}

const envs = [
  ["node", async (root) => ({ env: new NodeExecutionEnv({ cwd: root }), close: async () => {} })],
  ["local-daemon", async (root) => {
    const connection = new Connection({ command: [localDaemon()] });
    return { env: new LocalExecutionEnv({ cwd: root, connection }), close: () => connection.close() };
  }],
  ["remote-class", async (root) => {
    const connection = new Connection({ command: [localDaemon()] });
    return { env: new RemoteExecutionEnv({ connection, id: "remote:test", cwd: root }), close: () => connection.close() };
  }],
];

let failed = 0, total = 0;
for (const [name, makeEnv] of envs) {
  const result = await runFor(name, makeEnv);
  failed += result.failed; total += result.total;
}
console.log(`\n${total - failed}/${total} passed`);
process.exitCode = failed ? 1 : 0;
