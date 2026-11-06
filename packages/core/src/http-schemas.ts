// Schemas for the HTTP wire contract (issue 0037). The server parses requests at the boundary;
// tests parse responses. Every schema is typed against the model in ./types.ts and ./http.ts.
import * as v from "valibot";
import {
  AUTH_MODES,
  AUTOMATION_FIRING_STATUSES,
  EVENT_LEVELS,
  EVENT_NAMES,
  SANDBOX_EXEC,
  SANDBOX_USER_NAMESPACES,
  SCHEDULING_STATES,
  TASK_STATES,
  TASK_STATUSES,
  WORKFLOW_NODE_STATUSES,
  WORKFLOW_RUN_STATUSES,
} from "./types.ts";
import { FILE_KINDS, SECRET_SCOPES } from "./http.ts";
import {
  ChatRequestSchema,
  ConversationIdSchema,
  ConversationCreateSchema,
  ConversationUpdateSchema,
  FileWriteRequestSchema,
  ProjectCreateSchema,
  ProjectIdSchema,
  TaskCreateSchema,
  TaskUpdateSchema,
} from "./schemas.ts";
import type {
  AuthMode,
  ChatResponse,
  Conversation,
  Event,
  FileRead,
  JsonValue,
  Limits,
  Message,
  Metrics,
  MutationResult,
  Project,
  SandboxStatus,
  State,
  Task,
  TaskView,
  Usage,
  UsageBucket,
} from "./types.ts";
import type {
  Automation,
  AutomationAction,
  AutomationCreate,
  AutomationTrigger,
  AutomationUpdate,
  ChatAbortRequest,
  DebugTick,
  FileEntry,
  Firing,
  Me,
  PasskeyAddVerify,
  PasskeyLoginStart,
  PasskeyLoginVerify,
  PasskeyOptions,
  PasskeyRegisterVerify,
  PasskeyUser,
  PasskeyVerified,
  ProjectRename,
  RecoveryLogin,
  RunCreate,
  RunNodeComplete,
  Secret,
  SecretPutRequest,
  SecretPutResult,
  SecretSummary,
  StateEvent,
  UnlockRequest,
  WebhookPayload,
  Workflow,
  WorkflowCreate,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowRun,
  WorkflowRunNode,
  WorkflowUpdate,
} from "./http.ts";

const id = v.pipe(v.string(), v.minLength(1));
const iso = v.pipe(v.string(), v.isoTimestamp());
const jsonValue: v.GenericSchema<JsonValue, JsonValue> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(jsonValue),
    v.record(v.string(), jsonValue),
  ]),
);

// ---- domain responses -------------------------------------------------------

export const ProjectSchema: v.GenericSchema<unknown, Project> = v.object({
  id: ProjectIdSchema,
  name: id,
  created_at: iso,
});

export const TaskSchema: v.GenericSchema<unknown, Task> = v.object({
  id,
  project_id: ProjectIdSchema,
  title: id,
  status: v.picklist(TASK_STATUSES),
  created_at: iso,
  updated_at: iso,
});

export const ConversationSchema: v.GenericSchema<unknown, Conversation> = v.object({
  id: ConversationIdSchema,
  project_id: ProjectIdSchema,
  title: v.string(),
  created_at: iso,
  updated_at: v.nullable(iso),
  archived: v.boolean(),
  deleted_at: v.nullable(iso),
});

export const UsageBucketSchema: v.GenericSchema<unknown, UsageBucket> = v.object({
  input: v.number(),
  output: v.number(),
  cacheRead: v.number(),
  cacheWrite: v.number(),
  totalTokens: v.number(),
  cost: v.object({
    input: v.number(),
    output: v.number(),
    cacheRead: v.number(),
    cacheWrite: v.number(),
    total: v.number(),
  }),
});

export const LimitsSchema: v.GenericSchema<unknown, Limits> = v.object({
  turnsPerMinute: v.number(),
  dailyTokenBudget: v.number(),
  turnTimeoutMs: v.number(),
});

const userMessage = v.object({
  role: v.literal("user"),
  text: v.string(),
  timestamp: iso,
});

const assistantMessage = v.object({
  role: v.literal("assistant"),
  text: v.optional(v.string()),
  toolCalls: v.optional(v.array(v.string())),
  model: v.string(),
  usage: v.optional(UsageBucketSchema),
  timestamp: iso,
});

