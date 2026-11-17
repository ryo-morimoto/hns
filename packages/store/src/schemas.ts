import * as v from "valibot";
import {
  AUTOMATION_FIRING_STATUSES,
  ConversationIdSchema,
  EVENT_LEVELS,
  EVENT_NAMES,
  IsoTimestampSchema,
  PROJECT_EGRESS_POLICIES,
  ProjectIdSchema,
  WorkspaceRootSchema,
  TASK_STATUSES,
  WORKFLOW_NODE_STATUSES,
  WORKFLOW_RUN_STATUSES,
} from "@hns/core";
import type {
  Automation,
  AutomationAction,
  AutomationTrigger,
  Conversation,
  Event,
  Firing,
  JsonValue,
  Project,
  Task,
  Usage,
  Workflow,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunNode,
} from "@hns/core";

/** Decode the `detail` JSON text column; null means the event carried no detail. */
const parseDetail = v.transform((text: string | null): JsonValue | null => {
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);

  // SAFETY: detail is written with JSON.stringify of a JsonValue.
  return parsed as JsonValue;
});

/** The `projects` row before `agent_cwd` is derived from the stored root. */
const projectRowSchema = v.object({
  id: ProjectIdSchema,
  name: v.string(),
  workspace_root: WorkspaceRootSchema,
  egress: v.picklist(PROJECT_EGRESS_POLICIES),
  created_at: v.string(),
});

/**
 * The `projects` table row.
 *
 * @remarks
 * `agent_cwd` is not a stored column: it is the project's `workspace_root`, filled here so the
 * model has one value with one source. A stored root that is missing or not canonical throws in
 * `WorkspaceRootSchema` instead of being read as the machine ROOT. Timestamps are stored as ISO
 * text and checked only for presence, not for the ISO format.
 */
export const ProjectRowSchema: v.GenericSchema<unknown, Project> = v.pipe(
  projectRowSchema,
  v.transform((row): Project => ({
    id: row.id,
    name: row.name,
    workspace_root: row.workspace_root,
    agent_cwd: row.workspace_root,
    egress: row.egress,
    created_at: row.created_at,
  })),
);

/**
 * The `conversations` table row.
 *
 * @remarks
 * `archived` is stored as 0 or 1 and decoded to a boolean. `updated_at` is null until the
 * conversation is first touched and `deleted_at` is null until it is soft-deleted.
 */
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

/**
 * The `tasks` table row.
 *
 * @remarks
 * `status` must be one of the task statuses; an unknown value throws rather than falling
 * back to a default.
 */
export const TaskRowSchema: v.GenericSchema<unknown, Task> = v.object({
  id: v.string(),
  project_id: ProjectIdSchema,
  title: v.string(),
  status: v.picklist(TASK_STATUSES),
  created_at: v.string(),
  updated_at: v.string(),
});

/**
 * The `events` table row.
 *
 * @remarks
 * `detail` is JSON text in the column and is decoded to a {@link JsonValue}, or null when
 * the event carried no detail. `status` and `duration_ms` are null when the event does not
 * describe an HTTP response.
 */
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

/** The input shape of {@link ProjectRowSchema}: a raw `projects` row. */
export type ProjectRow = v.InferInput<typeof ProjectRowSchema>;
/** The input shape of {@link ConversationRowSchema}, including the 0 or 1 `archived` flag. */
export type ConversationRow = v.InferInput<typeof ConversationRowSchema>;
/** The input shape of {@link TaskRowSchema}: a raw `tasks` row. */
export type TaskRow = v.InferInput<typeof TaskRowSchema>;
/** The input shape of {@link EventRowSchema}, including `detail` as JSON text. */
export type EventRow = v.InferInput<typeof EventRowSchema>;

/**
 * Decode a JSON text column and validate the decoded value in one step.
 *
 * @internal
 * @remarks
 * The column holds a model shape written with `JSON.stringify`. Decoding and validation
 * happen together, so a row that was hand-edited or written by an older build fails here
 * instead of flowing on as a wrong type.
 *
 * @param schema - The schema the decoded value must satisfy.
 * @param text - The JSON text from the column.
 * @returns The validated value.
 * @throws SyntaxError if `text` is not JSON.
 * @throws ValiError if the decoded value does not match `schema`.
 */
function parseJsonText<TValue>(schema: v.GenericSchema<unknown, TValue>, text: string): TValue {
  const parsed: unknown = JSON.parse(text);
  return v.parse(schema, parsed);
}

if (import.meta.vitest) {
  const { expect, test } = import.meta.vitest;
  test("parseJsonText returns the value decoded from valid JSON text", () => {
    expect(parseJsonText(v.object({ a: v.number() }), '{"a":1}')).toEqual({ a: 1 });
  });
  test("parseJsonText throws when the column does not hold valid JSON", () => {
    expect(() => parseJsonText(v.string(), "{")).toThrow();
  });
}

// The graph, trigger, and action are model shapes stored as JSON text. Store validates them
// on the way in and on the way out; no other package owns this parsing.

/** A non-empty identifier inside a graph, trigger, or action. */
const id = v.pipe(v.string(), v.minLength(1));

/**
 * One node of a workflow graph, validated by its `type`.
 *
 * @remarks
 * Agent and human nodes require a prompt; tool nodes require a command. Empty ids and
 * prompts are rejected, so a stored node is usable without a second check.
 */
export const WorkflowNodeSchema: v.GenericSchema<unknown, WorkflowNode> = v.variant("type", [
  v.object({ id, type: v.literal("agent"), prompt: id }),
  v.object({ id, type: v.literal("human"), prompt: id }),
  v.object({ id, type: v.literal("tool"), command: id }),
]);

