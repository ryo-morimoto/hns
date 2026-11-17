import { toGlobalId } from "@hns/core/graphql";
import type { Conversation, Machine, Project, Task } from "@hns/core";
import type { IndexStateRow } from "@hns/store";

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
  readonly egress: Project["egress"];
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
    egress: project.egress,
    createdAt: project.created_at,
  };
}

/** The `IndexState` GraphQL shape: the conversation index's backlog and last failure. */
export interface IndexStateView {
  readonly pending: number;
  readonly lastSyncedAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
}

/** Map the index state to its GraphQL shape. */
export function indexStateView(state: IndexStateRow): IndexStateView {
  return {
    pending: state.pending,
    lastSyncedAt: state.lastSyncedAt,
    lastErrorCode: state.lastErrorCode,
    lastErrorAt: state.lastErrorAt,
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

/**
 * A `Machine` as GraphQL serves it (0148).
 *
 * @remarks
 * The device key is the **public** half in the model's base64url spelling; the fingerprint is the
 * value a person compares with the machine. The control-plane key is never here: it is the
 * Worker's secret, and `GET /api/machines/keys` is where its public half is served.
 */
export interface MachineView {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly keyAlgorithm: Machine["keyAlgorithm"];
  readonly agentVersion: string;
  readonly lastSeen: number | null;
  readonly status: Machine["status"];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Map a machine to its GraphQL shape. */
export function machineView(machine: Machine): MachineView {
  return {
    id: toGlobalId("Machine", machine.id),
    name: machine.name,
    hostname: machine.hostname,
    publicKey: machine.publicKey,
    fingerprint: machine.fingerprint,
    keyAlgorithm: machine.keyAlgorithm,
    agentVersion: machine.agentVersion,
    lastSeen: machine.lastSeen,
    status: machine.status,
    createdAt: machine.createdAt,
    updatedAt: machine.updatedAt,
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
