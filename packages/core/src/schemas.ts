import * as v from "valibot";
import { OperationIdSchema } from "./codecs.ts";
import { ERROR_CODES, TASK_STATUSES } from "./types.ts";
import type {
  ChatRequest,
  ConversationCreate,
  ConversationId,
  ConversationUpdate,
  ErrorResponse,
  FileWriteRequest,
  ProjectCreate,
  ProjectId,
  TaskCreate,
  TaskUpdate,
} from "./types.ts";

export const ProjectIdSchema: v.GenericSchema<unknown, ProjectId> = v.pipe(
  v.string(),
  v.transform((value): ProjectId => {
    // SAFETY: the value is a validated string; the brand exists only in the type.
    return value as ProjectId;
  }),
);

export const ConversationIdSchema: v.GenericSchema<unknown, ConversationId> = v.pipe(
  v.string(),
  v.transform((value): ConversationId => {
    // SAFETY: the value is a validated string; the brand exists only in the type.
    return value as ConversationId;
  }),
);

export const ChatRequestSchema: v.GenericSchema<unknown, ChatRequest> = v.object({
  message: v.pipe(v.string(), v.minLength(1)),
  conversationId: v.optional(ConversationIdSchema),
});

export const ConversationCreateSchema: v.GenericSchema<unknown, ConversationCreate> = v.object({
  projectId: v.optional(ProjectIdSchema),
  title: v.optional(v.string()),
});

export const ConversationUpdateSchema: v.GenericSchema<unknown, ConversationUpdate> = v.object({
  title: v.optional(v.string()),
  archived: v.optional(v.boolean()),
});

export const ProjectCreateSchema: v.GenericSchema<unknown, ProjectCreate> = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
});

export const TaskCreateSchema: v.GenericSchema<unknown, TaskCreate> = v.object({
  projectId: ProjectIdSchema,
  title: v.pipe(v.string(), v.minLength(1)),
});

export const TaskUpdateSchema: v.GenericSchema<unknown, TaskUpdate> = v.object({
  title: v.optional(v.string()),
  status: v.optional(v.picklist(TASK_STATUSES)),
});

export const FileWriteRequestSchema: v.GenericSchema<unknown, FileWriteRequest> = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  content: v.string(),
  expectedVersion: v.union([v.literal("absent"), v.string()]),
  operationId: OperationIdSchema,
});

export const ErrorResponseSchema: v.GenericSchema<unknown, ErrorResponse> = v.object({
  code: v.picklist(ERROR_CODES),
  message: v.string(),
  retryAfterMs: v.optional(v.number()),
});
