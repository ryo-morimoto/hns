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
  "interface Env {",
  "  readonly SESSION: {",
  "    idFromName(name: string): unknown;",
  "    get(id: unknown): { fetch(request: Request): Promise<Response> };",
  "  };",
  "}",
  "",
  "export { Session };",
  "",
  "export default {",
  "  async fetch(request: Request, env: Env): Promise<Response> {",
  "    const url = new URL(request.url);",
  '    if (url.pathname === "/health") return new Response("ok");',
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

async function start(dir: string, port: number): Promise<Running> {
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
    if (await health(port, target)) return target;
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
  if (project !== undefined) await rm(project, { recursive: true, force: true });
});

test.skipIf(!existsSync(CF))(
  "the Session DO serves conversations and survives a cf dev restart",
  async () => {
    project = await writeProject();
    const firstPort = await freePort();
    running = await start(project, firstPort);
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
      const secondPort = await freePort();
      running = await start(project, secondPort);
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
    const port = await freePort();
    running = await start(project, port);
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

// Catches: the production edge dropping the upgrade while forwarding to the Session DO.
test.skipIf(!existsSync(CF) || !HAS_WEBSOCKET)(
  "the production edge authenticates and forwards a live WebSocket",
  async () => {
    project = await writeProject();
    const port = await freePort();
    running = await start(project, port);
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
