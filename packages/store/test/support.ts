import type { IsoTimestamp, WorkflowGraph } from "@hns/core";
import { isoTimestamp } from "@hns/core";

/** A deterministic clock: each call advances one second, so ordering is stable. */
export function clock(start = "2026-01-01T00:00:00.000Z"): () => IsoTimestamp {
  let at = Date.parse(start);
  return () => {
    const value = isoTimestamp(new Date(at).toISOString());
    at += 1000;
    return value;
  };
}

/** A deterministic id source: id-1, id-2, ... */
export function counter(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return "id-" + next;
  };
}

/** A graph with the given nodes and no edges, for tests that do not exercise a DAG. */
export const graph = (nodes: WorkflowGraph["nodes"]): WorkflowGraph => ({ nodes, edges: [] });
