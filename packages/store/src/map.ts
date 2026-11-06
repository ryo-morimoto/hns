import type {
  Conversation,
  ConversationId,
  Event,
  EventLevel,
  EventName,
  JsonValue,
  Project,
  ProjectId,
  Task,
  TaskStatus,
} from "@hns/core";
import type { ConversationRow, EventRow, ProjectRow, TaskRow } from "./rows.ts";

const TASK_STATUSES: readonly TaskStatus[] = ["todo", "doing", "done", "blocked"];
const EVENT_LEVELS: readonly EventLevel[] = ["info", "warn", "error"];

function taskStatus(value: string): TaskStatus {
  const found = TASK_STATUSES.find((candidate) => candidate === value);

  if (found === undefined) throw new Error("unknown task status: " + value);

  return found;
}

function eventLevel(value: string): EventLevel {
  const found = EVENT_LEVELS.find((candidate) => candidate === value);

  if (found === undefined) throw new Error("unknown event level: " + value);

  return found;
}

function parseDetail(detail: string | null): JsonValue | null {
  if (detail === null) return null;
  const parsed: unknown = JSON.parse(detail);

  // SAFETY: detail is written with JSON.stringify of a JsonValue.
  return parsed as JsonValue;
}

export function toProject(row: ProjectRow): Project {
  // SAFETY: the projects table's id column is the project id.
  const id = row.id as ProjectId;

  return { id, name: row.name, created_at: row.created_at };
}

export function toConversation(row: ConversationRow): Conversation {
  // SAFETY: the conversations table's ids are these ids.
  const id = row.id as ConversationId;
  // SAFETY: conversations.project_id references projects.id.
  const projectId = row.project_id as ProjectId;

  return {
    id,
    project_id: projectId,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived: row.archived === 1,
    deleted_at: row.deleted_at,
  };
}

export function toTask(row: TaskRow): Task {
  // SAFETY: tasks.project_id references projects.id.
  const projectId = row.project_id as ProjectId;

  return {
    id: row.id,
    project_id: projectId,
    title: row.title,
    status: taskStatus(row.status),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toEvent(row: EventRow): Event {
  // SAFETY: event names are written by our own journal.
  const event = row.event as EventName;
  // SAFETY: event conversation ids are conversations ids, or null.
  const conversationId = row.conversation_id as ConversationId | null;

  return {
    id: row.id,
    at: row.at,
    level: eventLevel(row.level),
    event,
    request_id: row.request_id,
    conversation_id: conversationId,
    status: row.status,
    duration_ms: row.duration_ms,
    detail: parseDetail(row.detail),
  };
}
