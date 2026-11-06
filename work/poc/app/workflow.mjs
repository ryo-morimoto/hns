// Workflow graphs: validation, ordering, and prompt interpolation.
export class GraphError extends Error {}

const TYPES = new Set(["agent"]);

export function validateGraph(graph) {
  if (!graph || typeof graph !== "object") throw new GraphError("graph must be an object");
  const nodes = graph.nodes;
  const edges = graph.edges ?? [];
  if (!Array.isArray(nodes) || nodes.length === 0) throw new GraphError("nodes must be a non-empty array");
  if (!Array.isArray(edges)) throw new GraphError("edges must be an array");

  const ids = new Set();
  for (const node of nodes) {
    if (typeof node?.id !== "string" || node.id.length === 0) throw new GraphError("node id is required");
    if (ids.has(node.id)) throw new GraphError("duplicate node id: " + node.id);
    ids.add(node.id);
    if (!TYPES.has(node.type)) throw new GraphError("unknown node type: " + node.type);
    if (typeof node.prompt !== "string" || node.prompt.length === 0) throw new GraphError("agent node needs a prompt");
  }

  const seen = new Set();
  for (const edge of edges) {
    if (!ids.has(edge?.from) || !ids.has(edge?.to)) throw new GraphError("edge refers to an unknown node");
    if (edge.from === edge.to) throw new GraphError("self edge");
    const key = edge.from + "\u0000" + edge.to;
    if (seen.has(key)) throw new GraphError("duplicate edge");
    seen.add(key);
  }

  // A cycle would make the node order undefined.
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) indegree.set(edge.to, indegree.get(edge.to) + 1);
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const edge of edges.filter((candidate) => candidate.from === id)) {
      indegree.set(edge.to, indegree.get(edge.to) - 1);
      if (indegree.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  if (order.length !== nodes.length) throw new GraphError("graph has a cycle");
  return { nodes, edges, order };
}

export function topoOrder(graph) {
  return validateGraph(graph).order;
}

export function interpolate(template, values) {
  return template.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_, name) => values[name] ?? "");
}

export function incoming(graph, nodeId) {
  return (graph.edges ?? []).filter((edge) => edge.to === nodeId).map((edge) => edge.from);
}