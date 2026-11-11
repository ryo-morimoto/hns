import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { graph, withStore } from "../test/support.ts";

test("workflows keep versions, runs pin the version and nodes move through the states", () => {
  withStore((store) => {
    const project = store.projects.ensureDefault();
    const workflow = store.workflows.create({
      projectId: project.id,
      name: "flow",
      graph: graph([
        { id: "plan", type: "agent", prompt: "Plan" },
        { id: "check", type: "human", prompt: "Check" },
      ]),
    });
    expect(workflow.version).toBe(1);
    const updated = store.workflows.update(
      workflow.id,
      graph([{ id: "solo", type: "agent", prompt: "Solo" }]),
    );
    expect(updated?.version).toBe(2);

    const run = store.workflows.createRun({ workflowId: workflow.id, input: "ship" });
    assert.ok(run !== undefined);
    assert.equal(run.version, 2);
    expect(store.workflows.getRunGraph(run.id)?.nodes.map((node) => node.id)).toStrictEqual([
      "solo",
    ]);
    store.workflows.update(workflow.id, graph([{ id: "later", type: "agent", prompt: "Later" }]));
    expect(store.workflows.getRunGraph(run.id)?.nodes.map((node) => node.id)).toStrictEqual([
      "solo",
    ]);
    expect(run.nodes?.map((node) => node.status)).toStrictEqual(["pending"]);

    store.workflows.setRunStatus(run.id, "running");
    store.workflows.setNodeRunning(run.id, "solo", "Solo ship");
    expect(store.workflows.getRun(run.id)?.nodes?.[0]?.status).toBe("running");
    store.workflows.setNodeWaiting(run.id, "solo", "Approve");
    const completed = store.workflows.completeNode(run.id, "solo", "ok");
    expect(completed?.status).toBe("done");
    expect(store.workflows.completeNode(run.id, "solo", "again")).toBe(undefined);
    store.workflows.finishRun(run.id, "done", '{"solo":"ok"}');
    const finished = store.workflows.getRun(run.id);
    expect(finished?.status).toBe("done");
    expect(finished?.output).toBe('{"solo":"ok"}');
    expect(store.workflows.getRun(run.id)?.nodes?.[0]?.output).toBe("ok");
  });
});

test("resuming requeues running nodes and deletes cascade", () => {
  withStore((store) => {
    const project = store.projects.ensureDefault();
    const workflow = store.workflows.create({
      projectId: project.id,
      name: "flow",
      graph: graph([{ id: "a", type: "agent", prompt: "A" }]),
    });
    const run = store.workflows.createRun({ workflowId: workflow.id, input: "x" });
    assert.ok(run !== undefined);
    store.workflows.setNodeRunning(run.id, "a", "A");
    store.workflows.setRunStatus(run.id, "running");
    const resumed = store.workflows.resumeRuns();
    expect(resumed.length).toBe(1);
    expect(store.workflows.getRun(run.id)?.nodes?.[0]?.status).toBe("pending");
    expect(store.workflows.delete(workflow.id)).toBe(true);
    expect(store.workflows.getRun(run.id)).toBe(undefined);
    expect(store.workflows.get(workflow.id)).toBe(undefined);
  });
});

test("a run whose graph cannot be inserted rolls back whole", () => {
  withStore((store) => {
    const project = store.projects.ensureDefault();
    const workflow = store.workflows.create({
      projectId: project.id,
      name: "broken",
      graph: graph([
        { id: "same", type: "agent", prompt: "A" },
        { id: "same", type: "agent", prompt: "B" },
      ]),
    });
    expect(() => store.workflows.createRun({ workflowId: workflow.id, input: "x" })).toThrow();
    expect(store.workflows.listRuns().length).toBe(0);
  });
});
