import { test } from "vitest";
import assert from "node:assert/strict";
import { validateWorkflowGraph } from "../src/workflow.ts";

const node = (id: string) => ({ id, type: "agent" as const, prompt: "go" });
const edge = (from: string, to: string) => ({ from, to });

test("a DAG is accepted", () => {
  const graph = { nodes: [node("a"), node("b")], edges: [edge("a", "b")] };

  assert.equal(validateWorkflowGraph(graph).ok, true);
});

test("a duplicate node is refused", () => {
  const parsed = validateWorkflowGraph({ nodes: [node("a"), node("a")], edges: [] });

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.deepEqual(parsed.error, { kind: "duplicate_node", id: "a" });
});

test("an edge to a missing node is refused", () => {
  const parsed = validateWorkflowGraph({ nodes: [node("a")], edges: [edge("a", "ghost")] });

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.deepEqual(parsed.error, { kind: "unknown_endpoint", edge: edge("a", "ghost") });
});

// Catches: the server claimed it rejects cycles, but nothing checked the graph.
test("a cycle is refused with the path that closes it", () => {
  const parsed = validateWorkflowGraph({
    nodes: [node("a"), node("b"), node("c")],
    edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
  });

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.error.kind, "cycle");
  if (parsed.error.kind !== "cycle") return;
  assert.deepEqual(parsed.error.path, ["a", "b", "c", "a"]);
});
