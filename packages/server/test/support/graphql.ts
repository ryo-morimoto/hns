import * as v from "valibot";
import {
  ConversationIdSchema,
  ProjectIdSchema,
  type Conversation,
  type Project,
  type Task,
  type TaskStatus,
} from "@hns/core";

const AT = "2026-01-01T00:00:00.000Z";

/** A project with stable timestamps. */
export function project(id: string, name: string = id): Project {
  return { id: v.parse(ProjectIdSchema, id), name, created_at: AT };
}

/** A conversation in `projectId`. */
export function conversation(
  id: string,
  projectId: string,
  title: string = id,
  updated: string | null = null,
): Conversation {
  return {
    id: v.parse(ConversationIdSchema, id),
    project_id: v.parse(ProjectIdSchema, projectId),
    title,
    created_at: AT,
    updated_at: updated,
    archived: false,
    deleted_at: null,
  };
}

/** A task in `projectId`. */
export function task(
  id: string,
  projectId: string,
  title: string = id,
  status: TaskStatus = "todo",
): Task {
  return {
    id,
    project_id: v.parse(ProjectIdSchema, projectId),
    title,
    status,
    created_at: AT,
    updated_at: AT,
  };
}
