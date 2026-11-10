import { expect, test } from "vitest";
import { validateWorkflowGraph } from "./workflow.ts";

const node = (id: string) => ({ id, type: "agent" as const, prompt: "go" });
const edge = (from: string, to: string) => ({ from, to });

test("a DAG is accepted", () => {
  const graph = { nodes: [node("a"), node("b")], edges: [edge("a", "b")] };

  expect(validateWorkflowGraph(graph).ok).toBe(true);
});

test("a duplicate node is refused", () => {
  const parsed = validateWorkflowGraph({ nodes: [node("a"), node("a")], edges: [] });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error).toStrictEqual({ kind: "duplicate_node", id: "a" });
});

test("an edge to a missing node is refused", () => {
  const parsed = validateWorkflowGraph({ nodes: [node("a")], edges: [edge("a", "ghost")] });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error).toStrictEqual({ kind: "unknown_endpoint", edge: edge("a", "ghost") });
});

// Catches: the server claimed it rejects cycles, but nothing checked the graph.
test("a cycle is refused with the path that closes it", () => {
  const parsed = validateWorkflowGraph({
    nodes: [node("a"), node("b"), node("c")],
    edges: [edge("a", "b"), edge("b", "c"), edge("c", "a")],
  });

  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.kind).toBe("cycle");
  if (parsed.error.kind !== "cycle") return;
  expect(parsed.error.path).toStrictEqual(["a", "b", "c", "a"]);
});
