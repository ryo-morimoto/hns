import * as v from "valibot";
import {
  WorkflowGraphSchema,
  type ConversationId,
  type ProjectId,
  type Workflow,
  type WorkflowGraph,
  type WorkflowNodeStatus,
  type WorkflowRun,
  type WorkflowRunNode,
  type WorkflowRunStatus,
} from "@hns/core";
import type { StoreContext } from "../db.ts";
import { parseWorkflow, parseWorkflowRun, parseWorkflowRunNode } from "../parse.ts";

export interface WorkflowCreateInput {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly graph: WorkflowGraph;
}

export interface WorkflowRepository {
  list(projectId?: ProjectId | undefined): Workflow[];
  get(id: string): Workflow | undefined;
  create(input: WorkflowCreateInput): Workflow;
  update(id: string, graph: WorkflowGraph): Workflow | undefined;
  delete(id: string): boolean;
  createRun(input: { workflowId: string; input: string }): WorkflowRun | undefined;
  getRun(id: string): WorkflowRun | undefined;
  /** The graph the run pinned when it started, even if the workflow moved on. */
  getRunGraph(id: string): WorkflowGraph | undefined;
  listRuns(workflowId?: string | undefined): WorkflowRun[];
  setRunStatus(id: string, status: WorkflowRunStatus): void;
  finishRun(id: string, status: WorkflowRunStatus, output?: string | undefined): void;
  setNodeRunning(runId: string, nodeId: string, prompt: string): void;
  setNodeResult(
    runId: string,
    nodeId: string,
    status: WorkflowNodeStatus,
    output: string,
    conversationId?: ConversationId | undefined,
  ): void;
  setNodeWaiting(runId: string, nodeId: string, prompt: string): void;
  completeNode(runId: string, nodeId: string, output: string): WorkflowRunNode | undefined;
  resumeRuns(): WorkflowRun[];
}

