import { afterAll, beforeAll, expect, test } from "vitest";
import { createD1Harness, type D1Harness } from "../harness.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

const GRAPH = '{"nodes":[{"id":"a","type":"agent","prompt":"A"}],"edges":[]}';

// The rows a workflow and a pinned run have, written the way the workflow's own writer will once
// a face exists; this test proves the store reads them back through the model.
const WORKFLOW = [
  "INSERT INTO workflows (id, project_id, name, version, graph_json, created_at, updated_at)",
  "VALUES ('w1', 'default', 'flow', 1, '" +
    GRAPH +
    "', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');",
].join(" ");

const RUN = [
  "INSERT INTO workflow_runs (id, workflow_id, version, graph_json, status, input, created_at)",
  "VALUES ('r1', 'w1', 1, '" + GRAPH + "', 'queued', 'ship', '2026-01-01T00:00:01.000Z');",
  "INSERT INTO workflow_nodes (run_id, node_id, status) VALUES ('r1', 'a', 'pending');",
].join(" ");

// Catches: a stored workflow or run whose graph does not read back through the model.
test("a stored workflow and its run read back with the pinned graph", async () => {
  await harness.withStore(async (store) => {
    await harness.exec(WORKFLOW + " " + RUN);
    const workflows = await store.workflows.list();
    expect(workflows.map((workflow) => [workflow.id, workflow.version])).toStrictEqual([["w1", 1]]);
    expect((await store.workflows.get("w1"))?.graph.nodes.map((node) => node.id)).toStrictEqual([
      "a",
    ]);
    expect(await store.workflows.get("missing")).toBe(undefined);
    expect((await store.workflows.listRuns("w1")).map((run) => run.id)).toStrictEqual(["r1"]);
    const run = await store.workflows.getRun("r1");
    expect(run?.nodes?.map((node) => node.status)).toStrictEqual(["pending"]);
    expect((await store.workflows.getRunGraph("r1"))?.nodes.map((node) => node.id)).toStrictEqual([
      "a",
    ]);
  });
});

// Catches: a corrupt stored graph read back as a default instead of failing.
test("a corrupt stored graph fails loudly on read", async () => {
  await harness.withStore(async (store) => {
    await harness.exec(WORKFLOW);
    await harness.exec("UPDATE workflows SET graph_json = '{}' WHERE id = 'w1'");
    await expect(store.workflows.get("w1")).rejects.toThrow();
  });
});
