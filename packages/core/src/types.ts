// The model. Types are the source of truth. Each type names who produces and who consumes it.

declare const brand: unique symbol;
/** Nominal wrapper: two ids of different kinds cannot be swapped. Built at the DB boundary. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Only the ids that are easy to mix up get a brand. */
export type ProjectId = Brand<string, "ProjectId">;
export type ConversationId = Brand<string, "ConversationId">;

export type TaskStatus = "todo" | "doing" | "done" | "blocked";
export type RunStatus = "queued" | "running" | "waiting" | "done" | "failed";
export type AuthMode = "token" | "tailscale" | "passkey" | "none";
export type EventLevel = "info" | "warn" | "error";
export type MessageRole = "user" | "assistant" | "tool";
export type Scheduling = "paused" | "running" | "closing";
export type TaskState = "running" | "pending" | "waiting" | "sleeping" | "completing" | "blocked";
export type TaskKind = string;

export type EventName =
  | "server.start"
  | "auth.denied"
  | "http"
  | "http.error"
  | "chat.submitted"
  | "chat.settled"
  | "chat.aborted"
  | "chat.rate_limited"
  | "chat.budget_exceeded"
  | "agent.response"
  | "tool.call"
  | "tool.result"
  | "conversation.created"
  | "conversation.updated"
  | "conversation.deleted"
  | "project.created"
  | "project.renamed"
  | "task.created"
  | "task.updated"
  | "secret.put"
  | "secret.delete"
  | "file.write"
  | "workflow.created"
  | "workflow.updated"
  | "workflow.run.started"
  | "workflow.run.finished"
  | "workflow.run.failed"
  | "workflow.node.started"
  | "workflow.node.finished"
  | "workflow.node.waiting"
  | "automation.created"
  | "automation.fired"
  | "automation.skipped"
  | "automation.finished";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { [key: string]: JsonValue };

interface MessageBase {
  /** ISO 8601 (UTC). Ordering key for the transcript. */
  timestamp: string;
}

export interface UserMessage extends MessageBase {
  role: "user";
  text: string;
}

export interface AssistantMessage extends MessageBase {
  role: "assistant";
  text?: string | undefined;
  /** Names of the tools this turn asked for. */
  toolCalls?: string[] | undefined;
  /** The model that produced the turn (provider/model). */
  model: string;
  /** Usage of this turn, when the provider reported it. */
  usage?: UsageBucket | undefined;
}

export interface ToolMessage extends MessageBase {
  role: "tool";
  toolName: string;
  text: string;
  isError?: boolean | undefined;
}

/** One turn. Produced by /api/state; consumed by the transcript. */
export type Message = UserMessage | AssistantMessage | ToolMessage;

/** A live Durable task. Produced by /api/state; consumed by the progress panel. */
export interface TaskView {
  id: string;
  kind: TaskKind;
  state: TaskState;
}

/** Produced by GET/POST /api/projects; consumed by the project list. */
export interface Project {
  id: ProjectId;
  name: string;
  /** ISO 8601. */
  created_at: string;
}

/** Produced by /api/conversations; consumed by the conversation list and the header. */
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

/** Any non-2xx response. Produced by every endpoint; consumed by the client error path. */
export interface ErrorResponse {
  error: string;
  reason?: string | undefined;
  retryAfterMs?: number | undefined;
}

/** Produced by /api/health; consumed by the login and settings views. */
export type SandboxStatus =
  | { available: true; bwrap: string; version: string }
  | { available: false; reason: string };

export interface Limits {
  /** 0 means unlimited. Never negative. */
  turnsPerMinute: number;
  dailyTokenBudget: number;
  turnTimeoutMs: number;
}

/** Produced by /api/health; consumed by the login and settings views. */
export interface Health {
  ok: boolean;
  /** Server semver. */
  version: string;
  provider: string;
  model: string;
  auth: AuthMode;
  sandbox: SandboxStatus;
  limits: Limits;
}

/** The chat view. Produced by /api/state; consumed by the chat view and the progress panel. */
export interface State {
  messages: Message[];
  tasks: TaskView[];
  queued: number;
  scheduling: Scheduling;
  provider: string;
  model: string;
  /** Counts only; lists come from their own endpoints. */
  counts: { conversations: number; projects: number };
}

/** Produced by the client, consumed by POST /api/chat. */
export interface ChatRequest {
  message: string;
  conversationId?: ConversationId | undefined;
}

/** Produced by POST /api/chat; consumed by the client to follow the run. */
export interface ChatResponse {
  requestId: string;
  /** Opaque submission id. */
  submissionId: number;
  conversationId: ConversationId;
}

/** Produced by the client, consumed by POST /api/conversations. */
export interface ConversationCreate {
  projectId?: ProjectId | undefined;
  title?: string | undefined;
}

/** Produced by the client, consumed by PATCH /api/conversations/:id. */
export interface ConversationUpdate {
  title?: string | undefined;
  archived?: boolean | undefined;
}

export interface ProjectCreate {
  name: string;
}

export interface TaskCreate {
  projectId: ProjectId;
  title: string;
}

export interface TaskUpdate {
  title?: string | undefined;
  status?: TaskStatus | undefined;
}

/** Produced by /api/tasks; consumed by the task list. */
export interface Task {
  id: string;
  project_id: ProjectId;
  title: string;
  status: TaskStatus;
  /** ISO 8601. */
  created_at: string;
  updated_at: string;
}

/** Produced by the client, consumed by PUT /api/file. */
export interface FileWriteRequest {
  path: string;
  /** UTF-8 text. Binary content is out of scope for now. */
  content: string;
  expectedVersion: string | "absent";
  operationId: string;
}

export type MutationUnknownReason = "io" | "crash" | "timeout";

/** Produced by PUT /api/file; consumed by the editor. */
export type MutationResult =
  | { status: "applied"; operationId: string; version: string }
  | { status: "conflict"; operationId: string; currentVersion: string }
  | { status: "unknown"; operationId: string; reason: MutationUnknownReason };

/** Produced by GET /api/file; consumed by the editor. */
export interface FileRead {
  path: string;
  /** UTF-8 text. */
  content: string;
  version: string;
}

/** Produced by /api/events; consumed by the observability view and tests. */
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

/** Produced by /api/metrics; consumed by the dashboard. */
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

/** Produced by /api/usage; consumed by the dashboard and the limits banner. */
export interface Usage {
  session: { models: Record<string, UsageBucket>; tools: Record<string, UsageBucket> };
  today: { turns: number; tokens: number; cost: number };
  limits: Limits;
}
