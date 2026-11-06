// Contract tests: the real server's responses must match packages/protocol.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as s from "../src/schemas.ts";
import { openapiDocument } from "../src/openapi.ts";

const serverPath = "../../../work/poc/app/server.mjs";
const { startApp } = (await import(serverPath)) as {
  startApp: (options: Record<string, unknown>) => Promise<{ url: string; close(): Promise<void> }>;
};

const base = await mkdtemp(join(tmpdir(), "hns-contract-"));
await mkdir(join(base, "state"));
await mkdir(join(base, "root"));
const app = await startApp({
  stateDir: join(base, "state"),
  root: join(base, "root"),
  provider: "faux",
  auth: false,
  fauxScript: [{ text: "contract" }],
  webDirs: [join(import.meta.dirname, "../../../work/poc/app/ui")],
});

const get = async (path: string) => {
  const response = await fetch(app.url + path);
  return { status: response.status, body: await response.json() };
};
const send = async (path: string, method: string, body: unknown) => {
  const response = await fetch(app.url + path, { method, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
};
const parse = <T>(schema: { parse(value: unknown): T }, value: unknown, label: string): T => {
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
  parse(s.Health, response.body, "health");
});

test("GET /api/state", async () => {
  const response = await get("/api/state");
  parse(s.State, response.body, "state");
});

test("projects, tasks and conversations", async () => {
  const project = await send("/api/projects", "POST", { name: "contract" });
  parse(s.Project, project.body, "project");
  const task = await send("/api/tasks", "POST", { projectId: project.body.id, title: "t" });
  parse(s.Task, task.body, "task");
  const updated = await send("/api/tasks/" + task.body.id, "PATCH", { status: "doing" });
  parse(s.Task, updated.body, "task update");
  const conversation = await send("/api/conversations", "POST", { projectId: project.body.id, title: "c" });
  parse(s.Conversation, conversation.body, "conversation");
  const list = await get("/api/conversations");
  assert.equal(list.status, 200);
  list.body.forEach((entry: unknown) => parse(s.Conversation, entry, "conversation list"));
});

test("chat and file writes", async () => {
  const chat = await send("/api/chat", "POST", { message: "hello" });
  assert.equal(chat.status, 202);
  parse(s.ChatResponse, chat.body, "chat");

  const write = await send("/api/file", "PUT", { path: "a.txt", content: "x", expectedVersion: "absent", operationId: "c1" });
  assert.equal(write.status, 200);
  parse(s.MutationResult, write.body, "write");

  const read = await get("/api/file?path=a.txt");
  parse(s.FileRead, read.body, "read");

  const conflict = await send("/api/file", "PUT", { path: "a.txt", content: "y", expectedVersion: "absent", operationId: "c2" });
  assert.equal(conflict.status, 409);
  parse(s.MutationResult, conflict.body, "conflict");
});

test("observability endpoints", async () => {
  const events = await get("/api/events?limit=50");
  events.body.forEach((entry: unknown) => parse(s.Event, entry, "event"));
  const metrics = await get("/api/metrics");
  parse(s.Metrics, metrics.body, "metrics");
  const usage = await get("/api/usage");
  parse(s.Usage, usage.body, "usage");
});

test("the OpenAPI document covers the routes", () => {
  const document = openapiDocument();
  const paths = Object.keys(document.paths);
  assert.ok(paths.includes("/api/health"));
  assert.ok(paths.includes("/api/chat"));
  assert.ok(paths.includes("/api/conversations/{id}"));
  const operations = Object.values(document.paths).reduce((sum, operationsForPath) => sum + Object.keys(operationsForPath as object).length, 0);
  assert.ok(operations >= 15, "expected at least 15 documented operations, got " + operations);
});