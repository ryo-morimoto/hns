import { expect, test } from "vitest";
import type { TrailState } from "@hns/core";
import {
  TRAIL_GROUPS,
  conversationLinkOf,
  projectLinkOf,
  trailGroupOf,
  trailGroupsOf,
  trailLinkOf,
  type TrailGroup,
} from "./viewModel.ts";

const PROJECT = "UHJvamVjdDpwcm9qZWN0LWhucw"; // base64url("Project:project-hns")
const CONVERSATION = "Q29udmVyc2F0aW9uOmNvbnZlcnNhdGlvbi1pbnRlbnQ"; // base64url("Conversation:conversation-intent")
const TRAIL = "VHJhaWw6dHJhaWwtMQ"; // base64url("Trail:trail-1")

test("a project payload maps to the model's raw id and root", () => {
  expect(
    projectLinkOf({
      id: PROJECT,
      name: "hns",
      workspaceRoot: "projects/hns",
      agentCwd: "projects/hns",
    }),
  ).toStrictEqual({
    id: "project-hns",
    name: "hns",
    workspace_root: "projects/hns",
    agent_cwd: "projects/hns",
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

test("a trail payload maps the GraphQL enum back to the model's state", () => {
  expect(
    trailLinkOf({ id: TRAIL, projectId: PROJECT, title: "Do it", state: "IN_REVIEW" }),
  ).toStrictEqual({
    id: "trail-1",
    project_id: "project-hns",
    title: "Do it",
    state: "in_review",
  });
});

// Catches: a malformed or mistyped global id rendered as if it were a real one.
test("a malformed global id throws instead of rendering a broken link", () => {
  expect(() =>
    projectLinkOf({ id: "not-a-global-id", name: "x", workspaceRoot: "", agentCwd: "" }),
  ).toThrow(/malformed/u);
  expect(() =>
    projectLinkOf({ id: CONVERSATION, name: "x", workspaceRoot: "", agentCwd: "" }),
  ).toThrow(/malformed/u);
});

// Catches: a state this build does not know silently becoming something else.
test("an unknown trail state throws", () => {
  expect(() =>
    trailLinkOf({ id: TRAIL, projectId: PROJECT, title: "x", state: "%future added value" }),
  ).toThrow(/does not know/u);
});

/**
 * The group each model state is listed under.
 *
 * @remarks
 * Written out rather than derived from the function under test: a table read from the
 * implementation would agree with any edit to it.
 */
const EXPECTED = {
  draft: "active",
  active: "active",
  in_review: "needs-you",
  merged: "observing",
  observing: "observing",
  closed: "closed",
  abandoned: "closed",
} satisfies Readonly<Record<TrailState, TrailGroup>>;

// Catches: a state landing in the wrong list (a review that does not wait for a person, an ended
// Trail under Active), or a state the Sidebar cannot show.
test("every trail state lands in exactly one Sidebar list", () => {
  for (const [state, group] of Object.entries(EXPECTED)) {
    // SAFETY: the table above is typed by the model's closed state vocabulary, so its keys are
    // exactly the states `trailGroupOf` takes.
    expect(trailGroupOf(state as TrailState), state).toBe(group);
  }
  expect(new Set(Object.values(EXPECTED))).toStrictEqual(new Set(TRAIL_GROUPS));
});

// Catches: a grouping that reorders the lists, moves a Trail between them, or drops one.
test("trailGroupsOf keeps the four lists in order and each list's server order", () => {
  const trails = [
    trailLinkOf({ id: TRAIL, projectId: PROJECT, title: "review", state: "IN_REVIEW" }),
    trailLinkOf({ id: "VHJhaWw6dHJhaWwtMg", projectId: PROJECT, title: "draft", state: "DRAFT" }),
    trailLinkOf({ id: "VHJhaWw6dHJhaWwtMw", projectId: PROJECT, title: "active", state: "ACTIVE" }),
    trailLinkOf({ id: "VHJhaWw6dHJhaWwtNA", projectId: PROJECT, title: "closed", state: "CLOSED" }),
  ];
  const groups = trailGroupsOf(trails);
  expect(groups.map((group) => group.group)).toStrictEqual([...TRAIL_GROUPS]);
  expect(groups.map((group) => group.trails.map((trail) => trail.title))).toStrictEqual([
    ["review"],
    ["draft", "active"],
    [],
    ["closed"],
  ]);
});
