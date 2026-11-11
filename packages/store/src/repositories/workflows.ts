import * as v from "valibot";
import {
  type ConversationId,
  type ProjectId,
  type Workflow,
  type WorkflowGraph,
  type WorkflowNodeStatus,
  type WorkflowRun,
  type WorkflowRunNode,
  type WorkflowRunStatus,
} from "@hns/core";
import { WorkflowGraphSchema } from "../schemas.ts";
import type { StoreContext } from "../db.ts";
import { parseWorkflow, parseWorkflowRun, parseWorkflowRunNode } from "../parse.ts";

/**
 * Input for {@link WorkflowRepository.create}.
 *
 * @remarks
 * `graph` is parsed for shape before it is written; a malformed graph throws and stores
 * nothing. This does not reject cycles or unknown endpoints: the caller checks the DAG with
 * `validateWorkflowGraph` before storing a runnable workflow.
 */
export interface WorkflowCreateInput {
  readonly projectId: ProjectId;
  readonly name: string;
  /** The graph to store; only its shape is validated here, not the DAG. */
  readonly graph: WorkflowGraph;
}

/**
 * Workflows and their runs.
 *
 * @remarks
 * `create` and `update` validate the graph's shape before writing, not its DAG. A run pins the workflow's
 * `version` and graph at the moment it is created, so later edits do not change a run in
 * flight. Missing rows return `undefined`, `delete` reports whether a row was removed, and
 * each write runs in one transaction.
 */
export interface WorkflowRepository {
  /** Workflows across every project, or only `projectId`; oldest first. */
  list(projectId?: ProjectId | undefined): Workflow[];
  /** The workflow with `id`, or `undefined` when it does not exist. */
  get(id: string): Workflow | undefined;
  /**
   * Create a workflow at version 1.
   *
   * @throws ValiError if `graph` is not a valid graph.
   */
  create(input: WorkflowCreateInput): Workflow;
  /**
   * Replace the graph and bump the version by one.
   *
   * @remarks
   * Runs keep the graph and version they pinned, so an edit never changes a run in flight.
   * `undefined` when the workflow does not exist.
   *
   * @throws ValiError if `graph` is not a valid graph.
   */
  update(id: string, graph: WorkflowGraph): Workflow | undefined;
  /** Delete a workflow and, by cascade, its runs and node rows; returns whether a row was removed. */
  delete(id: string): boolean;
  /**
   * Start a run of `workflowId`, copying its current version and graph.
   *
   * @remarks
   * The run starts `queued` with one `pending` row per node. `undefined` when the workflow
   * does not exist, so a deleted workflow cannot be run.
   */
  createRun(input: { workflowId: string; input: string }): WorkflowRun | undefined;
  /** The run with `id` and its nodes, or `undefined` when it does not exist. */
  getRun(id: string): WorkflowRun | undefined;
  /**
   * The graph the run pinned when it started, even if the workflow moved on.
   *
   * @remarks
   * `undefined` when the run does not exist. The stored graph is validated on read.
   */
  getRunGraph(id: string): WorkflowGraph | undefined;
  /** Runs across every workflow, or only `workflowId`; newest first. */
  listRuns(workflowId?: string | undefined): WorkflowRun[];
  /** Set the run status; a no-op when the run does not exist. */
  setRunStatus(id: string, status: WorkflowRunStatus): void;
  /**
   * Finish a run: set its status, optional output, and `finished_at`.
   *
   * @remarks
   * `output` is stored as given and null when omitted. A no-op when the run does not exist.
   */
  finishRun(id: string, status: WorkflowRunStatus, output?: string | undefined): void;
  /** Mark a node running with its prompt and start time; a no-op when the node is missing. */
  setNodeRunning(runId: string, nodeId: string, prompt: string): void;
  /** Record a node's terminal status, output, and conversation; a no-op when the node is missing. */
  setNodeResult(
    runId: string,
    nodeId: string,
    status: WorkflowNodeStatus,
    output: string,
    conversationId?: ConversationId | undefined,
  ): void;
  /** Mark a node waiting for input with its prompt and start time; a no-op when the node is missing. */
  setNodeWaiting(runId: string, nodeId: string, prompt: string): void;
  /**
   * Complete a waiting node with `output`.
   *
   * @remarks
   * Only a `waiting` node can be completed here. `undefined` when the node is missing or not
   * waiting, so a duplicate resume cannot overwrite a finished node.
   */
  completeNode(runId: string, nodeId: string, output: string): WorkflowRunNode | undefined;
  /**
   * Recover runs interrupted by a restart.
   *
   * @remarks
   * Nodes left `running` go back to `pending`, then the `queued` and `running` runs are
   * returned oldest first. Runs in other states are not returned.
   */
  resumeRuns(): WorkflowRun[];
}

/**
 * Build the workflow repository over `context`.
 *
 * @internal
 */
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
