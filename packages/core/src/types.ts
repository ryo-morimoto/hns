// The model. Types are the source of truth.

declare const brand: unique symbol;
/** Nominal wrapper: two ids of different kinds cannot be swapped. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, "ProjectId">;
export type ConversationId = Brand<string, "ConversationId">;
export type TaskId = Brand<string, "TaskId">;
export type EventId = Brand<string, "EventId">;
export type RequestId = Brand<string, "RequestId">;
export type OperationId = Brand<string, "OperationId">;
export type SubmissionId = Brand<string, "SubmissionId">;
export type FileVersion = Brand<string, "FileVersion">;
export type ServerVersion = Brand<string, "ServerVersion">;
export type IsoDateTime = Brand<string, "IsoDateTime">;

export type TaskStatus = "todo" | "doing" | "done" | "blocked";
export type RunStatus = "queued" | "running" | "waiting" | "done" | "failed";
export type AuthMode = "token" | "tailscale" | "passkey" | "none";
export type EventLevel = "info" | "warn" | "error";
export type MessageRole = "user" | "assistant" | "tool";
export type Scheduling = "paused" | "running" | "closing";
/** The Durable task that is live. */
export type TaskState = "running" | "pending" | "waiting" | "sleeping" | "completing" | "blocked";
/** The task definition's name. Open by design: extensions add tasks. */
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
  | JsonValue[]
  | { [key: string]: JsonValue };

/** One turn as the UI sees it. The role decides which fields exist. */
export type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string | undefined; toolCalls?: string[] | undefined }
  | { role: "tool"; toolName: string; text: string; isError?: boolean | undefined };

export interface TaskView {
  id: TaskId;
  kind: TaskKind;
  state: TaskState;
}

export interface Project {
  id: ProjectId;
  name: string;
  created_at: IsoDateTime;
}

export interface Conversation {
  id: ConversationId;
  project_id: ProjectId;
  title: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime | null;
  archived: boolean;
  deleted_at: IsoDateTime | null;
}

export interface ErrorResponse {
  error: string;
  reason?: string | undefined;
  retryAfterMs?: number | undefined;
}

export type SandboxStatus =
  | { available: true; bwrap: string; version: string }
  | { available: false; reason: string };

export interface Limits {
  /** 0 means unlimited. Never negative. */
  turnsPerMinute: number;
  dailyTokenBudget: number;
  turnTimeoutMs: number;
}

export interface Health {
  ok: boolean;
  version: ServerVersion;
  provider: string;
  model: string;
  auth: AuthMode;
  sandbox: SandboxStatus;
  limits: Limits;
}

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

export interface ChatRequest {
  message: string;
  conversationId?: ConversationId | undefined;
}

export interface ChatResponse {
  requestId: RequestId;
  submissionId: SubmissionId;
  conversationId: ConversationId;
}

export interface ConversationCreate {
  projectId?: ProjectId | undefined;
  title?: string | undefined;
}

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

export interface Task {
  id: TaskId;
  project_id: ProjectId;
  title: string;
  status: TaskStatus;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface FileWriteRequest {
  path: string;
  /** UTF-8 text. Binary content is out of scope for now. */
  content: string;
  expectedVersion: FileVersion | "absent";
  operationId: OperationId;
}

export type MutationUnknownReason = "io" | "crash" | "timeout";

export type MutationResult =
  | { status: "applied"; operationId: OperationId; version: FileVersion }
  | { status: "conflict"; operationId: OperationId; currentVersion: FileVersion }
  | { status: "unknown"; operationId: OperationId; reason: MutationUnknownReason };

export interface FileRead {
  path: string;
  /** UTF-8 text. */
  content: string;
  version: FileVersion;
}

export interface Event {
  id: EventId;
  at: IsoDateTime;
  level: EventLevel;
  event: EventName;
  request_id: RequestId | null;
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

export interface Usage {
  session: { models: Record<string, UsageBucket>; tools: Record<string, UsageBucket> };
  today: { turns: number; tokens: number; cost: number };
  limits: Limits;
}
