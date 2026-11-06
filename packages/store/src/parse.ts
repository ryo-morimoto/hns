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

export function parseProject(input: unknown): Project {
  return v.parse(ProjectRowSchema, input);
}

export function parseConversation(input: unknown): Conversation {
  return v.parse(ConversationRowSchema, input);
}

export function parseTask(input: unknown): Task {
  return v.parse(TaskRowSchema, input);
}

export function parseEvent(input: unknown): Event {
  return v.parse(EventRowSchema, input);
}

export function parseWorkflow(input: unknown): Workflow {
  return v.parse(WorkflowRowSchema, input);
}

export function parseWorkflowRun(input: unknown): WorkflowRun {
  return v.parse(WorkflowRunRowSchema, input);
}

export function parseWorkflowRunNode(input: unknown): WorkflowRunNode {
  return v.parse(WorkflowRunNodeRowSchema, input);
}

export function parseAutomation(input: unknown): Automation {
  return v.parse(AutomationRowSchema, input);
}

export function parseFiring(input: unknown): Firing {
  return v.parse(FiringRowSchema, input);
}

export function parseUsageToday(input: unknown): Usage["today"] {
  return v.parse(UsageTodaySchema, input);
}
