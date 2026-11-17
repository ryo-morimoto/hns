import { MACHINE_STATUSES } from "../machine-types.ts";
import type { Machine } from "../machine-types.ts";
import { PROJECT_EGRESS_POLICIES, TASK_STATUSES } from "../types.ts";
import type { Conversation, Project, Task } from "../types.ts";
import { defineEntity, enumOf } from "./spec.ts";

// The SDL is generated from these specs; it is never edited by hand.
// Model field -> GraphQL field is explicit: `project_id` -> `projectId`, `archived` -> `isArchived`.

/** The `TaskStatus` GraphQL enum; values keep the model's declaration order. */
export const TaskStatusEnum = enumOf("TaskStatus", TASK_STATUSES);

/** The `ProjectEgress` GraphQL enum; values keep the model's declaration order. */
export const ProjectEgressEnum = enumOf("ProjectEgress", PROJECT_EGRESS_POLICIES);

/** The `Project` GraphQL type. Model snake_case fields are exposed as camelCase. */
export const ProjectEntity = defineEntity<Project>({
  name: "Project",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    name: { name: "name", kind: "scalar", type: "String", nonNull: true },
    workspace_root: { name: "workspaceRoot", kind: "scalar", type: "String", nonNull: true },
    agent_cwd: { name: "agentCwd", kind: "scalar", type: "String", nonNull: true },
    egress: { name: "egress", kind: "enum", typeName: "ProjectEgress", nonNull: true },
    created_at: { name: "createdAt", kind: "scalar", type: "String", nonNull: true },
  },
});

/**
 * The `Conversation` GraphQL type.
 *
 * @remarks
 * `archived` is exposed as `isArchived`; the nullable model fields (`updatedAt`,
 * `deletedAt`) stay nullable.
 */
export const ConversationEntity = defineEntity<Conversation>({
  name: "Conversation",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    project_id: { name: "projectId", kind: "scalar", type: "ID", nonNull: true },
    title: { name: "title", kind: "scalar", type: "String", nonNull: true },
    created_at: { name: "createdAt", kind: "scalar", type: "String", nonNull: true },
    updated_at: { name: "updatedAt", kind: "scalar", type: "String", nonNull: false },
    archived: { name: "isArchived", kind: "scalar", type: "Boolean", nonNull: true },
    deleted_at: { name: "deletedAt", kind: "scalar", type: "String", nonNull: false },
  },
});

/** The `Task` GraphQL type; `status` is the `TaskStatus` enum. */
export const TaskEntity = defineEntity<Task>({
  name: "Task",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    project_id: { name: "projectId", kind: "scalar", type: "ID", nonNull: true },
    title: { name: "title", kind: "scalar", type: "String", nonNull: true },
    status: { name: "status", kind: "enum", typeName: "TaskStatus", nonNull: true },
    created_at: { name: "createdAt", kind: "scalar", type: "String", nonNull: true },
    updated_at: { name: "updatedAt", kind: "scalar", type: "String", nonNull: true },
  },
});

/** The `MachineStatus` GraphQL enum; values keep the model's declaration order. */
export const MachineStatusEnum = enumOf("MachineStatus", MACHINE_STATUSES);

/**
 * The `Machine` GraphQL type (0148).
 *
 * @remarks
 * The registry row as an operator reads it: the id, the name, the tunnel's hostname, the device
 * key's **public** half (the spelling a person compares, never a secret), its fingerprint, the
 * agent version, when it was last seen (epoch milliseconds), and the status. `lastSeen` is nullable
 * before the first probe; `keyAlgorithm` stays a string so an unexpected algorithm is visible.
 */
export const MachineEntity = defineEntity<Machine>({
  name: "Machine",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    name: { name: "name", kind: "scalar", type: "String", nonNull: true },
    hostname: { name: "hostname", kind: "scalar", type: "String", nonNull: true },
    publicKey: { name: "publicKey", kind: "scalar", type: "String", nonNull: true },
    fingerprint: { name: "fingerprint", kind: "scalar", type: "String", nonNull: true },
    keyAlgorithm: { name: "keyAlgorithm", kind: "scalar", type: "String", nonNull: true },
    agentVersion: { name: "agentVersion", kind: "scalar", type: "String", nonNull: true },
    lastSeen: { name: "lastSeen", kind: "scalar", type: "Int", nonNull: false },
    status: { name: "status", kind: "enum", typeName: "MachineStatus", nonNull: true },
    createdAt: { name: "createdAt", kind: "scalar", type: "ID", nonNull: true },
    updatedAt: { name: "updatedAt", kind: "scalar", type: "ID", nonNull: true },
  },
});

/** The model entities the SDL exposes, in declaration order. */
export const ENTITIES = [ProjectEntity, ConversationEntity, TaskEntity, MachineEntity] as const;
/** The model enums the SDL exposes, in declaration order. */
export const ENUMS = [TaskStatusEnum, ProjectEgressEnum, MachineStatusEnum] as const;

/**
 * Model types that the SDL does not carry yet, with the reason.
 *
 * @remarks
 * Entries are unique. Remove an entry when its model type gains a projection; the reason says
 * what blocks it, not just that it is pending.
 */
export const EXCLUDED = [
  { type: "Automation", reason: "needs an entity and a mutation" },
  { type: "AutomationAction", reason: "discriminated union; needs a union type" },
  { type: "AutomationTrigger", reason: "discriminated union; needs a union type" },
  { type: "Event", reason: "JsonValue detail; needs a custom scalar" },
  { type: "Firing", reason: "needs an entity for the automation view" },
  { type: "FileRead", reason: "file bytes stay off GraphQL" },
  { type: "Limits", reason: "operational surface; needs a settings type" },
  { type: "Metrics", reason: "Record and nested anonymous objects" },
  { type: "MutationResult", reason: "discriminated union; needs a union type" },
  { type: "NamedCount", reason: "only used by Metrics" },
  { type: "StatusCount", reason: "only used by Metrics" },
  { type: "Usage", reason: "Record and nested anonymous objects" },
  { type: "UsageBucket", reason: "only used by Usage" },
  { type: "Workflow", reason: "needs an entity and a mutation" },
  { type: "WorkflowEdge", reason: "needs a graph input type" },
  { type: "WorkflowGraph", reason: "needs a graph input type" },
  { type: "WorkflowNode", reason: "needs a graph input type" },
  { type: "WorkflowRun", reason: "needs an entity for the run view" },
  { type: "WorkflowRunNode", reason: "needs an entity for the run view" },
] as const;
