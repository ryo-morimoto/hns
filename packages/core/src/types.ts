// The model. Types are the source of truth. Wire projections are generated from these
// (`@hns/core/graphql`); request and response envelopes belong to the surface that serves them.

declare const brand: unique symbol;
/** Nominal wrapper: two ids of different kinds cannot be swapped. Built at the DB boundary. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Only the ids that are easy to mix up get a brand. */
export type ProjectId = Brand<string, "ProjectId">;
export type ConversationId = Brand<string, "ConversationId">;

export const TASK_STATUSES = ["todo", "doing", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const WORKFLOW_RUN_STATUSES = ["queued", "running", "waiting", "done", "failed"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WORKFLOW_NODE_STATUSES = ["pending", "running", "waiting", "done", "failed"] as const;
export type WorkflowNodeStatus = (typeof WORKFLOW_NODE_STATUSES)[number];

export const AUTOMATION_FIRING_STATUSES = ["running", "done", "failed", "skipped"] as const;
export type AutomationFiringStatus = (typeof AUTOMATION_FIRING_STATUSES)[number];

export const EVENT_LEVELS = ["info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

export const EVENT_NAMES = [
  "server.start",
  "auth.denied",
  "http",
  "http.error",
  "chat.submitted",
  "chat.settled",
  "chat.aborted",
  "chat.rate_limited",
  "chat.budget_exceeded",
  "agent.response",
  "tool.call",
  "tool.result",
  "conversation.created",
  "conversation.updated",
  "conversation.deleted",
  "project.created",
  "project.renamed",
  "task.created",
  "task.updated",
  "secret.put",
  "secret.delete",
  "file.write",
  "workflow.created",
  "workflow.updated",
  "workflow.run.started",
  "workflow.run.finished",
  "workflow.run.failed",
  "workflow.node.started",
  "workflow.node.finished",
  "workflow.node.waiting",
  "automation.created",
  "automation.fired",
  "automation.skipped",
  "automation.finished",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { [key: string]: JsonValue };

export interface Project {
  id: ProjectId;
  name: string;
  /** ISO 8601. */
  created_at: string;
}

export interface Conversation {
  id: ConversationId;
  project_id: ProjectId;
  title: string;
  /** ISO 8601. */
  created_at: string;
  updated_at: string | null;
  archived: boolean;
  deleted_at: string | null;
}

export interface Task {
  id: string;
  project_id: ProjectId;
  title: string;
  status: TaskStatus;
  /** ISO 8601. */
  created_at: string;
  updated_at: string;
}

export const WORKFLOW_NODE_TYPES = ["agent", "tool", "human"] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

/** An agent or human node carries a prompt; a tool node carries a command. */
export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  prompt?: string | undefined;
  command?: string | undefined;
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

/** A DAG. The server rejects cycles before it stores one. */
export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface Workflow {
  id: string;
  project_id: ProjectId;
  name: string;
  /** Bumped on every edit. A run pins the version it started with. */
  version: number;
  graph: WorkflowGraph;
  created_at: string;
  updated_at: string;
}

/** One node of a run. */
export interface WorkflowRunNode {
  node_id: string;
  status: WorkflowNodeStatus;
  prompt: string | null;
  output: string | null;
  conversation_id: ConversationId | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  version: number;
  status: WorkflowRunStatus;
  input: string;
  /** JSON text of the node outputs. */
  output: string | null;
  created_at: string;
  finished_at: string | null;
  nodes?: WorkflowRunNode[] | undefined;
}

export const AUTOMATION_TRIGGER_TYPES = ["schedule", "webhook"] as const;

export type AutomationTrigger =
  | { type: "schedule"; cron: string; timeZone?: string | undefined }
  | { type: "webhook"; token?: string | undefined };

export const AUTOMATION_ACTION_TYPES = ["workflow", "chat", "task"] as const;

export type AutomationAction =
  | { type: "workflow"; workflowId: string; input?: string | undefined }
  | { type: "chat"; conversationId?: ConversationId | undefined; prompt: string }
  | { type: "task"; title?: string | undefined };

export interface Automation {
  id: string;
  project_id: ProjectId;
  name: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  enabled: boolean;
  /** Minute of the last scheduled firing; null before the first one. */
  last_fired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Firing {
  id: string;
  automation_id: string;
  at: string;
  status: AutomationFiringStatus;
  detail: string | null;
  run_id: string | null;
  created_at: string;
}

export type MutationUnknownReason = "io" | "crash" | "timeout";

/** A versioned write's outcome. The workspace returns it; the editor consumes it. */
export type MutationResult =
  | { status: "applied"; operationId: string; version: string }
  | { status: "conflict"; operationId: string; currentVersion: string }
  | { status: "unknown"; operationId: string; reason: MutationUnknownReason };

/** A versioned read of one file. The workspace returns it; the editor consumes it. */
export interface FileRead {
  path: string;
  /** UTF-8 text. */
  content: string;
  version: string;
}

export interface Event {
  id: string;
  /** ISO 8601. */
  at: string;
  level: EventLevel;
  event: EventName;
  request_id: string | null;
  conversation_id: ConversationId | null;
  status: number | null;
  duration_ms: number | null;
  detail: JsonValue | null;
}

export interface NamedCount {
  event: EventName;
  count: number;
}

export interface StatusCount {
  status: string;
  count: number;
}

/** The aggregate store computes from events; the observability view consumes it. */
export interface Metrics {
  http: {
    total: number;
    byStatus: Array<{ status: number; count: number }>;
    p50ms: number;
    p95ms: number;
  };
  chats: Record<string, number>;
  workflowRuns: StatusCount[];
  firings: StatusCount[];
  toolCalls: number;
  toolErrors: number;
  agentResponses: number;
  errors: number;
  tokensToday: { turns: number; tokens: number; cost: number };
  byEvent: NamedCount[];
}

export interface UsageBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface Limits {
  /** 0 means unlimited. Never negative. */
  turnsPerMinute: number;
  dailyTokenBudget: number;
  turnTimeoutMs: number;
}

/** Recorded per turn; the usage view and the limits banner consume it. */
export interface Usage {
  session: { models: Record<string, UsageBucket>; tools: Record<string, UsageBucket> };
  today: { turns: number; tokens: number; cost: number };
  limits: Limits;
}
