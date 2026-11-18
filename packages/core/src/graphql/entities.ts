import { MACHINE_STATUSES } from "../machine-types.ts";
import type { Machine } from "../machine-types.ts";
import {
  TRAIL_CHANGE_STATES,
  TRAIL_DECISION_ACTIONS,
  TRAIL_FINDING_SEVERITIES,
  TRAIL_FINDING_SOURCES,
  TRAIL_FINDING_STATUSES,
  TRAIL_GATE_KINDS,
  TRAIL_GATE_STATUSES,
  TRAIL_KINDS,
  TRAIL_PRIORITIES,
  TRAIL_STATES,
} from "../trail.ts";
import type {
  Trail,
  TrailChange,
  TrailDecision,
  TrailFinding,
  TrailGate,
  TrailSession,
} from "../trail.ts";
import { PROJECT_EGRESS_POLICIES } from "../types.ts";
import type { Conversation, Project } from "../types.ts";
import { defineEntity, enumOf } from "./spec.ts";

// The SDL is generated from these specs; it is never edited by hand.
// Model field -> GraphQL field is explicit: `project_id` -> `projectId`, `archived` -> `isArchived`.

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

/** The `MachineStatus` GraphQL enum; values keep the model's declaration order. */
export const MachineStatusEnum = enumOf("MachineStatus", MACHINE_STATUSES);

/**
 * The `Machine` GraphQL type (0148).
 *
 * @remarks
 * The registry row as an operator reads it: the id, the name, the tunnel's hostname, the device
 * key's **fingerprint** (the short value a person compares), the agent version, when it was last
 * seen (epoch milliseconds), the status, and whether **this viewer** enrolled it. `lastSeen` is
 * nullable before the first probe; `keyAlgorithm` stays a string so an unexpected algorithm is
 * visible.
 *
 * **The device key itself is not here** (NB2). It is public key material, but it is also the
 * identifier a verifier matches, and a list is readable by every session; the full key leaves the
 * registry only in `registerMachine`'s answer, where the operator who just pasted it needs to see
 * what was stored. The fingerprint is enough to compare two machines by eye.
 *
 * **The owner's subject is not here either** (review): `machines.created_by` is a session subject,
 * which is a person's identity, and a list is read by every session. The list therefore carries
 * `mine`, computed per request from the viewer's own subject, so an operator learns whether a
 * machine is theirs (the one they may reimage) without learning who else enrolled the others.
 * `mine` is the one field that is not a stored value: it is computed per request from the viewer's
 * own subject, so the entity type here is the row plus that viewer fact (`Machine` supplies every
 * field but `publicKey` and `owner`, and `mine` is added).
 */
export const MachineEntity = defineEntity<
  Omit<Machine, "publicKey" | "owner"> & { readonly mine: boolean }
>({
  name: "Machine",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    name: { name: "name", kind: "scalar", type: "String", nonNull: true },
    hostname: { name: "hostname", kind: "scalar", type: "String", nonNull: true },
    fingerprint: { name: "fingerprint", kind: "scalar", type: "String", nonNull: true },
    keyAlgorithm: { name: "keyAlgorithm", kind: "scalar", type: "String", nonNull: true },
    agentVersion: { name: "agentVersion", kind: "scalar", type: "String", nonNull: true },
    lastSeen: { name: "lastSeen", kind: "scalar", type: "Int", nonNull: false },
    status: { name: "status", kind: "enum", typeName: "MachineStatus", nonNull: true },
    // The spec's boolean rule names it `is*`; the model's `mine` becomes `isMine` on the wire.
    mine: { name: "isMine", kind: "scalar", type: "Boolean", nonNull: true },
    createdAt: { name: "createdAt", kind: "scalar", type: "ID", nonNull: true },
    updatedAt: { name: "updatedAt", kind: "scalar", type: "ID", nonNull: true },
  },
});

/**
 * The `Trail` GraphQL type (D104): the intent, its state, and what hangs off it.
 *
 * @remarks
 * `description` and `acceptance` are free text; `acceptance` says how a person would know the
 * intent was met. `createdBy` is the session subject or agent that created it.
 *
 * The lists are the Trail's attachments and its movement, each in the order a reader wants:
 * `changes` and `sessions` oldest first, and the append-only records (`findings`, `decisions`,
 * `gates`) newest first. **The timeline is not stored**: a client composes it from these lists by
 * their own recorded/occurred times (trail-model-v1 §6.2). `trail-model-v1` also names feedback,
 * metrics, evals, and notes; those tables exist (0230) but no resolver reads them yet, so they are
 * not on this type until a field can answer them.
 */
