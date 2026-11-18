import * as v from "valibot";
import {
  AUTOMATION_FIRING_STATUSES,
  ConversationIdSchema,
  IsoTimestampSchema,
  PROJECT_EGRESS_POLICIES,
  ProjectIdSchema,
  WorkspaceRootSchema,
  TASK_STATUSES,
  TRAIL_ACTOR_KINDS,
  TRAIL_CHANGE_STATES,
  TRAIL_DECISION_ACTIONS,
  TRAIL_EVAL_STATUSES,
  TRAIL_FEEDBACK_CHANNELS,
  TRAIL_FEEDBACK_SENTIMENTS,
  TRAIL_FINDING_SEVERITIES,
  TRAIL_FINDING_SOURCES,
  TRAIL_FINDING_STATUSES,
  TRAIL_GATE_KINDS,
  TRAIL_GATE_STATUSES,
  TRAIL_KINDS,
  TRAIL_PRIORITIES,
  TRAIL_STATES,
  WORKFLOW_NODE_STATUSES,
  WORKFLOW_RUN_STATUSES,
} from "@hns/core";
import type {
  Automation,
  AutomationAction,
  AutomationTrigger,
  Conversation,
  Firing,
  Project,
  Task,
  Trail,
  TrailChange,
  TrailDecision,
  TrailEval,
  TrailFeedback,
  TrailFinding,
  TrailGate,
  TrailMetric,
  TrailNote,
  TrailSession,
  Workflow,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunNode,
} from "@hns/core";
import { HashSchema, POLICY_PROPOSAL_STATUSES, PolicyDocumentSchema } from "@hns/core/capability";
import type { PolicyRevision } from "@hns/core/capability";
import type { PolicyActive, StoredPolicyProposal } from "./repositories/policy.ts";

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

/** The input shape of {@link ProjectRowSchema}: a raw `projects` row. */
export type ProjectRow = v.InferInput<typeof ProjectRowSchema>;
/** The input shape of {@link ConversationRowSchema}, including the 0 or 1 `archived` flag. */
export type ConversationRow = v.InferInput<typeof ConversationRowSchema>;
/** The input shape of {@link TaskRowSchema}: a raw `tasks` row. */
export type TaskRow = v.InferInput<typeof TaskRowSchema>;

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

// The policy tables hold the capability contract's document as JSON text. Store validates the
// text on the way in and on the way out; the model shapes are `@hns/core/capability`'s.

/** A shallow-mutable view, for building a row's public shape member by member. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The `policy_revisions` row before `document_json` is decoded. */
const policyRevisionRowSchema = v.object({
  workspace_id: v.pipe(v.string(), v.minLength(1)),
  revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  hash: HashSchema,
  document_json: v.string(),
  created_at: IsoTimestampSchema,
  created_by: v.pipe(v.string(), v.minLength(1)),
});

/**
 * One `policy_revisions` row, with its document decoded.
 *
 * @remarks
 * A stored document that no longer parses throws instead of being returned half-parsed: a
 * revision is immutable, so a row that cannot be read is one this build must not act on.
 */
export const PolicyRevisionRowSchema: v.GenericSchema<unknown, PolicyRevision> = v.pipe(
  policyRevisionRowSchema,
  v.transform((row): PolicyRevision => ({
    workspaceId: row.workspace_id,
    revision: row.revision,
    hash: row.hash,
    document: parseJsonText(PolicyDocumentSchema, row.document_json),
    createdAt: row.created_at,
    createdBy: row.created_by,
  })),
);

/**
 * The `policy_active` row: the revision a workspace's calls are allowed under.
 *
 * @remarks
 * One row per workspace. The document is not copied here; it is read from `policy_revisions` at
 * the revision this row names, so the two can never disagree about a document.
 */
export const PolicyActiveRowSchema: v.GenericSchema<unknown, PolicyActive> = v.pipe(
  v.object({
    workspace_id: v.pipe(v.string(), v.minLength(1)),
    revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
    hash: HashSchema,
    updated_at: IsoTimestampSchema,
  }),
  v.transform((row): PolicyActive => ({
    workspaceId: row.workspace_id,
    revision: row.revision,
    hash: row.hash,
    updatedAt: row.updated_at,
  })),
);

/** The `policy_proposals` row before `candidate_json` is decoded. */
const policyProposalRowSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  workspace_id: v.pipe(v.string(), v.minLength(1)),
  base_revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
  base_hash: HashSchema,
  candidate_json: v.string(),
  candidate_hash: HashSchema,
  review_token: HashSchema,
  requested_by: v.pipe(v.string(), v.minLength(1)),
  reason: v.string(),
  status: v.picklist(POLICY_PROPOSAL_STATUSES),
  decided_by: v.nullable(v.string()),
  decided_at: v.nullable(IsoTimestampSchema),
  decision_reason: v.nullable(v.string()),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});

