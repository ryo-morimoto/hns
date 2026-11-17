import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as v from "valibot";
import { signSession } from "../../src/edge/session.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const CF = join(ROOT, "node_modules", ".bin", "cf");
const WORK = join(ROOT, "tools", "deploy", ".work");
const TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 40_000;

const CONFIG = [
  'import { bindings, defineConfig, exports } from "cf/config";',
  "",
  "export default defineConfig({",
  "  worker: {",
  '    name: "hns-session-do-test",',
  '    compatibilityDate: "2026-10-30",',
  '    compatibilityFlags: ["nodejs_compat"],',
  '    entrypoint: "worker.ts",',
  '    exports: { Session: exports.durableObject({ storage: "sqlite" }) },',
  "    env: {",
  '      SESSION: bindings.durableObject({ worker: "hns-session-do-test", exportName: "Session" }),',
  '      DB: bindings.d1({ name: "hns-session-do-test" }),',
  '      HNS_ENV: bindings.text("dev"),',
  '      HNS_MODEL: bindings.text("faux/echo"),',
  '      HNS_SESSION_SECRET: bindings.text("test-secret-0123456789abcdef0123456789"),',
  "    },",
  "  },",
  "});",
  "",
].join("\n");

const WORKER = [
  'import worker, { Session } from "@hns/server";',
  "",
  "interface Statement {",
  "  all(): Promise<{ readonly results: readonly unknown[] }>;",
  "  run(): Promise<unknown>;",
  "}",
  "",
  "interface Env {",
  "  readonly SESSION: {",
  "    idFromName(name: string): unknown;",
  "    get(id: unknown): { fetch(request: Request): Promise<Response> };",
  "  };",
  "  readonly DB: { prepare(sql: string): Statement; exec(sql: string): Promise<unknown> };",
  "}",
  "",
  "export { Session };",
  "",
  "export default {",
  "  async fetch(request: Request, env: Env): Promise<Response> {",
  "    const url = new URL(request.url);",
  '    if (url.pathname === "/health") return new Response("ok");',
  '    if (url.pathname === "/d1") {',
  '      const rows = await env.DB.prepare("SELECT project_id, id, title, indexed_at FROM conversations ORDER BY id").all();',
  "      const state = await env.DB.prepare(\"SELECT pending, last_error_code FROM index_state WHERE workspace_id = 'default'\").all();",
  "      return Response.json({ rows: rows.results, state: state.results });",
  "    }",
  '    if (url.pathname === "/old-schema") {',
  "      await env.DB.exec(\"CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT, archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), deleted_at TEXT); INSERT INTO projects (id, name, created_at) VALUES ('default', 'default', '2026-01-01T00:00:00.000Z'); INSERT INTO conversations (id, project_id, title, created_at) VALUES ('7', 'default', 'legacy', '2026-01-01T00:00:00.000Z');\");",
  "      return Response.json({ ok: true });",
  "    }",
  '    if (url.pathname === "/seed") {',
  "      await env.DB.prepare(\"INSERT OR IGNORE INTO projects (id, name, created_at, workspace_root, egress) VALUES ('default', 'default', '2026-01-01T00:00:00.000Z', '', 'inherit')\").run();",
  "      return Response.json({ ok: true });",
  "    }",
  '    if (url.pathname.startsWith("/t/")) {',
  '      const forwarded = new Request("https://session" + url.pathname.slice(2) + url.search, request);',
  '      return env.SESSION.get(env.SESSION.idFromName("default")).fetch(forwarded);',
  "    }",
  '    if (url.pathname === "/ws") {',
  '      const cookie = url.searchParams.get("cookie");',
  "      const headers = new Headers(request.headers);",
  '      if (cookie !== null) headers.set("cookie", cookie);',
  "      return worker.fetch(new Request(request, { headers }), env);",
  "    }",
  '    return new Response("not found", { status: 404 });',
  "  },",
  "};",
  "",
].join("\n");

interface Running {
  readonly child: ChildProcess;
  readonly output: () => string;
  /** The HTTP port this attempt settled on; a retry may move it. */
  readonly port: number;
}

const HAS_WEBSOCKET = "WebSocket" in globalThis;

