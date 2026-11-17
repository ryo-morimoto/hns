/* oxlint-disable anti-slop/no-unknown-parameters --
   These functions are the DB boundary: they take an unknown row and parse it.
*/
import * as v from "valibot";
import type {
  Automation,
  Conversation,
  Event,
  Firing,
  Project,
  Task,
  Usage,
  Workflow,
  WorkflowRun,
  WorkflowRunNode,
} from "@hns/core";
import {
  AutomationRowSchema,
  ConversationRowSchema,
  EventRowSchema,
  FiringRowSchema,
  ProjectRowSchema,
  TaskRowSchema,
  UsageTodaySchema,
  WorkflowRowSchema,
  WorkflowRunNodeRowSchema,
  WorkflowRunRowSchema,
} from "./schemas.ts";

/**
 * Parse a raw `projects` row into the public {@link Project}.
 *
 * @remarks
 * This is the DB boundary: the row is untrusted until it passes {@link ProjectRowSchema}.
 * Storage shapes do not leave the package; callers only see the public model.
 *
 * @param input - A row read from SQLite.
 * @returns The validated project.
 * @throws ValiError if a required column is missing or has the wrong type.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(parseProject({ id: "p1", name: "Project", workspace_root: "projects/p1", egress: "inherit", created_at: "2026-01-01T00:00:00.000Z" }).agent_cwd).toBe("projects/p1");
 * expect(() => parseProject({ id: "p1", name: "Project", workspace_root: "../x", egress: "inherit", created_at: "2026-01-01T00:00:00.000Z" })).toThrow();
 * expect(() => parseProject({ name: "Project" })).toThrow();
 * ```
 */
export function parseProject(input: unknown): Project {
  return v.parse(ProjectRowSchema, input);
}

/**
 * Parse a raw `conversations` row into the public {@link Conversation}.
 *
 * @remarks
 * The 0 or 1 `archived` column becomes a boolean. A soft-deleted conversation still parses;
 * `deleted_at` is the tombstone, not a reason to fail.
 *
 * @param input - A row read from SQLite.
 * @returns The validated conversation.
 * @throws ValiError if a required column is missing or has an unknown value.
 */
export function parseConversation(input: unknown): Conversation {
  return v.parse(ConversationRowSchema, input);
}

/**
 * Parse a raw `tasks` row into the public {@link Task}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated task.
 * @throws ValiError if a required column is missing or `status` is not a known status.
 */
export function parseTask(input: unknown): Task {
  return v.parse(TaskRowSchema, input);
}

/**
 * Parse a raw `events` row into the public {@link Event}.
 *
 * @remarks
 * `detail` is JSON text in the column and becomes a decoded `JsonValue`, or null when
 * the event carried no detail.
 *
 * @param input - A row read from SQLite.
 * @returns The validated event.
 * @throws ValiError if a required column is missing or a level or name is unknown.
 * @throws SyntaxError if `detail` is not valid JSON.
 */
export function parseEvent(input: unknown): Event {
  return v.parse(EventRowSchema, input);
}

/**
 * Parse a raw `workflows` row into the public {@link Workflow}.
 *
 * @remarks
 * `graph_json` is decoded and validated into a `WorkflowGraph`; a stored graph that no
 * longer validates throws rather than being returned partially.
 *
 * @param input - A row read from SQLite.
 * @returns The validated workflow.
 * @throws ValiError if a column or the decoded graph is invalid.
 * @throws SyntaxError if `graph_json` is not valid JSON.
 */
export function parseWorkflow(input: unknown): Workflow {
  return v.parse(WorkflowRowSchema, input);
}

/**
 * Parse a raw `workflow_runs` row into the public {@link WorkflowRun}.
 *
 * @remarks
 * `nodes` stays absent when the input did not include it, which is different from a run with
 * no nodes. `version` is the workflow version the run pinned at start.
 *
 * @param input - A row read from SQLite, optionally with its nodes.
 * @returns The validated run.
 * @throws ValiError if a required column is missing or `status` is unknown.
 */
export function parseWorkflowRun(input: unknown): WorkflowRun {
  return v.parse(WorkflowRunRowSchema, input);
}

/**
 * Parse a raw `workflow_nodes` row into the public {@link WorkflowRunNode}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated node.
 * @throws ValiError if a required column is missing or `status` is unknown.
 */
export function parseWorkflowRunNode(input: unknown): WorkflowRunNode {
  return v.parse(WorkflowRunNodeRowSchema, input);
}

/**
 * Parse a raw `automations` row into the public {@link Automation}.
 *
 * @remarks
 * `trigger_json` and `action_json` are decoded and validated, and the 0 or 1 `enabled`
 * column becomes a boolean.
 *
 * @param input - A row read from SQLite.
 * @returns The validated automation.
 * @throws ValiError if a column or a decoded trigger or action is invalid.
 * @throws SyntaxError if the trigger or action text is not valid JSON.
 */
export function parseAutomation(input: unknown): Automation {
  return v.parse(AutomationRowSchema, input);
}

/**
 * Parse a raw `firings` row into the public {@link Firing}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated firing.
 * @throws ValiError if a required column is missing or `status` is unknown.
 */
export function parseFiring(input: unknown): Firing {
  return v.parse(FiringRowSchema, input);
}

/**
 * Parse the aggregate row behind `usageRepository.today`.
 *
 * @remarks
 * The aggregate query always returns one row, with zeroed sums for an empty day, so the
 * result is totals rather than an absent value.
 *
 * @param input - The aggregate row read from SQLite.
 * @returns The validated daily totals.
 * @throws ValiError if the row does not have the three numeric totals.
 */
export function parseUsageToday(input: unknown): Usage["today"] {
  return v.parse(UsageTodaySchema, input);
}