/**
 * One `policy_proposals` row, with its candidate decoded.
 *
 * @remarks
 * The optional `decided*` members come out **absent** until the row carries them, not as
 * `undefined`: the contract's optional members are absent-or-present
 * (`exactOptionalPropertyTypes`), so a consumer reads "was it decided" from the key's presence.
 * `updated_at` is the store's own column; it is not part of the public proposal.
 */
export const PolicyProposalRowSchema: v.GenericSchema<unknown, StoredPolicyProposal> = v.pipe(
  policyProposalRowSchema,
  v.transform((row): StoredPolicyProposal => {
    const proposal: Mutable<StoredPolicyProposal> = {
      id: row.id,
      workspaceId: row.workspace_id,
      baseRevision: row.base_revision,
      baseHash: row.base_hash,
      candidate: parseJsonText(PolicyDocumentSchema, row.candidate_json),
      candidateHash: row.candidate_hash,
      reviewToken: row.review_token,
      requestedBy: row.requested_by,
      reason: row.reason,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.decided_by !== null) proposal.decidedBy = row.decided_by;
    if (row.decided_at !== null) proposal.decidedAt = row.decided_at;
    if (row.decision_reason !== null) proposal.decisionReason = row.decision_reason;
    return proposal;
  }),
);

/** The input shape of {@link PolicyRevisionRowSchema}: a raw `policy_revisions` row. */
export type PolicyRevisionRow = v.InferInput<typeof PolicyRevisionRowSchema>;
/** The input shape of {@link PolicyActiveRowSchema}: a raw `policy_active` row. */
export type PolicyActiveRow = v.InferInput<typeof PolicyActiveRowSchema>;
/** The input shape of {@link PolicyProposalRowSchema}: a raw `policy_proposals` row. */
export type PolicyProposalRow = v.InferInput<typeof PolicyProposalRowSchema>;

// The Trail tables (D104). Each closed vocabulary is the core constant, so a value this build
// does not know throws here instead of being read as a default; the same CHECK is on the column,
// so a hand-edited row can be refused at the write as well as at the read.

/** A Trail's display text: title, description, and acceptance are stored, never defaulted. */
const text = v.string();
/** The timestamp a Trail row records when something happened or was written. */
const at = v.string();

/**
 * The `trails` table row.
 *
 * @remarks
 * `state`, `kind`, and `priority` must be one of the core vocabularies; an unknown value throws
 * rather than falling back. The store does not check a transition here — that is
 * `assertTrailTransition` in the repository, because a row does not know where it came from.
 */
export const TrailRowSchema: v.GenericSchema<unknown, Trail> = v.object({
  id: v.pipe(text, v.minLength(1)),
  project_id: ProjectIdSchema,
  title: v.pipe(text, v.minLength(1)),
  description: text,
  acceptance: text,
  kind: v.picklist(TRAIL_KINDS),
  state: v.picklist(TRAIL_STATES),
  priority: v.picklist(TRAIL_PRIORITIES),
  created_by: text,
  created_at: at,
  updated_at: at,
});

/**
 * One `trail_changes` row: the `base..head` pair a Trail moved the code to.
 *
 * @remarks
 * `repo_id` and `run_id` are null while a Trail has one repository or no run. `base_commit` and
 * `head_commit` being different is the repository's check, not this schema's.
 */
export const TrailChangeRowSchema: v.GenericSchema<unknown, TrailChange> = v.object({
  id: text,
  trail_id: text,
  workspace_id: text,
  repo_id: v.nullable(text),
  base_commit: text,
  head_commit: text,
  run_id: v.nullable(text),
  state: v.picklist(TRAIL_CHANGE_STATES),
  created_at: at,
  updated_at: at,
});

/** One `trail_sessions` row: a link from a Trail to a conversation, session, or run. */
export const TrailSessionRowSchema: v.GenericSchema<unknown, TrailSession> = v.object({
  id: text,
  trail_id: text,
  conversation_id: v.nullable(ConversationIdSchema),
  session_id: text,
  run_id: v.nullable(text),
  linked_at: at,
});

/**
 * One `trail_feedback` row.
 *
 * @remarks
 * `sentiment`, `channel`, and `actor` are closed; `occurred_at <= recorded_at` is the
 * repository's check, because the row itself does not know which of the two it is being compared
 * with.
 */
export const TrailFeedbackRowSchema: v.GenericSchema<unknown, TrailFeedback> = v.object({
  id: text,
  trail_id: text,
  change_id: v.nullable(text),
  channel: v.picklist(TRAIL_FEEDBACK_CHANNELS),
  summary: text,
  sentiment: v.picklist(TRAIL_FEEDBACK_SENTIMENTS),
  source_url: v.nullable(text),
  source: text,
  actor: v.picklist(TRAIL_ACTOR_KINDS),
  external_id: v.nullable(text),
  occurred_at: at,
  recorded_at: at,
  supersedes_id: v.nullable(text),
});