/** Reads WebSocket text frames in order, buffering ones that arrive before next() is called. */
interface FrameReader {
  next(): Promise<JsonValue>;
}

function frameReader(socket: WebSocket): FrameReader {
  const buffered: JsonValue[] = [];
  const waiting: ((value: JsonValue) => void)[] = [];
  socket.addEventListener("message", (event) => {
    // SAFETY: the live protocol is text frames; the Session sends no binary frame.
    const value: JsonValue = JSON.parse(event.data as string);
    const resolve = waiting.shift();
    if (resolve === undefined) buffered.push(value);
    else resolve(value);
  });
  return {
    next: () => {
      const next = buffered.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise((resolveFrame) => {
        waiting.push(resolveFrame);
      });
    },
  };
}

/** Reject when a frame does not arrive; a hung socket is a failure, not a long test. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for " + label)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function openSocket(port: number, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:" + String(port) + path);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("the WebSocket did not open: " + path)),
      { once: true },
    );
  });
}

let project: string | undefined;
let running: Running | undefined;
const projects: string[] = [];

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
      const port = address.output.port;
      server.close(() => resolvePort(port));
    });
  });
}

function build(): void {
  if (!existsSync(CF)) return;
  for (const name of ["@hns/core", "@hns/agent", "@hns/server"]) {
    execFileSync("npm", ["run", "build", "-w", name], {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 90_000,
    });
  }
}

async function writeProject(): Promise<string> {
  await mkdir(WORK, { recursive: true });
  const dir = await mkdtemp(join(WORK, "session-do-"));
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "hns-session-do-test",
      private: true,
      type: "module",
      devDependencies: { wrangler: "4.156.0" },
    }),
  );
  // cf's local dev server is the Wrangler bundler; the test invokes only cf, never wrangler.
  await symlink(join("..", "..", "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "cloudflare.config.ts"), CONFIG);
  await writeFile(join(dir, "worker.ts"), WORKER);
  projects.push(dir);
  return dir;
}

async function collect(
  child: ChildProcess,
): Promise<{ readonly child: ChildProcess; readonly output: () => string }> {
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { child, output: () => text };
}

async function health(port: number, target: Running): Promise<boolean> {
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

/**
 * Start cf dev on a fresh port.
 *
 * @remarks
 * Two shared addresses can make cf dev exit during startup: the HTTP port taken between the
 * probe and the bind, and the debug inspector, which wrangler fixes at 9229 for every instance.
 * The other integration suites run their own dev servers beside this one, so either can be
 * lost. That is a lost shared resource, not a product failure: retry on a fresh port.
 */
async function start(dir: string): Promise<Running> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const port = await freePort();
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
    const target: Running = { ...(await collect(child)), port };
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        if (await health(port, target)) {
          ready = true;
          break;
        }
      } catch {
        // The child exited during startup; let the retry take a fresh port.
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (ready) return target;
    await stop(target);
    if (attempt === 2) throw new Error("cf dev did not become ready:\n" + target.output());
  }
  throw new Error("cf dev did not become ready");
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

async function call<T>(
  port: number,
  method: "GET" | "POST",
  path: string,
  schema: v.GenericSchema<unknown, T>,
  body?: JsonValue,
): Promise<T> {
  const init =
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch("http://127.0.0.1:" + String(port) + path, init);
  const text = await response.text();
  expect(response.status, text).toBeLessThan(300);
  return v.parse(schema, JSON.parse(text));
}

const Create = v.object({
  ok: v.literal(true),
  conversation: v.object({ id: v.string(), title: v.string() }),
});
const List = v.object({
  ok: v.literal(true),
  conversations: v.array(v.object({ id: v.string(), title: v.string() })),
});
const Send = v.object({
  ok: v.literal(true),
  status: v.string(),
  text: v.string(),
});
const Transcript = v.object({
  ok: v.literal(true),
  entries: v.array(v.object({ kind: v.string() })),
});
const Seeded = v.object({ ok: v.literal(true) });
const IndexDump = v.object({
  rows: v.array(
    v.object({
      project_id: v.string(),
      id: v.string(),
      title: v.string(),
      indexed_at: v.nullable(v.string()),
    }),
  ),
  state: v.array(v.object({ pending: v.number(), last_error_code: v.nullable(v.string()) })),
});
const Snapshot = v.object({
  type: v.literal("snapshot"),
  protocol: v.literal(1),
  cursor: v.string(),
  conversationId: v.string(),
  entries: v.array(v.object({ id: v.string(), kind: v.string(), text: v.string() })),
});

