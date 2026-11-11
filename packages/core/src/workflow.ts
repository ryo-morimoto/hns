import type { WorkflowEdge, WorkflowGraph } from "./types.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { AutomationFiringStatus, WorkflowNodeStatus, WorkflowRunStatus } from "./types.ts";

/** Legal workflow run moves; `done` and `failed` are terminal. */
const RUN_TRANSITIONS: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  queued: ["running", "failed"],
  running: ["waiting", "done", "failed"],
  waiting: ["running", "failed"],
  done: [],
  failed: [],
};

/**
 * Legal workflow node moves; `waiting` may resume at `running`, and `done` and `failed` are
 * terminal.
 */
const NODE_TRANSITIONS: Record<WorkflowNodeStatus, readonly WorkflowNodeStatus[]> = {
  pending: ["running", "failed"],
  running: ["waiting", "done", "failed"],
  waiting: ["running", "done", "failed"],
  done: [],
  failed: [],
};

/** Legal automation firing moves; every firing ends after one move from `running`. */
const FIRING_TRANSITIONS: Record<AutomationFiringStatus, readonly AutomationFiringStatus[]> = {
  running: ["done", "failed"],
  done: [],
  failed: [],
  skipped: [],
};

/**
 * Whether a workflow run may move from one status to another.
 *
 * @param from - The run's current status.
 * @param to - The status a caller wants to store.
 * @returns `true` when the move is in the run transition table.
 *
 * @remarks
 * `done` and `failed` are terminal; a run cannot leave them. This is the predicate behind
 * `assertRunTransition`.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(canRunTransition("queued", "running")).toBe(true);
 * expect(canRunTransition("done", "running")).toBe(false);
 * ```
 */
export function canRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

/**
 * Whether a workflow node may move from one status to another.
 *
 * @param from - The node's current status.
 * @param to - The status a caller wants to store.
 * @returns `true` when the move is in the node transition table.
 *
 * @remarks
 * `waiting` may resume at `running`; `done` and `failed` are terminal.
 */
export function canNodeTransition(from: WorkflowNodeStatus, to: WorkflowNodeStatus): boolean {
  return NODE_TRANSITIONS[from].includes(to);
}

/**
 * Whether an automation firing may move from one status to another.
 *
 * @param from - The firing's current status.
 * @param to - The status a caller wants to store.
 * @returns `true` when the move is in the firing transition table.
 *
 * @remarks
 * A firing starts at `running` and moves once to `done` or `failed`; `skipped` is terminal
 * already.
 */
export function canFiringTransition(
  from: AutomationFiringStatus,
  to: AutomationFiringStatus,
): boolean {
  return FIRING_TRANSITIONS[from].includes(to);
}

/**
 * Throw unless `from -> to` is in `table`.
 *
 * @internal
 * @param table - The transition table for this status union.
 * @param from - Current status.
 * @param to - Requested status.
 * @param label - Name used in the error message, such as `workflow run`.
 * @throws Error when the move is not allowed.
 */
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

/**
 * Throw unless a workflow run may move from one status to another.
 *
 * @param from - The run's current status.
 * @param to - The status about to be stored.
 * @throws Error when the move is not in the run transition table.
 *
 * @remarks
 * Call this before persisting a status change; the table is the only definition of legal
 * movement.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(() => assertRunTransition("queued", "running")).not.toThrow();
 * expect(() => assertRunTransition("done", "running")).toThrow();
 * ```
 */
export function assertRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void {
  assertTransition(RUN_TRANSITIONS, from, to, "workflow run");
}

/**
 * Throw unless a workflow node may move from one status to another.
 *
 * @param from - The node's current status.
 * @param to - The status about to be stored.
 * @throws Error when the move is not in the node transition table.
 *
 * @remarks
 * Call this before persisting a node status change.
 */
export function assertNodeTransition(from: WorkflowNodeStatus, to: WorkflowNodeStatus): void {
  assertTransition(NODE_TRANSITIONS, from, to, "workflow node");
}

/**
 * Throw unless an automation firing may move from one status to another.
 *
 * @param from - The firing's current status.
 * @param to - The status about to be stored.
 * @throws Error when the move is not in the firing transition table.
 *
 * @remarks
 * A firing is created directly at `running` or `skipped`; this guards the move to its terminal
 * state.
 */
export function assertFiringTransition(
  from: AutomationFiringStatus,
  to: AutomationFiringStatus,
): void {
  assertTransition(FIRING_TRANSITIONS, from, to, "automation firing");
}

/**
 * Why a workflow graph was refused. A graph is a DAG: the server stores no cycle.
 *
 * @remarks
 * `duplicate_node` names the repeated id; `unknown_endpoint` echoes the edge whose `from` or
 * `to` is missing; `cycle` lists the path from the repeated node back to itself.
 */
export type GraphError =
  | { readonly kind: "duplicate_node"; readonly id: string }
  | { readonly kind: "unknown_endpoint"; readonly edge: WorkflowEdge }
  | { readonly kind: "cycle"; readonly path: readonly string[] };

/**
 * Check that every edge names a node and that the nodes form a DAG. A surface that stores a
 * workflow calls this first; a client can call it to disable a save.
 *
 * @param graph - The graph to check, as it would be stored.
 * @returns `ok(graph)` when the graph is a DAG; `err` with the first problem found.
 *
 * @remarks
 * Checks run in a fixed order: duplicate node ids, unknown edge endpoints, then cycles. A cycle
 * error's `path` starts and ends with the node that closes it, so `["a", "b", "a"]` names the
 * cycle `a -> b -> a`. The input is returned unchanged on success.
 *
 * @example
 * ```ts @import.meta.vitest
 * const nodes = [
 *   { id: "a", type: "agent", prompt: "go" },
 *   { id: "b", type: "agent", prompt: "go" },
 * ];
 * const cycle = { nodes, edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
 * expect(validateWorkflowGraph(cycle).ok).toBe(false);
 * expect(validateWorkflowGraph({ nodes, edges: [] }).ok).toBe(true);
 * ```
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
