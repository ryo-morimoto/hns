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
 * The device key is **not** here (NB2): a list is read by every session, and the key is the value
 * a verifier matches, so the list carries the `fingerprint` a person compares and nothing more.
 * The full public key leaves the registry only in `registerMachine`'s answer
 * ({@link MachineRegistrationView}). The control-plane key is never in either: it is the Worker's
 * secret, and `GET /api/machines/keys` is where its public half is served.
 */
export interface MachineView {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
  readonly fingerprint: string;
  readonly keyAlgorithm: Machine["keyAlgorithm"];
  readonly agentVersion: string;
  readonly lastSeen: number | null;
  readonly status: Machine["status"];
  /** Whether the **requesting** session enrolled this machine; never another operator's subject. */
  readonly isMine: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A `Machine` plus the public key, as `registerMachine` answers (NB2).
 *
 * @remarks
 * The operator who just pasted the key needs to see what was stored, so this one answer carries
 * it. It is the only place the key is returned; a list never does.
 */
export interface MachineRegistrationView extends MachineView {
  readonly publicKey: string;
}

/**
 * Map a machine to its GraphQL shape, without the device key and without anyone's subject.
 *
 * @param machine - The registry row.
 * @param viewer - The requesting session's subject, used only to answer `isMine`.
 * @returns The shape; `isMine` says whether this viewer enrolled it, and the owner's subject never
 * leaves the server.
 *
 * @remarks
 * `owner` is a session subject, which is a person's identity. A list is read by every session, so
 * publishing it would let any operator enumerate who enrolled every machine. `isMine` carries the
 * part a caller acts on: whether this is the machine they may reimage.
 */
export function machineView(machine: Machine, viewer: string): MachineView {
  return {
    id: toGlobalId("Machine", machine.id),
    name: machine.name,
    hostname: machine.hostname,
    fingerprint: machine.fingerprint,
    keyAlgorithm: machine.keyAlgorithm,
    agentVersion: machine.agentVersion,
    lastSeen: machine.lastSeen,
    status: machine.status,
    isMine: machine.owner === viewer,
    createdAt: machine.createdAt,
    updatedAt: machine.updatedAt,
  };
}

/** Map a machine to the registration answer: the GraphQL shape plus its public key. */
export function machineRegistrationView(machine: Machine, viewer: string): MachineRegistrationView {
  return { ...machineView(machine, viewer), publicKey: machine.publicKey };
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