export const TrailEntity = defineEntity<Trail>({
  name: "Trail",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    project_id: { name: "projectId", kind: "scalar", type: "ID", nonNull: true },
    title: { name: "title", kind: "scalar", type: "String", nonNull: true },
    description: { name: "description", kind: "scalar", type: "String", nonNull: true },
    acceptance: { name: "acceptance", kind: "scalar", type: "String", nonNull: true },
    kind: { name: "kind", kind: "enum", typeName: "TrailKind", nonNull: true },
    state: { name: "state", kind: "enum", typeName: "TrailState", nonNull: true },
    priority: { name: "priority", kind: "enum", typeName: "TrailPriority", nonNull: true },
    created_by: { name: "createdBy", kind: "scalar", type: "String", nonNull: true },
    created_at: { name: "createdAt", kind: "scalar", type: "String", nonNull: true },
    updated_at: { name: "updatedAt", kind: "scalar", type: "String", nonNull: true },
  },
});

/**
 * The `TrailChange` GraphQL type: the `base..head` pair a Trail moved the code to.
 *
 * @remarks
 * A Change is the diff's address, not its contents: a client reads the commits for the diff.
 * `repoId` and `runId` are nullable until a Trail spans more than one repository or a run
 * produced the change.
 */
export const TrailChangeEntity = defineEntity<TrailChange>({
  name: "TrailChange",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    trail_id: { name: "trailId", kind: "scalar", type: "ID", nonNull: true },
    workspace_id: { name: "workspaceId", kind: "scalar", type: "ID", nonNull: true },
    repo_id: { name: "repoId", kind: "scalar", type: "ID", nonNull: false },
    base_commit: { name: "baseCommit", kind: "scalar", type: "String", nonNull: true },
    head_commit: { name: "headCommit", kind: "scalar", type: "String", nonNull: true },
    run_id: { name: "runId", kind: "scalar", type: "ID", nonNull: false },
    state: { name: "state", kind: "enum", typeName: "TrailChangeState", nonNull: true },
    created_at: { name: "createdAt", kind: "scalar", type: "String", nonNull: true },
    updated_at: { name: "updatedAt", kind: "scalar", type: "String", nonNull: true },
  },
});

/** The `TrailSession` GraphQL type: a link from a Trail to a conversation, session, or run. */
export const TrailSessionEntity = defineEntity<TrailSession>({
  name: "TrailSession",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    trail_id: { name: "trailId", kind: "scalar", type: "ID", nonNull: true },
    conversation_id: { name: "conversationId", kind: "scalar", type: "ID", nonNull: false },
    session_id: { name: "sessionId", kind: "scalar", type: "String", nonNull: true },
    run_id: { name: "runId", kind: "scalar", type: "ID", nonNull: false },
    linked_at: { name: "linkedAt", kind: "scalar", type: "String", nonNull: true },
  },
});

/** The `TrailFinding` GraphQL type: a point raised by a review, a test, or a person. */
export const TrailFindingEntity = defineEntity<TrailFinding>({
  name: "TrailFinding",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    trail_id: { name: "trailId", kind: "scalar", type: "ID", nonNull: true },
    change_id: { name: "changeId", kind: "scalar", type: "ID", nonNull: false },
    severity: { name: "severity", kind: "enum", typeName: "TrailFindingSeverity", nonNull: true },
    source: { name: "source", kind: "enum", typeName: "TrailFindingSource", nonNull: true },
    status: { name: "status", kind: "enum", typeName: "TrailFindingStatus", nonNull: true },
    file: { name: "file", kind: "scalar", type: "String", nonNull: false },
    hunk: { name: "hunk", kind: "scalar", type: "String", nonNull: false },
    summary: { name: "summary", kind: "scalar", type: "String", nonNull: true },
    created_at: { name: "createdAt", kind: "scalar", type: "String", nonNull: true },
    resolved_at: { name: "resolvedAt", kind: "scalar", type: "String", nonNull: false },
    resolved_by: { name: "resolvedBy", kind: "scalar", type: "String", nonNull: false },
  },
});