const toolMessage = v.object({
  role: v.literal("tool"),
  toolName: v.string(),
  text: v.string(),
  isError: v.optional(v.boolean()),
  timestamp: iso,
});

export const MessageSchema: v.GenericSchema<unknown, Message> = v.variant("role", [
  userMessage,
  assistantMessage,
  toolMessage,
]);

export const TaskViewSchema: v.GenericSchema<unknown, TaskView> = v.object({
  id,
  kind: v.string(),
  state: v.picklist(TASK_STATES),
});

export const StateSchema: v.GenericSchema<unknown, State> = v.object({
  messages: v.array(MessageSchema),
  tasks: v.array(TaskViewSchema),
  queued: v.number(),
  scheduling: v.picklist(SCHEDULING_STATES),
  provider: v.string(),
  model: v.string(),
  counts: v.object({ conversations: v.number(), projects: v.number() }),
});

export const SandboxStatusSchema: v.GenericSchema<unknown, SandboxStatus> = v.object({
  backend: v.literal("bubblewrap"),
  platform: v.string(),
  shell: v.string(),
  checkedAt: iso,
  available: v.boolean(),
  exec: v.picklist(SANDBOX_EXEC),
  bwrap: v.string(),
  version: v.optional(v.string()),
  userNamespaces: v.picklist(SANDBOX_USER_NAMESPACES),
  sysctls: v.optional(
    v.object({
      maxUserNamespaces: v.nullable(v.number()),
      unprivilegedUsernsClone: v.nullable(v.number()),
      apparmorRestrictUnprivilegedUserns: v.nullable(v.number()),
    }),
  ),
  code: v.optional(v.string()),
  reason: v.optional(v.string()),
});

export const HealthSchema: v.GenericSchema<
  unknown,
  {
    ok: boolean;
    version: string;
    provider: string;
    model: string;
    auth: AuthMode;
    sandbox: SandboxStatus;
    limits: Limits;
  }
> = v.object({
  ok: v.boolean(),
  version: v.string(),
  provider: v.string(),
  model: v.string(),
  auth: v.picklist(AUTH_MODES),
  sandbox: SandboxStatusSchema,
  limits: LimitsSchema,
});

export const EventSchema: v.GenericSchema<unknown, Event> = v.object({
  id,
  at: iso,
  level: v.picklist(EVENT_LEVELS),
  event: v.picklist(EVENT_NAMES),
  request_id: v.nullable(v.string()),
  conversation_id: v.nullable(ConversationIdSchema),
  status: v.nullable(v.number()),
  duration_ms: v.nullable(v.number()),
  detail: v.nullable(jsonValue),
});

export const NamedCountSchema = v.object({ event: v.picklist(EVENT_NAMES), count: v.number() });
export const StatusCountSchema = v.object({ status: v.string(), count: v.number() });

export const MetricsSchema: v.GenericSchema<unknown, Metrics> = v.object({
  http: v.object({
    total: v.number(),
    byStatus: v.array(v.object({ status: v.number(), count: v.number() })),
    p50ms: v.number(),
    p95ms: v.number(),
  }),
  chats: v.record(v.string(), v.number()),
  workflowRuns: v.array(StatusCountSchema),
  firings: v.array(StatusCountSchema),
  toolCalls: v.number(),
  toolErrors: v.number(),
  agentResponses: v.number(),
  errors: v.number(),
  tokensToday: v.object({ turns: v.number(), tokens: v.number(), cost: v.number() }),
  byEvent: v.array(NamedCountSchema),
});

export const UsageSchema: v.GenericSchema<unknown, Usage> = v.object({
  session: v.object({
    models: v.record(v.string(), UsageBucketSchema),
    tools: v.record(v.string(), UsageBucketSchema),
  }),
  today: v.object({ turns: v.number(), tokens: v.number(), cost: v.number() }),
  limits: LimitsSchema,
});

// ---- files ------------------------------------------------------------------

export const FileEntrySchema: v.GenericSchema<unknown, FileEntry> = v.object({
  path: id,
  kind: v.picklist(FILE_KINDS),
});

export const FileReadSchema: v.GenericSchema<unknown, FileRead> = v.object({
  path: id,
  content: v.string(),
  version: v.string(),
});

const mutationUnknownReason = v.picklist(["io", "crash", "timeout"] as const);

export const MutationResultSchema: v.GenericSchema<unknown, MutationResult> = v.variant("status", [
  v.object({ status: v.literal("applied"), operationId: id, version: v.string() }),
  v.object({ status: v.literal("conflict"), operationId: id, currentVersion: v.string() }),
  v.object({ status: v.literal("unknown"), operationId: id, reason: mutationUnknownReason }),
]);