/** One `trail_metrics` row: a product signal with its measurement window. */
export const TrailMetricRowSchema: v.GenericSchema<unknown, TrailMetric> = v.object({
  id: text,
  trail_id: text,
  change_id: v.nullable(text),
  name: text,
  value: v.number(),
  unit: text,
  window_start: at,
  window_end: at,
  source: text,
  external_id: v.nullable(text),
  occurred_at: at,
  recorded_at: at,
});

/** One `trail_evals` row: a test, lint, or review verdict attached to a Trail. */
export const TrailEvalRowSchema: v.GenericSchema<unknown, TrailEval> = v.object({
  id: text,
  trail_id: text,
  change_id: v.nullable(text),
  name: text,
  status: v.picklist(TRAIL_EVAL_STATUSES),
  detail: v.nullable(text),
  source: text,
  occurred_at: at,
  recorded_at: at,
});

/** One `trail_notes` row: markdown a person wrote on the Trail. */
export const TrailNoteRowSchema: v.GenericSchema<unknown, TrailNote> = v.object({
  id: text,
  trail_id: text,
  body: text,
  author: text,
  occurred_at: at,
  recorded_at: at,
});

/** One `trail_decisions` row: an approval, a change request, or a rejection. */
export const TrailDecisionRowSchema: v.GenericSchema<unknown, TrailDecision> = v.object({
  id: text,
  trail_id: text,
  change_id: v.nullable(text),
  actor: text,
  action: v.picklist(TRAIL_DECISION_ACTIONS),
  head_commit: v.nullable(text),
  note: text,
  at: at,
});

/**
 * One `trail_findings` row.
 *
 * @remarks
 * `resolved_at` and `resolved_by` are null while the finding is open. An unknown severity is
 * refused: `none` means "no weight", never "undecided".
 */
export const TrailFindingRowSchema: v.GenericSchema<unknown, TrailFinding> = v.object({
  id: text,
  trail_id: text,
  change_id: v.nullable(text),
  severity: v.picklist(TRAIL_FINDING_SEVERITIES),
  source: v.picklist(TRAIL_FINDING_SOURCES),
  status: v.picklist(TRAIL_FINDING_STATUSES),
  file: v.nullable(text),
  hunk: v.nullable(text),
  summary: text,
  created_at: at,
  resolved_at: v.nullable(at),
  resolved_by: v.nullable(text),
});

/** One `trail_gates` row: one gate's evaluation against one Trail or Change. */
export const TrailGateRowSchema: v.GenericSchema<unknown, TrailGate> = v.object({
  id: text,
  trail_id: text,
  change_id: v.nullable(text),
  gate: v.picklist(TRAIL_GATE_KINDS),
  status: v.picklist(TRAIL_GATE_STATUSES),
  detail: v.nullable(text),
  evaluated_at: at,
});

/** The input shape of {@link TrailRowSchema}: a raw `trails` row. */
export type TrailRow = v.InferInput<typeof TrailRowSchema>;
/** The input shape of {@link TrailChangeRowSchema}: a raw `trail_changes` row. */
export type TrailChangeRow = v.InferInput<typeof TrailChangeRowSchema>;
/** The input shape of {@link TrailSessionRowSchema}: a raw `trail_sessions` row. */
export type TrailSessionRow = v.InferInput<typeof TrailSessionRowSchema>;
/** The input shape of {@link TrailFeedbackRowSchema}: a raw `trail_feedback` row. */
export type TrailFeedbackRow = v.InferInput<typeof TrailFeedbackRowSchema>;
/** The input shape of {@link TrailMetricRowSchema}: a raw `trail_metrics` row. */
export type TrailMetricRow = v.InferInput<typeof TrailMetricRowSchema>;
/** The input shape of {@link TrailEvalRowSchema}: a raw `trail_evals` row. */
export type TrailEvalRow = v.InferInput<typeof TrailEvalRowSchema>;
/** The input shape of {@link TrailNoteRowSchema}: a raw `trail_notes` row. */
export type TrailNoteRow = v.InferInput<typeof TrailNoteRowSchema>;
/** The input shape of {@link TrailDecisionRowSchema}: a raw `trail_decisions` row. */
export type TrailDecisionRow = v.InferInput<typeof TrailDecisionRowSchema>;
/** The input shape of {@link TrailFindingRowSchema}: a raw `trail_findings` row. */
export type TrailFindingRow = v.InferInput<typeof TrailFindingRowSchema>;
/** The input shape of {@link TrailGateRowSchema}: a raw `trail_gates` row. */
export type TrailGateRow = v.InferInput<typeof TrailGateRowSchema>;
