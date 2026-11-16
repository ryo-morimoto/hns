import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitObjectId } from "../../src/objects.ts";
import type { GitObject } from "../../src/objects.ts";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";

const ROOT = resolve(import.meta.dirname, "../../../..");
const CF = join(ROOT, "node_modules", ".bin", "cf");
const WORK = join(ROOT, "tools", "deploy", ".work");
const TIMEOUT_MS = 240_000;
const READY_TIMEOUT_MS = 60_000;
const BUCKET = "hns-objects-test";

const CONFIG = [
  'import { bindings, defineConfig } from "cf/config";',
  "",
  "export default defineConfig({",
  "  worker: {",
  '    name: "hns-objects-test",',
  '    compatibilityDate: "2026-10-30",',
  '    compatibilityFlags: ["nodejs_compat"],',
  '    entrypoint: "worker.ts",',
  "    env: {",
  '      OBJECTS: bindings.r2({ name: "hns-objects-test" }),',
  "    },",
  "  },",
  "});",
  "",
].join("\n");

const WORKER = [
  "import {",
  "  getObject,",
  "  headObject,",
  "  listObjects,",
  "  objectKey,",
  "  putObject,",
  "  readCheckpointPack,",
  "  uploadCheckpointPack,",
  '} from "@hns/workspace/objects";',
  "",
  "export default {",
  "  async fetch(request, env) {",
  "    const path = new URL(request.url).pathname;",
  '    if (path === "/health") return new Response("ok");',
  '    if (path === "/objects" && request.method === "GET") {',
  "      return Response.json({ keys: await listObjects(env.OBJECTS) });",
  "    }",
  '    if (path === "/objects" && request.method === "POST") {',
  "      const content = new Uint8Array(await request.arrayBuffer());",
  '      const id = await putObject(env.OBJECTS, { type: "blob", content });',
  "      return Response.json({ id, key: objectKey(id) });",
  "    }",
  '    if (path.startsWith("/objects/")) {',
  '      const id = decodeURIComponent(path.slice("/objects/".length));',
  '      if (request.method === "HEAD") {',
  "        const head = await headObject(env.OBJECTS, id);",
  "        if (head === null) return new Response(null, { status: 404 });",
  "        return new Response(null, {",
  "          status: 200,",
  '          headers: { "x-object-size": String(head.size) },',
  "        });",
  "      }",
  "      const object = await getObject(env.OBJECTS, id);",
  "      if (object === null) return new Response(null, { status: 404 });",
  '      return new Response(object, { headers: { "content-type": "application/octet-stream" } });',
  "    }",
  '    if (path === "/packs" && request.method === "POST") {',
  "      const body = await request.json();",
  "      const objects = body.objects.map((object) => ({",
  "        type: object.type,",
  "        content: Uint8Array.from(atob(object.content), (char) => char.charCodeAt(0)),",
  "      }));",
  "      return Response.json(await uploadCheckpointPack(env.OBJECTS, objects));",
  "    }",
  '    if (path.startsWith("/packs/")) {',
  '      const commit = decodeURIComponent(path.slice("/packs/".length));',
  "      const pack = await readCheckpointPack(env.OBJECTS, commit);",
  "      if (pack === null) return new Response(null, { status: 404 });",
  '      return new Response(pack, { headers: { "content-type": "application/octet-stream" } });',
  "    }",
  '    return new Response("not found", { status: 404 });',
  "  },",
  "};",
  "",
].join("\n");

const Put = v.object({ id: v.string(), key: v.string() });
const Listed = v.object({ keys: v.array(v.string()) });
const Packed = v.object({ commit: v.string(), key: v.string(), uploaded: v.boolean() });

interface Running {
  readonly child: ChildProcess;
  readonly output: () => string;
}

let project: string | undefined;
let repo = "";
let running: Running | undefined;
let port = 0;

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = v.safeParse(
        v.object({ port: v.pipe(v.number(), v.integer()) }),
        server.address(),
      );
      if (!address.success) {
        server.close();
        reject(new Error("could not allocate a port"));
        return;
      }
      const selected = address.output.port;
      server.close(() => resolvePort(selected));
    });
  });
}

function build(): void {
  // Only this package: the server's integration tests build the packages they need, and two
  // concurrent builds of the same package race on tsdown's clean dist.
  execFileSync("npm", ["run", "build", "-w", "@hns/workspace"], {
    cwd: ROOT,
    stdio: "pipe",
    timeout: 120_000,
  });
}

async function writeProject(): Promise<string> {
  await mkdir(WORK, { recursive: true });
  const dir = await mkdtemp(join(WORK, "objects-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: BUCKET,
      private: true,
      type: "module",
      devDependencies: { wrangler: "4.156.0" },
    }),
  );
  // cf's local dev server is the Wrangler bundler; the test invokes only cf, never wrangler.
  await symlink(join("..", "..", "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "cloudflare.config.ts"), CONFIG);
  await writeFile(join(dir, "worker.ts"), WORKER);
  return dir;
}

async function collect(child: ChildProcess): Promise<Running> {
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { child, output: () => text };
}

async function health(target: Running): Promise<boolean> {
  if (target.child.exitCode !== null) {
    throw new Error("cf dev exited before becoming ready:\n" + target.output());
  }
  try {
    const response = await fetch("http://127.0.0.1:" + String(port) + "/health");
    return response.ok;
  } catch {
    return false;
  }
}

async function start(dir: string): Promise<Running> {
  const child = spawn(CF, ["dev", "--mode", "development", "--port", String(port)], {
    cwd: dir,
    detached: true,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_CACHE_HOME: join(dir, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const target = await collect(child);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await health(target)) return target;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await stop(target);
  throw new Error("cf dev did not become ready:\n" + target.output());
}

async function stop(target: Running | undefined): Promise<void> {
  const child = target?.child;
  if (child === undefined || child.pid === undefined || child.exitCode !== null) return;
  const pid = child.pid;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => resolveExit());
  });
  await Promise.race([
    exited,
    new Promise<void>((resolveTimeout) =>
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
        resolveTimeout();
      }, 5_000),
    ),
  ]);
}

