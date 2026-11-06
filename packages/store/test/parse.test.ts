import test from "node:test";
import assert from "node:assert/strict";
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
  assert.deepEqual(parseProject(projectRow), {
    id: "p1",
    name: "hns",
    created_at: "2026-11-07T00:00:00.000Z",
  });
});

test("archived 0/1 becomes a boolean", () => {
  assert.equal(parseConversation(conversationRow).archived, false);
  assert.equal(parseConversation({ ...conversationRow, archived: 1 }).archived, true);
});

test("an unknown archived flag is rejected", () => {
  assert.throws(() => parseConversation({ ...conversationRow, archived: 2 }));
});

test("null timestamps stay null", () => {
  const conversation = parseConversation(conversationRow);

  assert.equal(conversation.updated_at, null);
  assert.equal(conversation.deleted_at, null);
});

test("a missing field is rejected", () => {
  assert.throws(() => parseProject({ id: "p1", created_at: "2026-11-07T00:00:00.000Z" }));
});

test("a task row keeps its status", () => {
  assert.equal(parseTask(taskRow).status, "doing");
});

test("an unknown task status fails loudly", () => {
  assert.throws(() => parseTask({ ...taskRow, status: "paused" }));
});

test("event detail is parsed from JSON", () => {
  assert.deepEqual(parseEvent(eventRow).detail, { a: 1 });
});

test("a null event detail stays null", () => {
  assert.equal(parseEvent({ ...eventRow, detail: null }).detail, null);
});

test("a broken event detail fails loudly", () => {
  assert.throws(() => parseEvent({ ...eventRow, detail: "{" }));
});

test("an unknown event level fails loudly", () => {
  assert.throws(() => parseEvent({ ...eventRow, level: "debug" }));
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

  assert.equal(project.name, "hns");
  assert.equal(conversation.archived, true);
  db.close();
});