// ---- secrets and identity ---------------------------------------------------

export const SecretSummarySchema: v.GenericSchema<unknown, SecretSummary> = v.object({
  name: id,
  updated_at: iso,
});

export const SecretSchema: v.GenericSchema<unknown, Secret> = v.object({
  scope: v.picklist(SECRET_SCOPES),
  name: id,
  value: v.string(),
});

export const SecretPutRequestSchema: v.GenericSchema<unknown, SecretPutRequest> = v.object({
  value: v.string(),
});

export const SecretPutResultSchema: v.GenericSchema<unknown, SecretPutResult> = v.object({
  scope: v.picklist(SECRET_SCOPES),
  name: id,
});

export const MeSchema: v.GenericSchema<unknown, Me> = v.object({
  user: v.nullable(v.object({ login: id })),
  unlocked: v.boolean(),
  hasWrapped: v.boolean(),
});

// ---- workflows --------------------------------------------------------------

export const WorkflowNodeSchema: v.GenericSchema<unknown, WorkflowNode> = v.variant("type", [
  v.object({ id, type: v.literal("agent"), prompt: id }),
  v.object({ id, type: v.literal("human"), prompt: id }),
  v.object({ id, type: v.literal("tool"), command: id }),
]);

export const WorkflowEdgeSchema: v.GenericSchema<unknown, WorkflowEdge> = v.object({
  from: id,
  to: id,
});

export const WorkflowGraphSchema: v.GenericSchema<unknown, WorkflowGraph> = v.object({
  nodes: v.pipe(v.array(WorkflowNodeSchema), v.minLength(1)),
  edges: v.array(WorkflowEdgeSchema),
});

export const WorkflowSchema: v.GenericSchema<unknown, Workflow> = v.object({
  id,
  project_id: ProjectIdSchema,
  name: id,
  version: v.number(),
  graph: WorkflowGraphSchema,
  created_at: iso,
  updated_at: iso,
});

export const WorkflowRunNodeSchema: v.GenericSchema<unknown, WorkflowRunNode> = v.object({
  node_id: id,
  status: v.picklist(WORKFLOW_NODE_STATUSES),
  prompt: v.nullable(v.string()),
  output: v.nullable(v.string()),
  conversation_id: v.nullable(ConversationIdSchema),
  started_at: v.nullable(iso),
  finished_at: v.nullable(iso),
});

export const WorkflowRunSchema: v.GenericSchema<unknown, WorkflowRun> = v.object({
  id,
  workflow_id: id,
  version: v.number(),
  status: v.picklist(WORKFLOW_RUN_STATUSES),
  input: v.string(),
  output: v.nullable(v.string()),
  created_at: iso,
  finished_at: v.nullable(iso),
  nodes: v.optional(v.array(WorkflowRunNodeSchema)),
});

export const WorkflowCreateSchema: v.GenericSchema<unknown, WorkflowCreate> = v.object({
  projectId: v.optional(ProjectIdSchema),
  name: id,
  graph: WorkflowGraphSchema,
});

export const WorkflowUpdateSchema: v.GenericSchema<unknown, WorkflowUpdate> = v.object({
  graph: WorkflowGraphSchema,
});

export const RunCreateSchema: v.GenericSchema<unknown, RunCreate> = v.object({
  input: v.optional(v.string()),
});

export const RunNodeCompleteSchema: v.GenericSchema<unknown, RunNodeComplete> = v.object({
  output: v.optional(v.string()),
});

// ---- automations ------------------------------------------------------------

export const AutomationTriggerSchema: v.GenericSchema<unknown, AutomationTrigger> = v.variant(
  "type",
  [
    v.object({ type: v.literal("schedule"), cron: id, timeZone: v.optional(v.string()) }),
    v.object({ type: v.literal("webhook"), token: v.optional(id) }),
  ],
);

export const AutomationActionSchema: v.GenericSchema<unknown, AutomationAction> = v.variant(
  "type",
  [
    v.object({ type: v.literal("workflow"), workflowId: id, input: v.optional(v.string()) }),
    v.object({
      type: v.literal("chat"),
      conversationId: v.optional(ConversationIdSchema),
      prompt: id,
    }),
    v.object({ type: v.literal("task"), title: v.optional(id) }),
  ],
);

