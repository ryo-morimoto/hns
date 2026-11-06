// Contract tests: the real server's responses must match packages/protocol.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "../src/validation.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type AppOptions = {
  stateDir: string;
  root: string;
  provider: string;
  auth: boolean;
  fauxScript: Array<{ text: string }>;
  webDirs: string[];
};

const serverPath = "../../../work/poc/app/server.mjs";

// SAFETY: the app is plain JS without declarations; the response tests below check every shape.
const { startApp } = (await import(serverPath)) as {
  startApp: (options: AppOptions) => Promise<{ url: string; close(): Promise<void> }>;
};

const base = await mkdtemp(join(tmpdir(), "hns-api-"));

await mkdir(join(base, "state"));

await mkdir(join(base, "root"));

const app = await startApp({
  stateDir: join(base, "state"),
  root: join(base, "root"),
  provider: "faux",
  auth: false,
  fauxScript: [{ text: "ok" }],
  webDirs: [join(import.meta.dirname, "../../../work/poc/app/ui")],
});

const get = async (path: string) => {
  const response = await fetch(app.url + path);

  // SAFETY: the response body is validated by a protocol schema right after this call.
  return { status: response.status, body: (await response.json()) as Json };
};

const send = async (path: string, method: string, body: Json) => {
  const response = await fetch(app.url + path, { method, body: JSON.stringify(body) });

  // SAFETY: the response body is validated by a protocol schema right after this call.
  return { status: response.status, body: (await response.json()) as Json };
};

const parse = <T>(schema: { parse(value: Json): T }, value: Json, label: string): T => {
  try {
    return schema.parse(value);
  } catch (error) {
    assert.fail(label + ": " + String(error instanceof Error ? error.message : error));
  }
};

after(async () => {
  await app.close();
  await rm(base, { recursive: true, force: true });
});

test("GET /api/health", async () => {
  const response = await get("/api/health");

  assert.equal(response.status, 200);
  parse(v.HealthSchema, response.body, "health");
});

test("GET /api/state", async () => {
  const response = await get("/api/state");

  parse(v.StateSchema, response.body, "state");
});

test("projects, tasks and conversations", async () => {
  const project = await send("/api/projects", "POST", { name: "api-check" });

  parse(v.ProjectSchema, project.body, "project");
  const projectBody = parse(v.ProjectSchema, project.body, "project id");
  const task = await send("/api/tasks", "POST", { projectId: projectBody.id, title: "t" });

  parse(v.TaskSchema, task.body, "task");
  const taskBody = parse(v.TaskSchema, task.body, "task id");
  const updated = await send("/api/tasks/" + taskBody.id, "PATCH", { status: "doing" });

  parse(v.TaskSchema, updated.body, "task update");
  const conversation = await send("/api/conversations", "POST", {
    projectId: projectBody.id,
    title: "c",
  });

  parse(v.ConversationSchema, conversation.body, "conversation");
  const list = await get("/api/conversations");

  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));

  for (const entry of list.body) {
    parse(v.ConversationSchema, entry, "conversation list");
  }
});

test("chat and file writes", async () => {
  const chat = await send("/api/chat", "POST", { message: "hello" });

  assert.equal(chat.status, 202);
  parse(v.ChatResponseSchema, chat.body, "chat");
  const write = await send("/api/file", "PUT", {
    path: "a.txt",
    content: "x",
    expectedVersion: "absent",
    operationId: "c1",
  });

  assert.equal(write.status, 200);
  parse(v.MutationResultSchema, write.body, "write");
  const read = await get("/api/file?path=a.txt");

  parse(v.FileReadSchema, read.body, "read");
  const conflict = await send("/api/file", "PUT", {
    path: "a.txt",
    content: "y",
    expectedVersion: "absent",
    operationId: "c2",
  });

  assert.equal(conflict.status, 409);
  parse(v.MutationResultSchema, conflict.body, "conflict");
});

test("observability endpoints", async () => {
  const events = await get("/api/events?limit=50");

  assert.ok(Array.isArray(events.body));

  for (const entry of events.body) {
    parse(v.EventSchema, entry, "event");
  }

  const metrics = await get("/api/metrics");

  parse(v.MetricsSchema, metrics.body, "metrics");
  const usage = await get("/api/usage");

  parse(v.UsageSchema, usage.body, "usage");
});
