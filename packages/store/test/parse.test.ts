import test from "node:test";
import assert from "node:assert/strict";
import { parseConversation, parseEvent, parseProject, parseTask } from "../src/parse.ts";
import type { ConversationRow, EventRow, ProjectRow, TaskRow } from "../src/rows.ts";

const projectRow: ProjectRow = { id: "p1", name: "hns", created_at: "2026-11-07T00:00:00.000Z" };
const conversationRow: ConversationRow = {
  id: "c1",
  project_id: "p1",
  title: "first",
  created_at: "2026-11-07T00:00:00.000Z",
  updated_at: null,
  archived: 0,
  deleted_at: null,
};
const taskRow: TaskRow = {
  id: "t1",
  project_id: "p1",
  title: "task",
  status: "doing",
  created_at: "2026-11-07T00:00:00.000Z",
  updated_at: "2026-11-07T00:01:00.000Z",
};
const eventRow: EventRow = {
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

test("a project row parses to the public model", () => {
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

test("null timestamps stay null", () => {
  const conversation = parseConversation(conversationRow);

  assert.equal(conversation.updated_at, null);
  assert.equal(conversation.deleted_at, null);
});

test("a task row keeps its status", () => {
  assert.equal(parseTask(taskRow).status, "doing");
});

test("an unknown task status fails loudly", () => {
  assert.throws(() => parseTask({ ...taskRow, status: "paused" }), /unknown task status/);
});

test("event detail is parsed from JSON", () => {
  assert.deepEqual(parseEvent(eventRow).detail, { a: 1 });
});

test("a null event detail stays null", () => {
  assert.equal(parseEvent({ ...eventRow, detail: null }).detail, null);
});

test("a broken event detail fails loudly", () => {
  assert.throws(() => parseEvent({ ...eventRow, detail: "{" }), SyntaxError);
});

test("an unknown event level fails loudly", () => {
  assert.throws(() => parseEvent({ ...eventRow, level: "debug" }), /unknown event level/);
});
