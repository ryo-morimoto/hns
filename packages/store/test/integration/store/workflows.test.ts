import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createD1Harness, type D1Harness } from "../harness.ts";
import { graph } from "../../support.ts";

let harness: D1Harness;

beforeAll(async () => {
  harness = await createD1Harness();
});

afterAll(async () => {
  await harness.dispose();
});

test("workflows keep versions, runs pin the version and nodes move through the states", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.ensureDefault();
    const workflow = await store.workflows.create({
      projectId: project.id,
      name: "flow",
      graph: graph([
        { id: "plan", type: "agent", prompt: "Plan" },
        { id: "check", type: "human", prompt: "Check" },
      ]),
    });
    expect(workflow.version).toBe(1);
    const updated = await store.workflows.update(
      workflow.id,
      graph([{ id: "solo", type: "agent", prompt: "Solo" }]),
    );
    expect(updated?.version).toBe(2);

    const run = await store.workflows.createRun({ workflowId: workflow.id, input: "ship" });
    assert.ok(run !== undefined);
    assert.equal(run.version, 2);
    expect((await store.workflows.getRunGraph(run.id))?.nodes.map((node) => node.id)).toStrictEqual(
      ["solo"],
    );
    await store.workflows.update(
      workflow.id,
      graph([{ id: "later", type: "agent", prompt: "Later" }]),
    );
    expect((await store.workflows.getRunGraph(run.id))?.nodes.map((node) => node.id)).toStrictEqual(
      ["solo"],
    );
    expect(run.nodes?.map((node) => node.status)).toStrictEqual(["pending"]);

    await store.workflows.setRunStatus(run.id, "running");
    await store.workflows.setNodeRunning(run.id, "solo", "Solo ship");
    expect((await store.workflows.getRun(run.id))?.nodes?.[0]?.status).toBe("running");
    await store.workflows.setNodeWaiting(run.id, "solo", "Approve");
    const completed = await store.workflows.completeNode(run.id, "solo", "ok");
    expect(completed?.status).toBe("done");
    expect(await store.workflows.completeNode(run.id, "solo", "again")).toBe(undefined);
    await store.workflows.finishRun(run.id, "done", '{"solo":"ok"}');
    const finished = await store.workflows.getRun(run.id);
    expect(finished?.status).toBe("done");
    expect(finished?.output).toBe('{"solo":"ok"}');
    expect((await store.workflows.getRun(run.id))?.nodes?.[0]?.output).toBe("ok");
  });
});

test("resuming requeues running nodes and deletes cascade", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.ensureDefault();
    const workflow = await store.workflows.create({
      projectId: project.id,
      name: "flow",
      graph: graph([{ id: "a", type: "agent", prompt: "A" }]),
    });
    const run = await store.workflows.createRun({ workflowId: workflow.id, input: "x" });
    assert.ok(run !== undefined);
    await store.workflows.setNodeRunning(run.id, "a", "A");
    await store.workflows.setRunStatus(run.id, "running");
    const resumed = await store.workflows.resumeRuns();
    expect(resumed.length).toBe(1);
    expect((await store.workflows.getRun(run.id))?.nodes?.[0]?.status).toBe("pending");
    expect(await store.workflows.delete(workflow.id)).toBe(true);
    expect(await store.workflows.getRun(run.id)).toBe(undefined);
    expect(await store.workflows.get(workflow.id)).toBe(undefined);
  });
});

test("a run whose graph cannot be inserted rolls back whole", async () => {
  await harness.withStore(async (store) => {
    const project = await store.projects.ensureDefault();
    const workflow = await store.workflows.create({
      projectId: project.id,
      name: "broken",
      graph: graph([
        { id: "same", type: "agent", prompt: "A" },
        { id: "same", type: "agent", prompt: "B" },
      ]),
    });
    await expect(
      store.workflows.createRun({ workflowId: workflow.id, input: "x" }),
    ).rejects.toThrow();
    expect((await store.workflows.listRuns()).length).toBe(0);
  });
});
