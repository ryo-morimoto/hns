import * as v from "valibot";
import { EVENT_LEVELS, EVENT_NAMES, TASK_STATUSES } from "@hns/core";
import type {
  Conversation,
  ConversationId,
  Event,
  JsonValue,
  Project,
  ProjectId,
  Task,
} from "@hns/core";

const projectId = v.pipe(
  v.string(),
  v.transform((value): ProjectId => {
    // SAFETY: the value is a validated string; the brand exists only in the type.
    return value as ProjectId;
  }),
);

const conversationId = v.pipe(
  v.string(),
  v.transform((value): ConversationId => {
    // SAFETY: the value is a validated string; the brand exists only in the type.
    return value as ConversationId;
  }),
);

const parseDetail = v.transform((text: string | null): JsonValue | null => {
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);

  // SAFETY: detail is written with JSON.stringify of a JsonValue.
  return parsed as JsonValue;
});

export const ProjectRowSchema: v.GenericSchema<unknown, Project> = v.object({
  id: projectId,
  name: v.string(),
  created_at: v.string(),
});

export const ConversationRowSchema: v.GenericSchema<unknown, Conversation> = v.object({
  id: conversationId,
  project_id: projectId,
  title: v.string(),
  created_at: v.string(),
  updated_at: v.nullable(v.string()),
  archived: v.pipe(
    v.picklist([0, 1]),
    v.transform((flag) => flag === 1),
  ),
  deleted_at: v.nullable(v.string()),
});

export const TaskRowSchema: v.GenericSchema<unknown, Task> = v.object({
  id: v.string(),
  project_id: projectId,
  title: v.string(),
  status: v.picklist(TASK_STATUSES),
  created_at: v.string(),
  updated_at: v.string(),
});

export const EventRowSchema: v.GenericSchema<unknown, Event> = v.object({
  id: v.string(),
  at: v.string(),
  level: v.picklist(EVENT_LEVELS),
  event: v.picklist(EVENT_NAMES),
  request_id: v.nullable(v.string()),
  conversation_id: v.nullable(conversationId),
  status: v.nullable(v.number()),
  duration_ms: v.nullable(v.number()),
  detail: v.pipe(v.nullable(v.string()), parseDetail),
});

export type ProjectRow = v.InferInput<typeof ProjectRowSchema>;
export type ConversationRow = v.InferInput<typeof ConversationRowSchema>;
export type TaskRow = v.InferInput<typeof TaskRowSchema>;
export type EventRow = v.InferInput<typeof EventRowSchema>;
