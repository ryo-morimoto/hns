import { expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@hns/core";
import { parseConversation, parseEvent, parseProject, parseTask } from "../src/parse.ts";

const projectRow = { id: "p1", name: "hns", created_at: "2026-11-07T00:00:00.000Z" };
const conversationRow = {
  id: "c1",
  project_id: "p1",
  title: "first",
  created_at: "2026-11-07T00:00:00.000Z",
  updated_at: null,
  archived: 0,
  deleted_at: null,
};
const taskRow = {
  id: "t1",
  project_id: "p1",
  title: "task",
  status: "doing",
  created_at: "2026-11-07T00:00:00.000Z",
  updated_at: "2026-11-07T00:01:00.000Z",
};
const eventRow = {
  id: "e1",
  at: "2026-11-07T00:00:00.000Z",
  level: "info",
  event: "chat.submitted",
  request_id: null,
  conversation_id: "c1",
  status: 202,
  duration_ms: 12,
  detail: '{"a":1}',
};

test("a project row parses into the public model", () => {
  expect(parseProject(projectRow)).toStrictEqual({
    id: "p1",
    name: "hns",
    created_at: "2026-11-07T00:00:00.000Z",
  });
});

test("archived 0/1 becomes a boolean", () => {
  expect(parseConversation(conversationRow).archived).toBe(false);
  expect(parseConversation({ ...conversationRow, archived: 1 }).archived).toBe(true);
});

test("an unknown archived flag is rejected", () => {
  expect(() => parseConversation({ ...conversationRow, archived: 2 })).toThrow();
});

test("null timestamps stay null", () => {
  const conversation = parseConversation(conversationRow);

  expect(conversation.updated_at).toBe(null);
  expect(conversation.deleted_at).toBe(null);
});

test("a missing field is rejected", () => {
  expect(() => parseProject({ id: "p1", created_at: "2026-11-07T00:00:00.000Z" })).toThrow();
});

test("a task row keeps its status", () => {
  expect(parseTask(taskRow).status).toBe("doing");
});

test("an unknown task status fails loudly", () => {
  expect(() => parseTask({ ...taskRow, status: "paused" })).toThrow();
});

test("event detail is parsed from JSON", () => {
  expect(parseEvent(eventRow).detail).toStrictEqual({ a: 1 });
});

test("a null event detail stays null", () => {
  expect(parseEvent({ ...eventRow, detail: null }).detail).toBe(null);
});

test("a broken event detail fails loudly", () => {
  expect(() => parseEvent({ ...eventRow, detail: "{" })).toThrow();
});

test("an unknown event level fails loudly", () => {
  expect(() => parseEvent({ ...eventRow, level: "debug" })).toThrow();
});

test("rows read from a real SQLite database parse", () => {
  const db = new DatabaseSync(":memory:");

  db.exec(
    "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)",
  );
  db.exec(
    "CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT, archived INTEGER NOT NULL DEFAULT 0, deleted_at TEXT)",
  );
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)").run(
    "p1",
    "hns",
    "2026-11-07T00:00:00.000Z",
  );
  db.prepare(
    "INSERT INTO conversations (id, project_id, title, created_at, archived) VALUES (?, ?, ?, ?, ?)",
  ).run("c1", "p1", "first", "2026-11-07T00:00:00.000Z", 1);

  // SAFETY: SQLite returns the row we just inserted; the schema checks every field.
  const project = parseProject(db.prepare("SELECT * FROM projects").get() as JsonValue);
  // SAFETY: SQLite returns the row we just inserted; the schema checks every field.
  const conversation = parseConversation(
    db.prepare("SELECT * FROM conversations").get() as JsonValue,
  );

  expect(project.name).toBe("hns");
  expect(conversation.archived).toBe(true);
  db.close();
});