/** The `TrailDecision` GraphQL type: an approval, a change request, or a rejection. */
export const TrailDecisionEntity = defineEntity<TrailDecision>({
  name: "TrailDecision",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    trail_id: { name: "trailId", kind: "scalar", type: "ID", nonNull: true },
    change_id: { name: "changeId", kind: "scalar", type: "ID", nonNull: false },
    actor: { name: "actor", kind: "scalar", type: "String", nonNull: true },
    action: { name: "action", kind: "enum", typeName: "TrailDecisionAction", nonNull: true },
    head_commit: { name: "headCommit", kind: "scalar", type: "String", nonNull: false },
    note: { name: "note", kind: "scalar", type: "String", nonNull: true },
    at: { name: "at", kind: "scalar", type: "String", nonNull: true },
  },
});

/** The `TrailGate` GraphQL type: what a gate said about a Trail or a Change at a moment. */
export const TrailGateEntity = defineEntity<TrailGate>({
  name: "TrailGate",
  fields: {
    id: { name: "id", kind: "scalar", type: "ID", nonNull: true },
    trail_id: { name: "trailId", kind: "scalar", type: "ID", nonNull: true },
    change_id: { name: "changeId", kind: "scalar", type: "ID", nonNull: false },
    gate: { name: "gate", kind: "enum", typeName: "TrailGateKind", nonNull: true },
    status: { name: "status", kind: "enum", typeName: "TrailGateStatus", nonNull: true },
    detail: { name: "detail", kind: "scalar", type: "String", nonNull: false },
    evaluated_at: { name: "evaluatedAt", kind: "scalar", type: "String", nonNull: true },
  },
});

/** The `TrailState` GraphQL enum: the closed vocabulary the transition table moves. */
export const TrailStateEnum = enumOf("TrailState", TRAIL_STATES);
/** The `TrailKind` GraphQL enum: what sort of intent a Trail anchors. */
export const TrailKindEnum = enumOf("TrailKind", TRAIL_KINDS);
/** The `TrailPriority` GraphQL enum; values keep the model's order, highest first. */
export const TrailPriorityEnum = enumOf("TrailPriority", TRAIL_PRIORITIES);
/** The `TrailChangeState` GraphQL enum. */
export const TrailChangeStateEnum = enumOf("TrailChangeState", TRAIL_CHANGE_STATES);
/** The `TrailFindingSeverity` GraphQL enum. */
export const TrailFindingSeverityEnum = enumOf("TrailFindingSeverity", TRAIL_FINDING_SEVERITIES);
/** The `TrailFindingSource` GraphQL enum. */
export const TrailFindingSourceEnum = enumOf("TrailFindingSource", TRAIL_FINDING_SOURCES);
/** The `TrailFindingStatus` GraphQL enum. */
export const TrailFindingStatusEnum = enumOf("TrailFindingStatus", TRAIL_FINDING_STATUSES);
/** The `TrailDecisionAction` GraphQL enum. */
export const TrailDecisionActionEnum = enumOf("TrailDecisionAction", TRAIL_DECISION_ACTIONS);
/** The `TrailGateKind` GraphQL enum. */
export const TrailGateKindEnum = enumOf("TrailGateKind", TRAIL_GATE_KINDS);
/** The `TrailGateStatus` GraphQL enum; `ask` is the default a Trail's gates start at. */
export const TrailGateStatusEnum = enumOf("TrailGateStatus", TRAIL_GATE_STATUSES);

/** The model entities the SDL exposes, in declaration order. */
export const ENTITIES = [
  ProjectEntity,
  ConversationEntity,
  MachineEntity,
  TrailEntity,
  TrailChangeEntity,
  TrailSessionEntity,
  TrailFindingEntity,
  TrailDecisionEntity,
  TrailGateEntity,
] as const;

/**
 * The model enums the SDL exposes, in declaration order.
 *
 * @remarks
 * `TrailState` is the one the client filters a Sidebar by; every other Trail enum is a row's own
 * vocabulary, so none of them is a free string on the wire.
 */
export const ENUMS = [
  ProjectEgressEnum,
  MachineStatusEnum,
  TrailStateEnum,
  TrailKindEnum,
  TrailPriorityEnum,
  TrailChangeStateEnum,
  TrailFindingSeverityEnum,
  TrailFindingSourceEnum,
  TrailFindingStatusEnum,
  TrailDecisionActionEnum,
  TrailGateKindEnum,
  TrailGateStatusEnum,
] as const;

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