export const AutomationSchema: v.GenericSchema<unknown, Automation> = v.object({
  id,
  project_id: ProjectIdSchema,
  name: id,
  trigger: AutomationTriggerSchema,
  action: AutomationActionSchema,
  enabled: v.boolean(),
  last_fired_at: v.nullable(v.string()),
  created_at: iso,
  updated_at: iso,
});

export const FiringSchema: v.GenericSchema<unknown, Firing> = v.object({
  id,
  automation_id: id,
  at: iso,
  status: v.picklist(AUTOMATION_FIRING_STATUSES),
  detail: v.nullable(v.string()),
  run_id: v.nullable(id),
  created_at: iso,
});

export const AutomationCreateSchema: v.GenericSchema<unknown, AutomationCreate> = v.object({
  projectId: v.optional(ProjectIdSchema),
  name: id,
  trigger: AutomationTriggerSchema,
  action: AutomationActionSchema,
  enabled: v.optional(v.boolean()),
});

export const AutomationUpdateSchema: v.GenericSchema<unknown, AutomationUpdate> = v.object({
  name: v.optional(id),
  trigger: v.optional(AutomationTriggerSchema),
  action: v.optional(AutomationActionSchema),
  enabled: v.optional(v.boolean()),
});

export const WebhookPayloadSchema: v.GenericSchema<unknown, WebhookPayload> = jsonValue;

// ---- passkey ----------------------------------------------------------------

const wrappedKey = v.object({ wrappedDek: id, iv: id });
const recoveryKey = v.object({ wrappedDek: id, iv: id, salt: id });

export const PasskeyLoginStartSchema: v.GenericSchema<unknown, PasskeyLoginStart> = v.object({
  login: id,
});

export const PasskeyRegisterVerifySchema: v.GenericSchema<unknown, PasskeyRegisterVerify> =
  v.object({
    login: id,
    response: jsonValue,
    wrapped: v.optional(wrappedKey),
    recovery: v.optional(recoveryKey),
  });

export const PasskeyAddVerifySchema: v.GenericSchema<unknown, PasskeyAddVerify> = v.object({
  response: jsonValue,
  wrapped: v.optional(wrappedKey),
});

export const PasskeyLoginVerifySchema: v.GenericSchema<unknown, PasskeyLoginVerify> = v.object({
  login: id,
  response: jsonValue,
});

export const RecoveryLoginSchema: v.GenericSchema<unknown, RecoveryLogin> = v.object({
  login: id,
  code: id,
});

export const UnlockRequestSchema: v.GenericSchema<unknown, UnlockRequest> = v.object({
  dek: id,
});

export const PasskeyUserSchema: v.GenericSchema<unknown, PasskeyUser> = v.object({ login: id });

export const PasskeyVerifiedSchema: v.GenericSchema<unknown, PasskeyVerified> = v.object({
  verified: v.boolean(),
  user: v.optional(v.nullable(PasskeyUserSchema)),
});

export const PasskeyOptionsSchema: v.GenericSchema<unknown, PasskeyOptions> = jsonValue;

// ---- small responses --------------------------------------------------------

export const ChatAbortRequestSchema: v.GenericSchema<unknown, ChatAbortRequest> = v.object({
  conversationId: ConversationIdSchema,
});

export const ProjectRenameSchema: v.GenericSchema<unknown, ProjectRename> = v.object({ name: id });

export const DebugTickSchema: v.GenericSchema<unknown, DebugTick> = v.object({
  at: v.optional(v.string()),
});

export const ChatResponseSchema: v.GenericSchema<unknown, ChatResponse> = v.object({
  requestId: id,
  submissionId: v.number(),
  conversationId: ConversationIdSchema,
});

export const DeletedSchema = v.object({ deleted: v.literal(true) });
export const ConversationDeletedSchema = v.object({
  deleted: v.literal(true),
  durableDataKept: v.boolean(),
});
export const ChatAbortedSchema = v.object({ outcome: v.literal("aborted") });
export const RunStartedSchema = v.object({ id, version: v.number() });
export const RunNodeCompletedSchema = v.object({ runId: id, node: WorkflowRunNodeSchema });
export const HookAcceptedSchema = v.object({ accepted: v.literal(true) });
export const DekSchema = v.object({ dek: id });
export const UnlockedSchema = v.object({ unlocked: v.literal(true) });
export const OkSchema = v.object({ ok: v.literal(true) });
export const RecoveredSchema = v.object({
  recovered: v.literal(true),
  user: v.object({ login: id }),
});

