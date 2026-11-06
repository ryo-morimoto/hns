// The model. Types are the source of truth.

export type TaskStatus = "todo" | "doing" | "done" | "blocked";
export type RunStatus = "queued" | "running" | "waiting" | "done" | "failed";
export type AuthMode = "token" | "tailscale" | "passkey" | "none";
export type EventLevel = "info" | "warn" | "error";
export type MessageRole = "user" | "assistant" | "tool";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Message {
  role: MessageRole;
  /** The visible text. Empty for a tool-calling assistant turn. */
  text?: string | undefined;
  /** Set on tool results. */
  toolName?: string | undefined;
  /** Names of the tools an assistant turn asked for. */
  toolCalls?: string[] | undefined;
}

export interface TaskView {
  id: string;
  kind: string;
  state: string;
}

export interface Project {
  id: string;
  name: string;
  created_at: string;
}

export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string | null;
  archived: number;
  deleted_at: string | null;
}

export interface ErrorResponse {
  error: string;
  reason?: string | undefined;
  retryAfterMs?: number | undefined;
}

export interface SandboxStatus {
  available: boolean;
  bwrap?: string | undefined;
  version?: string | undefined;
  reason?: string | undefined;
}

export interface Limits {
  turnsPerMinute: number;
  dailyTokenBudget: number;
  turnTimeoutMs: number;
}

export interface Health {
  ok: boolean;
  version: number;
  provider: string;
  model: string;
  auth: string;
  sandbox: SandboxStatus;
  limits: Limits;
}

export interface State {
  messages: Message[];
  tasks: TaskView[];
  queued: number;
  scheduling: string;
  provider: string;
  model: string;
  conversations: Conversation[];
  projects: Project[];
}

export interface ChatRequest {
  message: string;
  conversationId?: string | undefined;
}

export interface ChatResponse {
  requestId: string;
  submissionId: number;
  conversationId: string;
}

export interface ConversationCreate {
  projectId?: string | undefined;
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
  projectId: string;
  title: string;
}

export interface TaskUpdate {
  title?: string | undefined;
  status?: TaskStatus | undefined;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface FileWriteRequest {
  path: string;
  content: string;
  expectedVersion: string;
  operationId: string;
}

export type MutationResult =
  | { status: "applied"; operationId: string; version: string }
  | { status: "conflict"; operationId: string; currentVersion: string }
  | { status: "unknown"; operationId: string; reason: string };

export interface FileRead {
  path: string;
  content: string;
  version: string;
}

export interface Event {
  id: string;
  at: string;
  level: EventLevel;
  event: string;
  request_id: string | null;
  conversation_id: string | null;
  status: number | null;
  duration_ms: number | null;
  detail: JsonValue | null;
}

export interface NamedCount {
  event: string;
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