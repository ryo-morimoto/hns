// HTTP wire contract (issue 0037). The server produces these shapes and the web client consumes
// them. The domain model lives in types.ts; this module adds what exists only on the wire.
import type {
  AutomationFiringStatus,
  ConversationId,
  JsonValue,
  ProjectId,
  State,
  WorkflowNodeStatus,
  WorkflowRunStatus,
} from "./types.ts";

// HTTP surface (issue 0037). Types in this section are the wire contract: the server produces
// them and the web client consumes them. Each one names the endpoint that owns it.

export const FILE_KINDS = ["file", "directory", "symlink"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** One entry of GET /api/files. */
export interface FileEntry {
  path: string;
  kind: FileKind;
}

export const SECRET_SCOPES = ["user", "service"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

/** Produced by GET /api/secrets; consumed by the settings view. */
export interface SecretSummary {
  name: string;
  /** ISO 8601. */
  updated_at: string;
}

/** Produced by GET /api/secrets/:scope/:name. */
export interface Secret {
  scope: SecretScope;
  name: string;
  value: string;
}

/** Produced by PUT /api/secrets/:scope/:name. */
export interface SecretPutResult {
  scope: SecretScope;
  name: string;
}

/** Produced by GET /api/me; consumed by the login and settings views. */
export interface Me {
  user: { login: string } | null;
  unlocked: boolean;
  hasWrapped: boolean;
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

/** Produced by /api/workflows; consumed by the workflow editor. */
export interface Workflow {
  id: string;
  project_id: ProjectId;
  name: string;
  /** Bumped on every PUT. A run pins the version it started with. */
  version: number;
  graph: WorkflowGraph;
  created_at: string;
  updated_at: string;
}

/** One node of a run. Produced by GET /api/runs/:id; consumed by the run view. */
export interface WorkflowRunNode {
  node_id: string;
  status: WorkflowNodeStatus;
  prompt: string | null;
  output: string | null;
  conversation_id: ConversationId | null;
  started_at: string | null;
  finished_at: string | null;
}

/** Produced by /api/runs; consumed by the run list and the run view. */
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
  /** Only GET /api/runs/:id includes the nodes. */
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

/** Produced by /api/automations; consumed by the automation list. */
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

/** Produced by GET /api/automations/:id/firings; consumed by the automation view. */
export interface Firing {
  id: string;
  automation_id: string;
  at: string;
  status: AutomationFiringStatus;
  detail: string | null;
  run_id: string | null;
  created_at: string;
}

// Request bodies. Produced by the client, consumed by the server.

export interface ProjectRename {
  name: string;
}

export interface ChatAbortRequest {
  conversationId: ConversationId;
}

export const CHAT_ABORT_OUTCOMES = ["aborted", "already_placed", "settled"] as const;
export type ChatAbortOutcome = (typeof CHAT_ABORT_OUTCOMES)[number];

/** Produced by POST /api/chat/abort. "settled" means the run finished before the abort arrived. */
export interface ChatAbortResponse {
  outcome: ChatAbortOutcome;
}

export interface WorkflowCreate {
  projectId?: ProjectId | undefined;
  name: string;
  graph: WorkflowGraph;
}

export interface WorkflowUpdate {
  /** The version the edit is based on; a mismatch is a 409, like the file API's expectedVersion. */
  version: number;
  graph: WorkflowGraph;
}

export interface RunCreate {
  input?: string | undefined;
}

export interface RunNodeComplete {
  output?: string | undefined;
}

export interface SecretPutRequest {
  value: string;
}

export interface DebugTick {
  /** ISO 8601; defaults to now. Only mounted when allowDebug is set. */
  at?: string | undefined;
}

export interface AutomationCreate {
  projectId?: ProjectId | undefined;
  name: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  enabled?: boolean | undefined;
}

export interface AutomationUpdate {
  name?: string | undefined;
  trigger?: AutomationTrigger | undefined;
  action?: AutomationAction | undefined;
  enabled?: boolean | undefined;
}

/** POST /api/hooks/:token takes arbitrary JSON; a string `body` is passed to the action. */
export type WebhookPayload = JsonValue;

// Passkey. The WebAuthn payloads are owned by @simplewebauthn in store/identity, so the wire
// type stays JSON here; the surrounding fields are ours.

export interface WrappedKey {
  wrappedDek: string;
  iv: string;
}

export interface RecoveryKey extends WrappedKey {
  salt: string;
}

export interface PasskeyLoginStart {
  login: string;
}

export interface PasskeyRegisterVerify {
  login: string;
  response: JsonValue;
  wrapped?: WrappedKey | undefined;
  recovery?: RecoveryKey | undefined;
}

export interface PasskeyAddVerify {
  response: JsonValue;
  wrapped?: WrappedKey | undefined;
}

export interface PasskeyLoginVerify {
  login: string;
  response: JsonValue;
}

export interface RecoveryLogin {
  login: string;
  code: string;
}

export interface UnlockRequest {
  dek: string;
}

export interface PasskeyUser {
  login: string;
}

/** Passkey registration and login options. The key set is @simplewebauthn's. */
export type PasskeyOptions = JsonValue;

/** Produced by the passkey verify endpoints. */
export interface PasskeyVerified {
  verified: boolean;
  user?: PasskeyUser | null | undefined;
}

/** SSE event names. Only `state` is emitted today; heartbeats are comments, not events. */
export const SSE_EVENT_NAMES = ["state"] as const;
export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

export type StateEvent = { event: "state"; data: State };
