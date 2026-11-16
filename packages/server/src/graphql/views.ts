import type { Conversation, Project, Task } from "@hns/core";

/**
 * A `Project` as GraphQL serves it.
 *
 * @remarks
 * The mapping is explicit rather than a shared field resolver: the storage shape stays in the
 * server, and a model rename fails to compile here instead of silently returning `undefined`.
 */
export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** The `Conversation` GraphQL shape. `archived` is exposed as `isArchived`. */
export interface ConversationView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly isArchived: boolean;
  readonly deletedAt: string | null;
}

/** The `Task` GraphQL shape; `status` stays a model value until the enum serializes it. */
export interface TaskView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: Task["status"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Map a project to its GraphQL shape. */
export function projectView(project: Project): ProjectView {
  return { id: project.id, name: project.name, createdAt: project.created_at };
}

/** Map a conversation to its GraphQL shape. */
export function conversationView(conversation: Conversation): ConversationView {
  return {
    id: conversation.id,
    projectId: conversation.project_id,
    title: conversation.title,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at,
    isArchived: conversation.archived,
    deletedAt: conversation.deleted_at,
  };
}

/** Map a task to its GraphQL shape. */
export function taskView(task: Task): TaskView {
  return {
    id: task.id,
    projectId: task.project_id,
    title: task.title,
    status: task.status,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}
