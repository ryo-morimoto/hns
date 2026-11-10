import { expect, test } from "vitest";
import * as v from "valibot";
import {
  AutomationActionSchema,
  AutomationTriggerSchema,
  WorkflowGraphSchema,
} from "../src/schemas.ts";

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

test("valid automation values parse", () => {
  expect(
    v.safeParse(AutomationTriggerSchema, { type: "schedule", cron: "0 * * * *" }).success,
  ).toBe(true);
  expect(v.safeParse(AutomationActionSchema, { type: "task", title: "release" }).success).toBe(
    true,
  );
});