// ---- SSE --------------------------------------------------------------------

export const StateEventSchema: v.GenericSchema<unknown, StateEvent> = v.object({
  event: v.literal("state"),
  data: StateSchema,
});

// ---- query parameters -------------------------------------------------------

export const StateQuerySchema = v.object({ conversationId: v.optional(ConversationIdSchema) });
export const TaskListQuerySchema = v.object({ projectId: v.optional(ProjectIdSchema) });
export const ConversationListQuerySchema = v.object({
  projectId: v.optional(ProjectIdSchema),
  q: v.optional(v.string()),
  includeArchived: v.optional(v.boolean()),
});
export const EventListQuerySchema = v.object({
  limit: v.optional(v.number()),
  level: v.optional(v.picklist(EVENT_LEVELS)),
  since: v.optional(iso),
});
export const RunListQuerySchema = v.object({ workflowId: v.optional(id) });
export const AutomationListQuerySchema = v.object({ projectId: v.optional(ProjectIdSchema) });
export const SecretListQuerySchema = v.object({ scope: v.optional(v.picklist(SECRET_SCOPES)) });
export const FileListQuerySchema = v.object({ path: v.optional(v.string()) });
export const FileQuerySchema = v.object({ path: v.optional(v.string()) });

// ---- route table ------------------------------------------------------------

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RouteContract<TRequest = undefined, TResponse = unknown> {
  readonly method: HttpMethod;
  readonly path: string;
  /** Body or query parameters; absent when the route takes neither. */
  readonly request?: v.GenericSchema<unknown, TRequest> | undefined;
  /** The success body. Every route can also answer with ErrorResponseSchema. */
  readonly response: v.GenericSchema<unknown, TResponse>;
}

function route<TRequest = undefined, TResponse = unknown>(
  method: HttpMethod,
  path: string,
  response: v.GenericSchema<unknown, TResponse>,
  request?: v.GenericSchema<unknown, TRequest>,
): RouteContract<TRequest, TResponse> {
  return request === undefined ? { method, path, response } : { method, path, response, request };
}

