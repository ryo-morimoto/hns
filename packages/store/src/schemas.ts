import * as v from "valibot";
import {
  AUTOMATION_FIRING_STATUSES,
  AutomationActionSchema,
  AutomationTriggerSchema,
  ConversationIdSchema,
  EVENT_LEVELS,
  EVENT_NAMES,
  ProjectIdSchema,
  TASK_STATUSES,
  WORKFLOW_NODE_STATUSES,
  WORKFLOW_RUN_STATUSES,
  WorkflowGraphSchema,
} from "@hns/core";
import type {
  Automation,
  Conversation,
  Event,
  Firing,
  JsonValue,
  Project,
  Task,
  Usage,
  Workflow,
  WorkflowRun,
  WorkflowRunNode,
} from "@hns/core";

const parseDetail = v.transform((text: string | null): JsonValue | null => {
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);

  // SAFETY: detail is written with JSON.stringify of a JsonValue.
  return parsed as JsonValue;
});

export const ProjectRowSchema: v.GenericSchema<unknown, Project> = v.object({
  id: ProjectIdSchema,
  name: v.string(),
  created_at: v.string(),
});

export const ConversationRowSchema: v.GenericSchema<unknown, Conversation> = v.object({
  id: ConversationIdSchema,
  project_id: ProjectIdSchema,
  title: v.string(),
  created_at: v.string(),
  updated_at: v.nullable(v.string()),
  archived: v.pipe(
    v.picklist([0, 1]),
    v.transform((flag) => flag === 1),
  ),
  deleted_at: v.nullable(v.string()),
});

export const TaskRowSchema: v.GenericSchema<unknown, Task> = v.object({
  id: v.string(),
  project_id: ProjectIdSchema,
  title: v.string(),
  status: v.picklist(TASK_STATUSES),
  created_at: v.string(),
  updated_at: v.string(),
});

export const EventRowSchema: v.GenericSchema<unknown, Event> = v.object({
  id: v.string(),
  at: v.string(),
  level: v.picklist(EVENT_LEVELS),
  event: v.picklist(EVENT_NAMES),
  request_id: v.nullable(v.string()),
  conversation_id: v.nullable(ConversationIdSchema),
  status: v.nullable(v.number()),
  duration_ms: v.nullable(v.number()),
  detail: v.pipe(v.nullable(v.string()), parseDetail),
});

export type ProjectRow = v.InferInput<typeof ProjectRowSchema>;
export type ConversationRow = v.InferInput<typeof ConversationRowSchema>;
export type TaskRow = v.InferInput<typeof TaskRowSchema>;
export type EventRow = v.InferInput<typeof EventRowSchema>;

function parseJsonText<TValue>(schema: v.GenericSchema<unknown, TValue>, text: string): TValue {
  const parsed: unknown = JSON.parse(text);
  return v.parse(schema, parsed);
}

/** The DB keeps the graph as JSON text; the public model keeps it as an object. */
const workflowRowSchema = v.object({
  id: v.string(),
  project_id: ProjectIdSchema,
  name: v.string(),
  version: v.number(),
  graph_json: v.string(),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
  updated_at: v.pipe(v.string(), v.isoTimestamp()),
});

export const WorkflowRowSchema: v.GenericSchema<unknown, Workflow> = v.pipe(
  workflowRowSchema,
  v.transform((row): Workflow => ({
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    version: row.version,
    graph: parseJsonText(WorkflowGraphSchema, row.graph_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  })),
);

export const WorkflowRunNodeRowSchema: v.GenericSchema<unknown, WorkflowRunNode> = v.object({
  node_id: v.string(),
  status: v.picklist(WORKFLOW_NODE_STATUSES),
  prompt: v.nullable(v.string()),
  output: v.nullable(v.string()),
  conversation_id: v.nullable(ConversationIdSchema),
  started_at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  finished_at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
});

const workflowRunRowSchema = v.object({
  id: v.string(),
  workflow_id: v.string(),
  version: v.number(),
  status: v.picklist(WORKFLOW_RUN_STATUSES),
  input: v.string(),
  output: v.nullable(v.string()),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
  finished_at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  nodes: v.optional(v.array(WorkflowRunNodeRowSchema)),
});

export const WorkflowRunRowSchema: v.GenericSchema<unknown, WorkflowRun> = v.pipe(
  workflowRunRowSchema,
  v.transform((row): WorkflowRun => {
    const run: WorkflowRun = {
      id: row.id,
      workflow_id: row.workflow_id,
      version: row.version,
      status: row.status,
      input: row.input,
      output: row.output,
      created_at: row.created_at,
      finished_at: row.finished_at,
    };
    return row.nodes === undefined ? run : { ...run, nodes: row.nodes };
  }),
);

const automationRowSchema = v.object({
  id: v.string(),
  project_id: ProjectIdSchema,
  name: v.string(),
  trigger_json: v.string(),
  action_json: v.string(),
  enabled: v.picklist([0, 1]),
  last_fired_at: v.nullable(v.pipe(v.string(), v.isoTimestamp())),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
  updated_at: v.pipe(v.string(), v.isoTimestamp()),
});

export const AutomationRowSchema: v.GenericSchema<unknown, Automation> = v.pipe(
  automationRowSchema,
  v.transform((row): Automation => ({
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    trigger: parseJsonText(AutomationTriggerSchema, row.trigger_json),
    action: parseJsonText(AutomationActionSchema, row.action_json),
    enabled: row.enabled === 1,
    last_fired_at: row.last_fired_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })),
);

export const FiringRowSchema: v.GenericSchema<unknown, Firing> = v.object({
  id: v.string(),
  automation_id: v.string(),
  at: v.pipe(v.string(), v.isoTimestamp()),
  status: v.picklist(AUTOMATION_FIRING_STATUSES),
  detail: v.nullable(v.string()),
  run_id: v.nullable(v.string()),
  created_at: v.pipe(v.string(), v.isoTimestamp()),
});

export type UsageToday = Usage["today"];

export const UsageTodaySchema: v.GenericSchema<unknown, UsageToday> = v.object({
  turns: v.number(),
  tokens: v.number(),
  cost: v.number(),
});
