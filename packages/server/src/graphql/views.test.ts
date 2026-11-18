import { expect, test } from "vitest";
import { ENTITIES, toGlobalId } from "@hns/core/graphql";
import { conversation, project, trail, trailChange } from "../../test/support/graphql.ts";
import { conversationView, projectView, trailChangeView, trailView } from "./views.ts";

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
  // The Trail entity's fields are the row's; the lists it also names (`changes` and the rest)
  // are other tables, not stored values, so the view is the row's fields and only those.
  expect(Object.keys(trailView(trail("trail-1", "p1"))).sort()).toStrictEqual(fieldsOf("Trail"));
  expect(Object.keys(trailChangeView(trailChange("ch1", "trail-1"))).sort()).toStrictEqual(
    fieldsOf("TrailChange"),
  );
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
  expect(trailView(trail("trail-1", "p1")).projectId).toBe(toGlobalId("Project", "p1"));
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

// Catches: a Trail's snake_case row reaching the wire under its stored names, or an enum value
// being rewritten on the way out (the SDL's enum is what spells it).
test("the trail view renames the row's fields and keeps its enums as model values", () => {
  expect(trailView(trail("trail-1", "p1", "Web の土台"))).toStrictEqual({
    id: toGlobalId("Trail", "trail-1"),
    projectId: toGlobalId("Project", "p1"),
    title: "Web の土台",
    description: "",
    acceptance: "",
    kind: "feature",
    state: "draft",
    priority: "normal",
    createdBy: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

// Catches: a commit hash or a workspace id wrapped as a global id, which would let Relay merge a
// change's workspace with the Project that happens to have the same raw value.
test("the change view keeps the hashes and the workspace id as stored", () => {
  expect(trailChangeView(trailChange("ch1", "trail-1"))).toStrictEqual({
    id: toGlobalId("TrailChange", "ch1"),
    trailId: toGlobalId("Trail", "trail-1"),
    workspaceId: "project-hns",
    repoId: null,
    baseCommit: "1".repeat(40),
    headCommit: "2".repeat(40),
    runId: null,
    state: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});
