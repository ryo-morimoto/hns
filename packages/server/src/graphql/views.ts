import { toGlobalId } from "@hns/core/graphql";
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
  readonly workspaceRoot: string;
  readonly agentCwd: string;
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

/**
 * Map a project to its GraphQL shape.
 *
 * @remarks
 * Ids cross the GraphQL boundary as global ids: the same raw id under another type must not
 * collide in Relay's normalized store.
 */
export function projectView(project: Project): ProjectView {
  return {
    id: toGlobalId("Project", project.id),
    name: project.name,
    workspaceRoot: project.workspace_root,
    agentCwd: project.agent_cwd,
    createdAt: project.created_at,
  };
}

/** Map a conversation to its GraphQL shape. */
export function conversationView(conversation: Conversation): ConversationView {
  return {
    id: toGlobalId("Conversation", conversation.id),
    projectId: toGlobalId("Project", conversation.project_id),
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
    id: toGlobalId("Task", task.id),
    projectId: toGlobalId("Project", task.project_id),
    title: task.title,
    status: task.status,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}
