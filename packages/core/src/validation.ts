// Runtime validation. Each schema is typed as ZodType<T>, so a schema that does not
// fit the model in types.ts fails to compile.
import { z } from "zod";
import type {
  ChatRequest,
  ChatResponse,
  Conversation,
  ConversationCreate,
  ConversationUpdate,
  ErrorResponse,
  Event,
  FileRead,
  FileWriteRequest,
  Health,
  JsonValue,
  Limits,
  Message,
  Metrics,
  MutationResult,
  Project,
  ProjectCreate,
  SandboxStatus,
  State,
  Task,
  TaskCreate,
  TaskUpdate,
  TaskView,
  Usage,
  UsageBucket,
} from "./types.ts";

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const MessageSchema: z.ZodType<Message> = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string().optional(),
  toolName: z.string().optional(),
  toolCalls: z.array(z.string()).optional(),
});

export const TaskViewSchema: z.ZodType<TaskView> = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.string(),
});

export const ProjectSchema: z.ZodType<Project> = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
});

export const ConversationSchema: z.ZodType<Conversation> = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
  archived: z.number(),
  deleted_at: z.string().nullable(),
});

export const ErrorResponseSchema: z.ZodType<ErrorResponse> = z.object({
  error: z.string(),
  reason: z.string().optional(),
  retryAfterMs: z.number().optional(),
});

export const SandboxStatusSchema: z.ZodType<SandboxStatus> = z.object({
  available: z.boolean(),
  bwrap: z.string().optional(),
  version: z.string().optional(),
  reason: z.string().optional(),
});

export const LimitsSchema: z.ZodType<Limits> = z.object({
  turnsPerMinute: z.number(),
  dailyTokenBudget: z.number(),
  turnTimeoutMs: z.number(),
});

export const HealthSchema: z.ZodType<Health> = z.object({
  ok: z.boolean(),
  version: z.number(),
  provider: z.string(),
  model: z.string(),
  auth: z.string(),
  sandbox: SandboxStatusSchema,
  limits: LimitsSchema,
});

export const StateSchema: z.ZodType<State> = z.object({
  messages: z.array(MessageSchema),
  tasks: z.array(TaskViewSchema),
  queued: z.number(),
  scheduling: z.string(),
  provider: z.string(),
  model: z.string(),
  conversations: z.array(ConversationSchema),
  projects: z.array(ProjectSchema),
});

export const ChatRequestSchema: z.ZodType<ChatRequest> = z.object({
  message: z.string(),
  conversationId: z.string().optional(),
});

export const ChatResponseSchema: z.ZodType<ChatResponse> = z.object({
  requestId: z.string(),
  submissionId: z.number(),
  conversationId: z.string(),
});

export const ConversationCreateSchema: z.ZodType<ConversationCreate> = z.object({
  projectId: z.string().optional(),
  title: z.string().optional(),
});

export const ConversationUpdateSchema: z.ZodType<ConversationUpdate> = z.object({
  title: z.string().optional(),
  archived: z.boolean().optional(),
});

export const ProjectCreateSchema: z.ZodType<ProjectCreate> = z.object({ name: z.string() });

export const TaskCreateSchema: z.ZodType<TaskCreate> = z.object({
  projectId: z.string(),
  title: z.string(),
});

export const TaskUpdateSchema: z.ZodType<TaskUpdate> = z.object({
  title: z.string().optional(),
  status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
});

export const TaskSchema: z.ZodType<Task> = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  status: z.enum(["todo", "doing", "done", "blocked"]),
  created_at: z.string(),
  updated_at: z.string(),
});

export const FileWriteRequestSchema: z.ZodType<FileWriteRequest> = z.object({
  path: z.string(),
  content: z.string(),
  expectedVersion: z.string(),
  operationId: z.string(),
});

export const MutationResultSchema: z.ZodType<MutationResult> = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), operationId: z.string(), version: z.string() }),
  z.object({ status: z.literal("conflict"), operationId: z.string(), currentVersion: z.string() }),
  z.object({ status: z.literal("unknown"), operationId: z.string(), reason: z.string() }),
]);

export const FileReadSchema: z.ZodType<FileRead> = z.object({
  path: z.string(),
  content: z.string(),
  version: z.string(),
});

export const EventSchema: z.ZodType<Event> = z.object({
  id: z.string(),
  at: z.string(),
  level: z.enum(["info", "warn", "error"]),
  event: z.string(),
  request_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  status: z.number().nullable(),
  duration_ms: z.number().nullable(),
  detail: JsonValueSchema.nullable(),
});

export const NamedCountSchema = z.object({ event: z.string(), count: z.number() });
export const StatusCountSchema = z.object({ status: z.string(), count: z.number() });

export const MetricsSchema: z.ZodType<Metrics> = z.object({
  http: z.object({
    total: z.number(),
    byStatus: z.array(z.object({ status: z.number(), count: z.number() })),
    p50ms: z.number(),
    p95ms: z.number(),
  }),
  chats: z.record(z.string(), z.number()),
  workflowRuns: z.array(StatusCountSchema),
  firings: z.array(StatusCountSchema),
  toolCalls: z.number(),
  toolErrors: z.number(),
  agentResponses: z.number(),
  errors: z.number(),
  tokensToday: z.object({ turns: z.number(), tokens: z.number(), cost: z.number() }),
  byEvent: z.array(NamedCountSchema),
});

export const UsageBucketSchema: z.ZodType<UsageBucket> = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});

export const UsageSchema: z.ZodType<Usage> = z.object({
  session: z.object({
    models: z.record(z.string(), UsageBucketSchema),
    tools: z.record(z.string(), UsageBucketSchema),
  }),
  today: z.object({ turns: z.number(), tokens: z.number(), cost: z.number() }),
  limits: LimitsSchema,
});