/**
 * One directed edge between node ids.
 *
 * @remarks
 * This checks only that both endpoints are present and non-empty; that they name nodes of
 * the same graph is checked by the graph validator.
 */
export const WorkflowEdgeSchema: v.GenericSchema<unknown, WorkflowEdge> = v.object({
  from: id,
  to: id,
});

/**
 * A workflow graph, as stored in `graph_json`.
 *
 * @remarks
 * At least one node is required. This schema checks shape only; rejecting cycles is the
 * caller's job before it stores a graph.
 */
export const WorkflowGraphSchema: v.GenericSchema<unknown, WorkflowGraph> = v.object({
  nodes: v.pipe(v.array(WorkflowNodeSchema), v.minLength(1)),
  edges: v.array(WorkflowEdgeSchema),
});

/**
 * An automation trigger, as stored in `trigger_json`.
 *
 * @remarks
 * A schedule trigger needs a cron expression. A webhook trigger may omit its token before
 * the first save; the repository generates one then.
 */
export const AutomationTriggerSchema: v.GenericSchema<unknown, AutomationTrigger> = v.variant(
  "type",
  [
    v.object({ type: v.literal("schedule"), cron: id, timeZone: v.optional(v.string()) }),
    v.object({ type: v.literal("webhook"), token: v.optional(id) }),
  ],
);

/**
 * An automation action, as stored in `action_json`.
 *
 * @remarks
 * An omitted optional field means absent, not empty. The required `workflowId` and
 * `prompt`, and a present `title`, must be non-empty. `input` and `conversationId`
 * are plain optional strings, so an empty value is stored as-is.
 */
export const AutomationActionSchema: v.GenericSchema<unknown, AutomationAction> = v.variant(
  "type",
  [
    v.object({
      type: v.literal("workflow"),
      workflowId: id,
      input: v.optional(v.string()),
    }),
    v.object({
      type: v.literal("chat"),
      conversationId: v.optional(ConversationIdSchema),
      prompt: id,
    }),
    v.object({ type: v.literal("task"), title: v.optional(id) }),
  ],
);

/** The `workflows` row before `graph_json` is decoded into the public graph. */
const workflowRowSchema = v.object({
  id: v.string(),
  project_id: ProjectIdSchema,
  name: v.string(),
  version: v.number(),
  graph_json: v.string(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

/**
 * The `workflows` table row, with `graph_json` decoded into the public graph.
 *
 * @remarks
 * An invalid stored graph throws instead of being returned half-parsed. `version` is the
 * edit counter; a run copies the version and graph it started with.
 */
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

/**
 * One `workflow_nodes` row.
 *
 * @remarks
 * `started_at`, `finished_at`, `output`, and `conversation_id` are null until the node
 * reaches the state that fills them. `node_id` names a node of the graph the run pinned.
 */
export const WorkflowRunNodeRowSchema: v.GenericSchema<unknown, WorkflowRunNode> = v.object({
  node_id: v.string(),
  status: v.picklist(WORKFLOW_NODE_STATUSES),
  prompt: v.nullable(v.string()),
  output: v.nullable(v.string()),
  conversation_id: v.nullable(ConversationIdSchema),
  started_at: v.nullable(IsoTimestampSchema),
  finished_at: v.nullable(IsoTimestampSchema),
});

/** The `workflow_runs` row; `nodes` is attached by the repository when it loads a run. */
const workflowRunRowSchema = v.object({
  id: v.string(),
  workflow_id: v.string(),
  version: v.number(),
  status: v.picklist(WORKFLOW_RUN_STATUSES),
  input: v.string(),
  output: v.nullable(v.string()),
  created_at: IsoTimestampSchema,
  finished_at: v.nullable(IsoTimestampSchema),
  nodes: v.optional(v.array(WorkflowRunNodeRowSchema)),
});

/**
 * The `workflow_runs` table row, optionally carrying its nodes.
 *
 * @remarks
 * `nodes` is absent when the caller did not load them, which is different from a run with
 * no nodes. `version` is the workflow version the run pinned at start, not the workflow's
 * current version.
 */
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

/** The `automations` row before `trigger_json` and `action_json` are decoded. */
const automationRowSchema = v.object({
  id: v.string(),
  project_id: ProjectIdSchema,
  name: v.string(),
  trigger_json: v.string(),
  action_json: v.string(),
  enabled: v.picklist([0, 1]),
  last_fired_at: v.nullable(IsoTimestampSchema),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

/**
 * The `automations` table row, with its trigger and action decoded.
 *
 * @remarks
 * `enabled` is stored as 0 or 1 and becomes a boolean. `last_fired_at` is null before the
 * first scheduled firing. An invalid trigger or action text throws.
 */
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

/**
 * One `firings` row: an attempt to run an automation.
 *
 * @remarks
 * `run_id` is null until the firing starts a workflow run; `detail` is free-form text and
 * is null when there is nothing to report.
 */
export const FiringRowSchema: v.GenericSchema<unknown, Firing> = v.object({
  id: v.string(),
  automation_id: v.string(),
  at: IsoTimestampSchema,
  status: v.picklist(AUTOMATION_FIRING_STATUSES),
  detail: v.nullable(v.string()),
  run_id: v.nullable(v.string()),
  created_at: IsoTimestampSchema,
});

/** One day's usage totals, as the metrics and usage views consume them. */
export type UsageToday = Usage["today"];

/**
 * The aggregate row `usageRepository.today` returns.
 *
 * @remarks
 * `turns` counts usage rows, `tokens` sums the stored integer token counts, and `cost`
 * sums the recorded cost. An empty day parses as zeroed totals, not null.
 */
export const UsageTodaySchema: v.GenericSchema<unknown, UsageToday> = v.object({
  turns: v.number(),
  tokens: v.number(),
  cost: v.number(),
});
