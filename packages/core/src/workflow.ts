import type { AutomationFiringStatus, WorkflowNodeStatus, WorkflowRunStatus } from "./types.ts";

const RUN_TRANSITIONS: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  queued: ["running", "failed"],
  running: ["waiting", "done", "failed"],
  waiting: ["running", "failed"],
  done: [],
  failed: [],
};

const NODE_TRANSITIONS: Record<WorkflowNodeStatus, readonly WorkflowNodeStatus[]> = {
  pending: ["running", "failed"],
  running: ["waiting", "done", "failed"],
  waiting: ["running", "done", "failed"],
  done: [],
  failed: [],
};

const FIRING_TRANSITIONS: Record<AutomationFiringStatus, readonly AutomationFiringStatus[]> = {
  running: ["done", "failed"],
  done: [],
  failed: [],
  skipped: [],
};

export function canRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canNodeTransition(from: WorkflowNodeStatus, to: WorkflowNodeStatus): boolean {
  return NODE_TRANSITIONS[from].includes(to);
}

export function canFiringTransition(
  from: AutomationFiringStatus,
  to: AutomationFiringStatus,
): boolean {
  return FIRING_TRANSITIONS[from].includes(to);
}

// SAFETY: a transition table is exhaustive over its status union by construction.
function assertTransition<S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
  label: string,
): void {
  if (!table[from].includes(to))
    throw new Error("invalid " + label + " transition: " + from + " -> " + to);
}

export function assertRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  assertTransition(RUN_TRANSITIONS, from, to, "workflow run");
}

export function assertNodeTransition(from: WorkflowNodeStatus, to: WorkflowNodeStatus): void {
  assertTransition(NODE_TRANSITIONS, from, to, "workflow node");
}

export function assertFiringTransition(
  from: AutomationFiringStatus,
  to: AutomationFiringStatus,
): void {
  assertTransition(FIRING_TRANSITIONS, from, to, "automation firing");
}