export function workflowRepository(context: StoreContext): WorkflowRepository {
  const { db, now, newId, transaction } = context;

  const get = (id: string): Workflow | undefined => {
    const row = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
    return row === undefined ? undefined : parseWorkflow(row);
  };

  const getNode = (runId: string, nodeId: string): WorkflowRunNode | undefined => {
    const row = db
      .prepare("SELECT * FROM workflow_nodes WHERE run_id = ? AND node_id = ?")
      .get(runId, nodeId);
    return row === undefined ? undefined : parseWorkflowRunNode(row);
  };

  const getRun = (id: string): WorkflowRun | undefined => {
    const row = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id);
    if (row === undefined) return undefined;
    const nodes = db
      .prepare("SELECT * FROM workflow_nodes WHERE run_id = ? ORDER BY rowid")
      .all(id)
      .map((node) => parseWorkflowRunNode(node));
    return parseWorkflowRun({ ...row, nodes });
  };

  return {
    list(projectId) {
      const rows =
        projectId === undefined
          ? db.prepare("SELECT * FROM workflows ORDER BY created_at").all()
          : db
              .prepare("SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at")
              .all(projectId);
      return rows.map((row) => parseWorkflow(row));
    },
    get,
    create(input) {
      const graph = v.parse(WorkflowGraphSchema, input.graph);
      const createdAt = now();
      const workflow = parseWorkflow({
        id: newId(),
        project_id: input.projectId,
        name: input.name,
        version: 1,
        graph_json: JSON.stringify(graph),
        created_at: createdAt,
        updated_at: createdAt,
      });
      transaction(() => {
        db.prepare(
          "INSERT INTO workflows (id, project_id, name, version, graph_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          workflow.id,
          workflow.project_id,
          workflow.name,
          workflow.version,
          JSON.stringify(workflow.graph),
          workflow.created_at,
          workflow.updated_at,
        );
      });
      return workflow;
    },
    update(id, graph) {
      if (get(id) === undefined) return undefined;
      const parsed = v.parse(WorkflowGraphSchema, graph);
      transaction(() => {
        db.prepare(
          "UPDATE workflows SET version = version + 1, graph_json = ?, updated_at = ? WHERE id = ?",
        ).run(JSON.stringify(parsed), now(), id);
      });
      return get(id);
    },
    delete(id) {
      return transaction(() => {
        const result = db.prepare("DELETE FROM workflows WHERE id = ?").run(id);
        return Number(result.changes) > 0;
      });
    },
    createRun(input) {
      const workflow = get(input.workflowId);
      if (workflow === undefined) return undefined;
      const runId = newId();
      const createdAt = now();
      transaction(() => {
        db.prepare(
          "INSERT INTO workflow_runs (id, workflow_id, version, graph_json, status, input, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          runId,
          workflow.id,
          workflow.version,
          JSON.stringify(workflow.graph),
          "queued",
          input.input,
          createdAt,
        );
        for (const node of workflow.graph.nodes) {
          db.prepare(
            "INSERT INTO workflow_nodes (run_id, node_id, status) VALUES (?, ?, 'pending')",
          ).run(runId, node.id);
        }
      });
      const run = getRun(runId);
      if (run === undefined) throw new Error("run was not created");
      return run;
    },
    getRun,
    getRunGraph(id) {
      const row = db.prepare("SELECT graph_json FROM workflow_runs WHERE id = ?").get(id);
      if (row === undefined) return undefined;
      const graphJson = v.parse(v.object({ graph_json: v.string() }), row).graph_json;
      const parsed: unknown = JSON.parse(graphJson);
      return v.parse(WorkflowGraphSchema, parsed);
    },
    listRuns(workflowId) {
      const rows =
        workflowId === undefined
          ? db.prepare("SELECT * FROM workflow_runs ORDER BY created_at DESC").all()
          : db
              .prepare("SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC")
              .all(workflowId);
      return rows.map((row) => parseWorkflowRun(row));
    },
    setRunStatus(id, status) {
      transaction(() => {
        db.prepare("UPDATE workflow_runs SET status = ? WHERE id = ?").run(status, id);
      });
    },
    finishRun(id, status, output) {
      transaction(() => {
        db.prepare(
          "UPDATE workflow_runs SET status = ?, output = ?, finished_at = ? WHERE id = ?",
        ).run(status, output ?? null, now(), id);
      });
    },
    setNodeRunning(runId, nodeId, prompt) {
      transaction(() => {
        db.prepare(
          "UPDATE workflow_nodes SET status = 'running', prompt = ?, started_at = ? WHERE run_id = ? AND node_id = ?",
        ).run(prompt, now(), runId, nodeId);
      });
    },
    setNodeResult(runId, nodeId, status, output, conversationId) {
      transaction(() => {
        db.prepare(
          "UPDATE workflow_nodes SET status = ?, output = ?, conversation_id = ?, finished_at = ? WHERE run_id = ? AND node_id = ?",
        ).run(status, output, conversationId ?? null, now(), runId, nodeId);
      });
    },
    setNodeWaiting(runId, nodeId, prompt) {
      transaction(() => {
        db.prepare(
          "UPDATE workflow_nodes SET status = 'waiting', prompt = ?, started_at = ? WHERE run_id = ? AND node_id = ?",
        ).run(prompt, now(), runId, nodeId);
      });
    },
    completeNode(runId, nodeId, output) {
      const node = getNode(runId, nodeId);
      if (node === undefined || node.status !== "waiting") return undefined;
      transaction(() => {
        db.prepare(
          "UPDATE workflow_nodes SET status = 'done', output = ?, finished_at = ? WHERE run_id = ? AND node_id = ?",
        ).run(output, now(), runId, nodeId);
      });
      return getNode(runId, nodeId);
    },
    resumeRuns() {
      return transaction(() => {
        db.prepare("UPDATE workflow_nodes SET status = 'pending' WHERE status = 'running'").run();
        const rows = db
          .prepare(
            "SELECT * FROM workflow_runs WHERE status IN ('queued', 'running') ORDER BY created_at",
          )
          .all();
        return rows.map((row) => parseWorkflowRun(row));
      });
    },
  };
}
