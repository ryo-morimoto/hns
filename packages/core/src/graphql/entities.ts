import { TASK_STATUSES } from "../types.ts";
import type { Conversation, Project, Task } from "../types.ts";
import { defineEntity, enumOf } from "./spec.ts";

// The SDL is generated from these specs; it is never edited by hand.
// Model field -> GraphQL field is explicit: `project_id` -> `projectId`, `archived` -> `isArchived`.

export const TaskStatusEnum = enumOf("TaskStatus", TASK_STATUSES);

export const ProjectEntity = defineEntity<Project>({
  name: "Project",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    name: { name: "name", kind: "scalar", type: "String", nonNull: true },
    created_at: { name: "createdAt", kind: "scalar", type: "String", nonNull: true },
  },
});

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

export const ENTITIES = [ProjectEntity, ConversationEntity, TaskEntity] as const;
export const ENUMS = [TaskStatusEnum] as const;

/** Model types that the SDL does not carry yet, with the reason. */
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