export const ROUTES = {
  "GET /api/state": route("GET", "/api/state", StateSchema, StateQuerySchema),
  "GET /api/stream": route("GET", "/api/stream", StateEventSchema, StateQuerySchema),
  "POST /api/chat": route("POST", "/api/chat", ChatResponseSchema, ChatRequestSchema),
  "POST /api/chat/abort": route(
    "POST",
    "/api/chat/abort",
    ChatAbortedSchema,
    ChatAbortRequestSchema,
  ),
  "GET /api/projects": route("GET", "/api/projects", v.array(ProjectSchema)),
  "POST /api/projects": route("POST", "/api/projects", ProjectSchema, ProjectCreateSchema),
  "PATCH /api/projects/:id": route(
    "PATCH",
    "/api/projects/:id",
    ProjectSchema,
    ProjectRenameSchema,
  ),
  "GET /api/tasks": route("GET", "/api/tasks", v.array(TaskSchema), TaskListQuerySchema),
  "POST /api/tasks": route("POST", "/api/tasks", TaskSchema, TaskCreateSchema),
  "PATCH /api/tasks/:id": route("PATCH", "/api/tasks/:id", TaskSchema, TaskUpdateSchema),
  "GET /api/conversations": route(
    "GET",
    "/api/conversations",
    v.array(ConversationSchema),
    ConversationListQuerySchema,
  ),
  "POST /api/conversations": route(
    "POST",
    "/api/conversations",
    ConversationSchema,
    ConversationCreateSchema,
  ),
  "PATCH /api/conversations/:id": route(
    "PATCH",
    "/api/conversations/:id",
    ConversationSchema,
    ConversationUpdateSchema,
  ),
  "DELETE /api/conversations/:id": route(
    "DELETE",
    "/api/conversations/:id",
    ConversationDeletedSchema,
  ),
  "GET /api/files": route("GET", "/api/files", v.array(FileEntrySchema), FileListQuerySchema),
  "GET /api/file": route("GET", "/api/file", FileReadSchema, FileQuerySchema),
  "PUT /api/file": route("PUT", "/api/file", MutationResultSchema, FileWriteRequestSchema),
  "GET /api/me": route("GET", "/api/me", MeSchema),
  "POST /api/passkey/register/options": route(
    "POST",
    "/api/passkey/register/options",
    PasskeyOptionsSchema,
    PasskeyLoginStartSchema,
  ),
  "POST /api/passkey/register/verify": route(
    "POST",
    "/api/passkey/register/verify",
    PasskeyVerifiedSchema,
    PasskeyRegisterVerifySchema,
  ),
  "GET /api/passkey/dek": route("GET", "/api/passkey/dek", DekSchema),
  "POST /api/passkey/add/options": route("POST", "/api/passkey/add/options", PasskeyOptionsSchema),
  "POST /api/passkey/add/verify": route(
    "POST",
    "/api/passkey/add/verify",
    PasskeyVerifiedSchema,
    PasskeyAddVerifySchema,
  ),
  "POST /api/passkey/recovery": route(
    "POST",
    "/api/passkey/recovery",
    RecoveredSchema,
    RecoveryLoginSchema,
  ),
  "POST /api/passkey/unlock": route(
    "POST",
    "/api/passkey/unlock",
    UnlockedSchema,
    UnlockRequestSchema,
  ),
  "POST /api/passkey/login/options": route(
    "POST",
    "/api/passkey/login/options",
    PasskeyOptionsSchema,
    PasskeyLoginStartSchema,
  ),
  "POST /api/passkey/login/verify": route(
    "POST",
    "/api/passkey/login/verify",
    PasskeyVerifiedSchema,
    PasskeyLoginVerifySchema,
  ),
  "POST /api/passkey/logout": route("POST", "/api/passkey/logout", OkSchema),
  "GET /api/secrets": route(
    "GET",
    "/api/secrets",
    v.array(SecretSummarySchema),
    SecretListQuerySchema,
  ),
  "GET /api/secrets/:scope/:name": route("GET", "/api/secrets/:scope/:name", SecretSchema),
  "PUT /api/secrets/:scope/:name": route(
    "PUT",
    "/api/secrets/:scope/:name",
    SecretPutResultSchema,
    SecretPutRequestSchema,
  ),
  "DELETE /api/secrets/:scope/:name": route("DELETE", "/api/secrets/:scope/:name", DeletedSchema),
  "GET /api/automations": route(
    "GET",
    "/api/automations",
    v.array(AutomationSchema),
    AutomationListQuerySchema,
  ),
  "POST /api/automations": route(
    "POST",
    "/api/automations",
    AutomationSchema,
    AutomationCreateSchema,
  ),
  "PATCH /api/automations/:id": route(
    "PATCH",
    "/api/automations/:id",
    AutomationSchema,
    AutomationUpdateSchema,
  ),
  "GET /api/automations/:id/firings": route(
    "GET",
    "/api/automations/:id/firings",
    v.array(FiringSchema),
  ),
  "POST /api/hooks/:token": route(
    "POST",
    "/api/hooks/:token",
    HookAcceptedSchema,
    WebhookPayloadSchema,
  ),
  "GET /api/workflows": route(
    "GET",
    "/api/workflows",
    v.array(WorkflowSchema),
    AutomationListQuerySchema,
  ),
  "POST /api/workflows": route("POST", "/api/workflows", WorkflowSchema, WorkflowCreateSchema),
  "PUT /api/workflows/:id": route(
    "PUT",
    "/api/workflows/:id",
    WorkflowSchema,
    WorkflowUpdateSchema,
  ),
  "POST /api/workflows/:id/runs": route(
    "POST",
    "/api/workflows/:id/runs",
    RunStartedSchema,
    RunCreateSchema,
  ),
  "GET /api/runs": route("GET", "/api/runs", v.array(WorkflowRunSchema), RunListQuerySchema),
  "GET /api/runs/:id": route("GET", "/api/runs/:id", WorkflowRunSchema),
  "POST /api/runs/:id/nodes/:nodeId": route(
    "POST",
    "/api/runs/:id/nodes/:nodeId",
    RunNodeCompletedSchema,
    RunNodeCompleteSchema,
  ),
  "GET /api/events": route("GET", "/api/events", v.array(EventSchema), EventListQuerySchema),
  "GET /api/health": route("GET", "/api/health", HealthSchema),
  "GET /api/metrics": route("GET", "/api/metrics", MetricsSchema),
  "GET /api/usage": route("GET", "/api/usage", UsageSchema),
  "POST /api/debug/tick": route("POST", "/api/debug/tick", OkSchema, DebugTickSchema),
};

export type RouteKey = keyof typeof ROUTES;