beforeAll(() => {
  build();
});

afterAll(async () => {
  await stop(running);
  running = undefined;
  for (const dir of projects) await rm(dir, { recursive: true, force: true });
});

test.skipIf(!existsSync(CF))(
  "the Session DO serves conversations and survives a cf dev restart",
  async () => {
    project = await writeProject();
    running = await start(project);
    const firstPort = running.port;
    expect(existsSync(join(project, "config"))).toBe(true);
    try {
      const bad = await fetch("http://127.0.0.1:" + String(firstPort) + "/t/rpc/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(bad.status).toBe(400);
      const created = await call(firstPort, "POST", "/t/rpc/conversations", Create, {
        title: "CF",
      });
      const id = created.conversation.id;
      const missing = await fetch(
        "http://127.0.0.1:" + String(firstPort) + "/t/rpc/conversations/999999",
      );
      expect(missing.status).toBe(404);
      const sent = await call(firstPort, "POST", "/t/rpc/conversations/" + id + "/messages", Send, {
        text: "hi",
      });
      expect(sent.status).toBe("done");
      expect(sent.text).toBe("faux response");
      const list = await call(firstPort, "GET", "/t/rpc/conversations", List);
      expect(list.conversations.map((item) => item.title)).toStrictEqual(["CF"]);
      const entries = await call(
        firstPort,
        "GET",
        "/t/rpc/conversations/" + id + "/transcript",
        Transcript,
      );
      expect(entries.entries.map((entry) => entry.kind)).toContain("pi.assistant");

      await stop(running);
      running = undefined;
      running = await start(project);
      const secondPort = running.port;
      const reopened = await call(secondPort, "GET", "/t/rpc/conversations", List);
      expect(reopened.conversations.map((item) => item.title)).toStrictEqual(["CF"]);
      const transcript = await call(
        secondPort,
        "GET",
        "/t/rpc/conversations/" + id + "/transcript",
        Transcript,
      );
      expect(transcript.entries.map((entry) => entry.kind)).toContain("pi.assistant");
    } finally {
      await stop(running);
      running = undefined;
    }
  },
  TIMEOUT_MS,
);
test.skipIf(!existsSync(CF) || !HAS_WEBSOCKET)(
  "the Session DO upgrades /ws and keeps a conversation live across reconnect",
  async () => {
    project = await writeProject();
    running = await start(project);
    const port = running.port;
    try {
      const created = await call(port, "POST", "/t/rpc/conversations", Create, { title: "WS" });
      const id = created.conversation.id;

      const socket = await openSocket(port, "/t/ws?conversationId=" + id);
      const frames = frameReader(socket);
      const first = v.parse(
        Snapshot,
        await withTimeout(frames.next(), 10_000, "the first snapshot"),
      );
      expect(first.cursor).toBe("0");
      expect(first.conversationId).toBe(id);
      expect(first.entries).toStrictEqual([]);

      socket.send(JSON.stringify({ type: "ping" }));
      expect(await withTimeout(frames.next(), 10_000, "pong")).toStrictEqual({
        type: "pong",
        protocol: 1,
      });

      const sent = await call(port, "POST", "/t/rpc/conversations/" + id + "/messages", Send, {
        text: "hi",
      });
      expect(sent.status).toBe("done");

      let assistantAppended = false;
      for (let index = 0; index < 100; index += 1) {
        const frame = v.parse(
          v.object({
            type: v.string(),
            entries: v.optional(v.array(v.object({ kind: v.string() }))),
          }),
          await withTimeout(frames.next(), 10_000, "a frame after send"),
        );
        if (
          frame.type === "append" &&
          (frame.entries ?? []).some((entry) => entry.kind === "pi.assistant")
        ) {
          assistantAppended = true;
          break;
        }
      }
      expect(assistantAppended).toBe(true);
      socket.close();

      // Commit while disconnected; the reconnect snapshot must include it.
      const again = await call(port, "POST", "/t/rpc/conversations/" + id + "/messages", Send, {
        text: "again",
      });
      expect(again.status).toBe("done");

      const reconnect = await openSocket(port, "/t/ws?conversationId=" + id + "&cursor=0");
      const reopened = v.parse(
        Snapshot,
        await withTimeout(frameReader(reconnect).next(), 10_000, "the reconnect snapshot"),
      );
      expect(reopened.cursor).not.toBe("0");
      expect(reopened.entries.filter((entry) => entry.kind === "pi.assistant")).toHaveLength(2);
      reconnect.close();
    } finally {
      await stop(running);
      running = undefined;
    }
  },
  TIMEOUT_MS,
);

// Catches: an index write that never reaches D1, or a failed write that is never retried.
test.skipIf(!existsSync(CF))(
  "the Session DO writes the conversation index into D1 and retries after a failure",
  async () => {
    project = await writeProject();
    running = await start(project);
    const port = running.port;
    try {
      const created = await call(port, "POST", "/t/rpc/conversations", Create, {
        title: "Indexed",
      });
      const id = created.conversation.id;
      // The object migrated D1 on open. A deployment seeds the project row from the edge; here
      // nothing has, so the first index write fails its foreign key and stays dirty.
      const before = await call(port, "GET", "/d1", IndexDump);
      expect(before.rows).toStrictEqual([]);
      expect(before.state).toStrictEqual([{ pending: 1, last_error_code: "d1_write_failed" }]);

      await call(port, "POST", "/seed", Seeded);
      await call(port, "POST", "/t/rpc/conversations/" + id + "/messages", Send, { text: "hi" });

      const after = await call(port, "GET", "/d1", IndexDump);
      expect(after.rows).toStrictEqual([
        { project_id: "default", id, title: "Indexed", indexed_at: expect.any(String) },
      ]);
      expect(after.state).toStrictEqual([{ pending: 0, last_error_code: null }]);
    } finally {
      await stop(running);
      running = undefined;
    }
  },
  TIMEOUT_MS,
);

// Catches: the index migration losing a conversation written under the old single-column key.
test.skipIf(!existsSync(CF))(
  "the index migration rebuilds a database created with the old conversations key",
  async () => {
    project = await writeProject();
    running = await start(project);
    const port = running.port;
    try {
      await call(port, "POST", "/old-schema", Seeded);
      const created = await call(port, "POST", "/t/rpc/conversations", Create, {
        title: "After",
      });
      const id = created.conversation.id;
      const dump = await call(port, "GET", "/d1", IndexDump);
      expect(dump.rows).toStrictEqual([
        { project_id: "default", id, title: "After", indexed_at: expect.any(String) },
        { project_id: "default", id: "7", title: "legacy", indexed_at: null },
      ]);
    } finally {
      await stop(running);
      running = undefined;
    }
  },
  TIMEOUT_MS,
);

// Catches: the production edge dropping the upgrade while forwarding to the Session DO.
test.skipIf(!existsSync(CF) || !HAS_WEBSOCKET)(
  "the production edge authenticates and forwards a live WebSocket",
  async () => {
    project = await writeProject();
    running = await start(project);
    const port = running.port;
    try {
      const created = await call(port, "POST", "/t/rpc/conversations", Create, { title: "Edge" });
      const id = created.conversation.id;
      const cookie =
        "hns_session=" +
        (await signSession("test-secret-0123456789abcdef0123456789", {
          subject: "owner",
          expiresAt: Date.now() + 60_000,
        }));
      // A browser sends the cookie as a header; the test Worker reads this query and injects it,
      // so the edge's authentication runs on the real upgrade request.
      let socket: WebSocket;
      try {
        socket = await openSocket(
          port,
          "/ws?conversationId=" + id + "&cookie=" + encodeURIComponent(cookie),
        );
      } catch (error) {
        throw new Error(String(error) + "\ncf dev output:\n" + (running?.output() ?? ""));
      }
      const first = v.parse(
        Snapshot,
        await withTimeout(frameReader(socket).next(), 10_000, "the edge snapshot"),
      );
      expect(first.conversationId).toBe(id);
      expect(first.cursor).toBe("0");
      socket.close();
    } finally {
      await stop(running);
      running = undefined;
    }
  },
  TIMEOUT_MS,
);
