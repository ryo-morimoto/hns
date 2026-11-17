import { expect, test } from "vitest";
import * as v from "valibot";
import { parseProject } from "./parse.ts";
import { AutomationActionSchema, AutomationTriggerSchema, WorkflowGraphSchema } from "./schemas.ts";

// Catches: moving the workflow and automation JSON schemas from core to store dropped the
// non-empty id checks, so an empty node id, cron, or workflow id parsed successfully.

const node = { id: "n1", type: "agent", prompt: "do it" };
const graph = { nodes: [node], edges: [] };

test("a valid workflow graph parses", () => {
  expect(v.safeParse(WorkflowGraphSchema, graph).success).toBe(true);
});

test("an empty workflow node id is rejected", () => {
  expect(v.safeParse(WorkflowGraphSchema, { ...graph, nodes: [{ ...node, id: "" }] }).success).toBe(
    false,
  );
});

test("an empty workflow node prompt is rejected", () => {
  expect(
    v.safeParse(WorkflowGraphSchema, { ...graph, nodes: [{ ...node, prompt: "" }] }).success,
  ).toBe(false);
});

test("an empty workflow edge endpoint is rejected", () => {
  expect(
    v.safeParse(WorkflowGraphSchema, { ...graph, edges: [{ from: "n1", to: "" }] }).success,
  ).toBe(false);
});

test("an empty automation cron is rejected", () => {
  expect(v.safeParse(AutomationTriggerSchema, { type: "schedule", cron: "" }).success).toBe(false);
});

test("an empty automation webhook token is rejected", () => {
  expect(v.safeParse(AutomationTriggerSchema, { type: "webhook", token: "" }).success).toBe(false);
});

test("an empty automation workflow id is rejected", () => {
  expect(v.safeParse(AutomationActionSchema, { type: "workflow", workflowId: "" }).success).toBe(
    false,
  );
});

test("an empty automation chat prompt is rejected", () => {
  expect(v.safeParse(AutomationActionSchema, { type: "chat", prompt: "" }).success).toBe(false);
});

test("an empty automation task title is rejected", () => {
  expect(v.safeParse(AutomationActionSchema, { type: "task", title: "" }).success).toBe(false);
});

// Catches: a missing or non-canonical stored root being read as the machine ROOT.
test("a project row without a canonical root fails closed", () => {
  const row = {
    id: "p1",
    name: "p1",
    egress: "inherit",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  expect(() => parseProject(row)).toThrow();
  expect(() => parseProject({ ...row, workspace_root: null })).toThrow();
  expect(() => parseProject({ ...row, workspace_root: "../x" })).toThrow();
  expect(() => parseProject({ ...row, workspace_root: "/abs" })).toThrow();
  expect(parseProject({ ...row, workspace_root: "" }).agent_cwd).toBe("");
  expect(parseProject({ ...row, workspace_root: "projects/p1" }).agent_cwd).toBe("projects/p1");
});

test("valid automation values parse", () => {
  expect(
    v.safeParse(AutomationTriggerSchema, { type: "schedule", cron: "0 * * * *" }).success,
  ).toBe(true);
  expect(v.safeParse(AutomationActionSchema, { type: "task", title: "release" }).success).toBe(
    true,
  );
});
