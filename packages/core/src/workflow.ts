import type { WorkflowEdge, WorkflowGraph } from "./types.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
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
/** Why a workflow graph was refused. A graph is a DAG: the server stores no cycle. */
export type GraphError =
  | { readonly kind: "duplicate_node"; readonly id: string }
  | { readonly kind: "unknown_endpoint"; readonly edge: WorkflowEdge }
  | { readonly kind: "cycle"; readonly path: readonly string[] };

/**
 * Check that every edge names a node and that the nodes form a DAG. The server calls this
 * before it stores a workflow (http.ts); the client can call it to disable a save.
 */
export function validateWorkflowGraph(graph: WorkflowGraph): Result<WorkflowGraph, GraphError> {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) return err({ kind: "duplicate_node", id: node.id });
    ids.add(node.id);
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) return err({ kind: "unknown_endpoint", edge });
    const next = outgoing.get(edge.from);
    if (next === undefined) outgoing.set(edge.from, [edge.to]);
    else next.push(edge.to);
  }
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const state = new Map<string, number>();
  const path: string[] = [];
  const visit = (id: string): GraphError | undefined => {
    state.set(id, GREY);
    path.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const colour = state.get(next) ?? WHITE;
      if (colour === GREY) {
        const start = path.indexOf(next);
        return { kind: "cycle", path: [...path.slice(start), next] };
      }
      if (colour === BLACK) continue;
      const found = visit(next);
      if (found !== undefined) return found;
    }
    path.pop();
    state.set(id, BLACK);
    return undefined;
  };
  for (const node of graph.nodes) {
    if ((state.get(node.id) ?? WHITE) !== WHITE) continue;
    const cycle = visit(node.id);
    if (cycle !== undefined) return err(cycle);
  }
  return ok(graph);
}
