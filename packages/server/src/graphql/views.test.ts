import { expect, test } from "vitest";
import { ENTITIES, toGlobalId } from "@hns/core/graphql";
import { conversation, project, task } from "../../test/support/graphql.ts";
import { conversationView, projectView, taskView } from "./views.ts";

/** The GraphQL field names the schema carries for one model type. */
function fieldsOf(name: string): readonly string[] {
  const entity = ENTITIES.find((candidate) => candidate.name === name);
  if (entity === undefined) throw new Error("the model has no entity " + name);
  return entity.fields.map((field) => field.name).sort();
}

// Catches: a view field that the SDL does not carry, or an SDL field the view never fills.
test("each view carries exactly the GraphQL fields of its entity", () => {
  expect(Object.keys(projectView(project("p1"))).sort()).toStrictEqual(fieldsOf("Project"));
  expect(Object.keys(conversationView(conversation("c1", "p1"))).sort()).toStrictEqual(
    fieldsOf("Conversation"),
  );
  expect(Object.keys(taskView(task("t1", "p1"))).sort()).toStrictEqual(fieldsOf("Task"));
});

// Catches: a raw id crossing the boundary, where two types could share it in Relay's store.
test("the project view carries global ids", () => {
  expect(projectView(project("p1", "p1", "projects/p1", "deny"))).toStrictEqual({
    id: toGlobalId("Project", "p1"),
    name: "p1",
    workspaceRoot: "projects/p1",
    agentCwd: "projects/p1",
    egress: "deny",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  expect(taskView(task("t1", "p1")).projectId).toBe(toGlobalId("Project", "p1"));
});

// Catches: a storage field leaking under its snake_case name, or the archived rename being lost.
test("the conversation view renames archived and keeps nullable fields null", () => {
  expect(conversationView(conversation("c1", "p1", "Title"))).toStrictEqual({
    id: toGlobalId("Conversation", "c1"),
    projectId: toGlobalId("Project", "p1"),
    title: "Title",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    isArchived: false,
    deletedAt: null,
  });
});
