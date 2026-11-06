import { z } from "zod";

/** One message as the UI sees it. Tool results carry the tool name, not the content of the file. */
export const Message = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string().optional(),
  toolName: z.string().optional(),
  toolCalls: z.array(z.string()).optional(),
});

export const TaskView = z.object({ id: z.string(), kind: z.string(), state: z.string() });
export const Project = z.object({ id: z.string(), name: z.string(), created_at: z.string() });
export const Conversation = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
  archived: z.number(),
  deleted_at: z.string().nullable(),
});

export const ErrorResponse = z.object({
  error: z.string(),
  reason: z.string().optional(),
  retryAfterMs: z.number().optional(),
});

export const SandboxStatus = z.object({
  available: z.boolean(),
  bwrap: z.string().optional(),
  version: z.string().optional(),
  reason: z.string().optional(),
});

export const Limits = z.object({
  turnsPerMinute: z.number(),
  dailyTokenBudget: z.number(),
  turnTimeoutMs: z.number(),
});

export const Health = z.object({
  ok: z.boolean(),
  version: z.number(),
  provider: z.string(),
  model: z.string(),
  auth: z.string(),
  sandbox: SandboxStatus,
  limits: Limits,
});

export const State = z.object({
  messages: z.array(Message),
  tasks: z.array(TaskView),
  queued: z.number(),
  scheduling: z.string(),
  provider: z.string(),
  model: z.string(),
  conversations: z.array(Conversation),
  projects: z.array(Project),
});

export const ChatRequest = z.object({ message: z.string(), conversationId: z.string().optional() });
export const ChatResponse = z.object({
  requestId: z.string(),
  submissionId: z.number(),
  conversationId: z.string(),
});

export const ConversationCreate = z.object({ projectId: z.string().optional(), title: z.string().optional() });
export const ConversationUpdate = z.object({ title: z.string().optional(), archived: z.boolean().optional() });

export const ProjectCreate = z.object({ name: z.string() });
export const TaskCreate = z.object({ projectId: z.string(), title: z.string() });
export const TaskUpdate = z.object({ title: z.string().optional(), status: z.string().optional() });
export const Task = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const FileWriteRequest = z.object({
  path: z.string(),
  content: z.string(),
  expectedVersion: z.string(),
  operationId: z.string(),
});

export const MutationResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("applied"), operationId: z.string(), version: z.string() }),
  z.object({ status: z.literal("conflict"), operationId: z.string(), currentVersion: z.string() }),
  z.object({ status: z.literal("unknown"), operationId: z.string(), reason: z.string() }),
]);

export const FileRead = z.object({ path: z.string(), content: z.string(), version: z.string() });

export const Event = z.object({
  id: z.string(),
  at: z.string(),
  level: z.string(),
  event: z.string(),
  request_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
  status: z.number().nullable(),
  duration_ms: z.number().nullable(),
  detail: z.unknown().nullable(),
});

export const CountRow = z.object({ status: z.number(), count: z.number() });
export const NamedCount = z.object({ event: z.string(), count: z.number() });

export const Metrics = z.object({
  http: z.object({
    total: z.number(),
    byStatus: z.array(CountRow),
    p50ms: z.number(),
    p95ms: z.number(),
  }),
  chats: z.record(z.string(), z.number()),
  workflowRuns: z.array(z.object({ status: z.string(), count: z.number() })),
  firings: z.array(z.object({ status: z.string(), count: z.number() })),
  toolCalls: z.number(),
  toolErrors: z.number(),
  agentResponses: z.number(),
  errors: z.number(),
  tokensToday: z.object({ turns: z.number(), tokens: z.number(), cost: z.number() }),
  byEvent: z.array(NamedCount),
});

export const Usage = z.object({
  session: z.object({ models: z.record(z.string(), z.unknown()), tools: z.record(z.string(), z.unknown()) }),
  today: z.object({ turns: z.number(), tokens: z.number(), cost: z.number() }),
  limits: Limits,
});
