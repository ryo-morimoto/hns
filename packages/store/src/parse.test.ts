import { expect, test } from "vitest";
import { parseConversation, parseProject, parseTask } from "./parse.ts";

const projectRow = {
  id: "p1",
  name: "hns",
  workspace_root: "projects/hns",
  egress: "inherit",
  created_at: "2026-11-07T00:00:00.000Z",
};
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

test("a project row parses into the public model", () => {
  expect(parseProject(projectRow)).toStrictEqual({
    id: "p1",
    name: "hns",
    workspace_root: "projects/hns",
    agent_cwd: "projects/hns",
    egress: "inherit",
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
