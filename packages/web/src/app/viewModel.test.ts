import { expect, test } from "vitest";
import { conversationLinkOf, projectLinkOf, taskLinkOf } from "./viewModel.ts";

const PROJECT = "UHJvamVjdDpwcm9qZWN0LWhucw"; // base64url("Project:project-hns")
const CONVERSATION = "Q29udmVyc2F0aW9uOmNvbnZlcnNhdGlvbi1pbnRlbnQ"; // base64url("Conversation:conversation-intent")

test("a project payload maps to the model's raw id", () => {
  expect(projectLinkOf({ id: PROJECT, name: "hns" })).toStrictEqual({
    id: "project-hns",
    name: "hns",
  });
});

test("a conversation payload maps both ids and keeps the title", () => {
  expect(
    conversationLinkOf({ id: CONVERSATION, projectId: PROJECT, title: "Web の土台" }),
  ).toStrictEqual({
    id: "conversation-intent",
    project_id: "project-hns",
    title: "Web の土台",
  });
});

test("a task payload maps the GraphQL enum back to the model's status", () => {
  expect(taskLinkOf({ id: "VGFzazp0YXNrLTE", title: "Do it", status: "DOING" })).toStrictEqual({
    id: "task-1",
    title: "Do it",
    status: "doing",
  });
});

// Catches: a malformed or mistyped global id rendered as if it were a real one.
test("a malformed global id throws instead of rendering a broken link", () => {
  expect(() => projectLinkOf({ id: "not-a-global-id", name: "x" })).toThrow(/malformed/u);
  expect(() => projectLinkOf({ id: CONVERSATION, name: "x" })).toThrow(/malformed/u);
});

// Catches: a status this build does not know silently becoming something else.
test("an unknown task status throws", () => {
  expect(() =>
    taskLinkOf({ id: "VGFzazp0YXNrLTE", title: "x", status: "%future added value" }),
  ).toThrow(/does not know/u);
});