const base = (): string => "http://127.0.0.1:" + String(port);

async function readJson<T>(response: Response, schema: v.GenericSchema<unknown, T>): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(200);
  return v.parse(schema, JSON.parse(text));
}

async function getBytes(path: string): Promise<{ status: number; bytes: Uint8Array }> {
  const response = await fetch(base() + path);
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}

const enc = new TextEncoder();

const rawBlob = (content: Uint8Array): Uint8Array => {
  const header = enc.encode("blob " + String(content.length) + "\0");
  const raw = new Uint8Array(header.length + content.length);
  raw.set(header, 0);
  raw.set(content, header.length);
  return raw;
};

const withDigest = (prefix: Uint8Array, id: string): Uint8Array => {
  const digest = Uint8Array.from(Buffer.from(id, "hex"));
  const content = new Uint8Array(prefix.length + digest.length);
  content.set(prefix, 0);
  content.set(digest, prefix.length);
  return content;
};

const git = (args: readonly string[], input?: Uint8Array): string => {
  const options = { cwd: repo, encoding: "utf8" as const };
  const stdout =
    input === undefined
      ? execFileSync("git", [...args], options)
      : execFileSync("git", [...args], { ...options, input });
  return String(stdout);
};

beforeAll(async () => {
  if (!existsSync(CF)) return;
  build();
  project = await writeProject();
  repo = await mkdtemp(join(tmpdir(), "hns-objects-git-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  port = await freePort();
  running = await start(project);
}, TIMEOUT_MS);

afterAll(async () => {
  await stop(running);
  running = undefined;
  if (project !== undefined) await rm(project, { recursive: true, force: true });
  if (repo.length > 0) await rm(repo, { recursive: true, force: true });
});

// Catches: an object store wired to the wrong binding, or a put that does not round-trip.
test.skipIf(!existsSync(CF))(
  "the R2 binding stores and lists blobs by object id",
  async () => {
    const content = enc.encode("hello from r2\n");
    const first = await readJson(
      await fetch(base() + "/objects", { method: "POST", body: content }),
      Put,
    );
    expect(first.id).toBe(await gitObjectId({ type: "blob", content }));
    expect(first.key).toBe("objects/" + first.id);
    const again = await readJson(
      await fetch(base() + "/objects", { method: "POST", body: content }),
      Put,
    );
    expect(again.id).toBe(first.id);

    const stored = await getBytes("/objects/" + first.id);
    expect(stored.status).toBe(200);
    expect(stored.bytes).toStrictEqual(rawBlob(content));

    const head = await fetch(base() + "/objects/" + first.id, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-object-size")).toBe(String(rawBlob(content).length));
    const missing = await fetch(base() + "/objects/" + "0".repeat(40), { method: "HEAD" });
    expect(missing.status).toBe(404);

    const listed = await readJson(await fetch(base() + "/objects"), Listed);
    expect(listed.keys).toStrictEqual([first.key]);
  },
  TIMEOUT_MS,
);

// Catches: a pack R2 stores but git cannot read, or a checkpoint that is not keyed by its commit.
test.skipIf(!existsSync(CF))(
  "a checkpoint pack from the R2 binding is readable by git",
  async () => {
    const fileContent = enc.encode("hello from the checkpoint\n");
    const blob: GitObject = { type: "blob", content: fileContent };
    const blobId = await gitObjectId(blob);
    const treeContent = withDigest(enc.encode("100644 hello.txt\0"), blobId);
    const tree: GitObject = { type: "tree", content: treeContent };
    const treeId = await gitObjectId(tree);
    const commitText = [
      "tree " + treeId,
      "author hns <hns@example.com> 1700000000 +0000",
      "committer hns <hns@example.com> 1700000000 +0000",
      "",
      "checkpoint",
      "",
    ].join("\n");
    const checkpoint: GitObject = { type: "commit", content: enc.encode(commitText) };
    const commitId = await gitObjectId(checkpoint);
    const body = JSON.stringify({
      objects: [blob, tree, checkpoint].map((object) => ({
        type: object.type,
        content: Buffer.from(object.content).toString("base64"),
      })),
    });

    const uploaded = await readJson(
      await fetch(base() + "/packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      Packed,
    );
    expect(uploaded).toStrictEqual({
      commit: commitId,
      key: "checkpoints/" + commitId + ".pack",
      uploaded: true,
    });
    const retried = await readJson(
      await fetch(base() + "/packs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      Packed,
    );
    expect(retried.uploaded).toBe(false);

    const pack = await getBytes("/packs/" + commitId);
    expect(pack.status).toBe(200);
    const packHash = git(["index-pack", "--stdin"], pack.bytes).trim();
    expect(packHash).toMatch(/^pack\t[0-9a-f]{40}$/u);

    expect(git(["cat-file", "-p", commitId])).toContain("tree " + treeId);
    expect(git(["cat-file", "-p", treeId])).toContain("100644 blob " + blobId + "\thello.txt");
    expect(git(["cat-file", "-p", blobId])).toBe("hello from the checkpoint\n");
    const reachable = git(["rev-list", "--objects", commitId]);
    expect(reachable).toContain(blobId + " hello.txt");
  },
  TIMEOUT_MS,
);
