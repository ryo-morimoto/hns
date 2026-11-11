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
import type { SqlStatement } from "../sql.ts";

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
 * `create` and `update` validate the graph's shape before writing, not its DAG. A run pins
 * the workflow's `version` and graph at the moment it is created, so later edits do not
 * change a run in flight. Missing rows return `undefined`, `delete` reports whether a row
 * was removed, and a write is one statement or one D1 batch.
 */
export interface WorkflowRepository {
  /** Workflows across every project, or only `projectId`; oldest first. */
  list(projectId?: ProjectId | undefined): Promise<Workflow[]>;
  /** The workflow with `id`, or `undefined` when it does not exist. */
  get(id: string): Promise<Workflow | undefined>;
  /**
   * Create a workflow at version 1.
   *
   * @throws ValiError if `graph` is not a valid graph.
   */
  create(input: WorkflowCreateInput): Promise<Workflow>;
  /**
   * Replace the graph and bump the version by one.
   *
   * @remarks
   * Runs keep the graph and version they pinned, so an edit never changes a run in flight.
   * `undefined` when the workflow does not exist.
   *
   * @throws ValiError if `graph` is not a valid graph.
   */
  update(id: string, graph: WorkflowGraph): Promise<Workflow | undefined>;
  /** Delete a workflow and, by cascade, its runs and node rows; returns whether a row was removed. */
  delete(id: string): Promise<boolean>;
  /**
   * Start a run of `workflowId`, copying its current version and graph.
   *
   * @remarks
   * The run starts `queued` with one `pending` row per node. The run and its nodes are one
   * D1 batch, so a failed node insert leaves no run behind. `undefined` when the workflow
   * does not exist, so a deleted workflow cannot be run.
   */
  createRun(input: { workflowId: string; input: string }): Promise<WorkflowRun | undefined>;
  /** The run with `id` and its nodes, or `undefined` when it does not exist. */
  getRun(id: string): Promise<WorkflowRun | undefined>;
  /**
   * The graph the run pinned when it started, even if the workflow moved on.
   *
   * @remarks
   * `undefined` when the run does not exist. The stored graph is validated on read.
   */
  getRunGraph(id: string): Promise<WorkflowGraph | undefined>;
  /** Runs across every workflow, or only `workflowId`; newest first. */
  listRuns(workflowId?: string | undefined): Promise<WorkflowRun[]>;
  /** Set the run status; a no-op when the run does not exist. */
  setRunStatus(id: string, status: WorkflowRunStatus): Promise<void>;
  /**
   * Finish a run: set its status, optional output, and `finished_at`.
   *
   * @remarks
   * `output` is stored as given and null when omitted. A no-op when the run does not exist.
   */
  finishRun(id: string, status: WorkflowRunStatus, output?: string | undefined): Promise<void>;
  /** Mark a node running with its prompt and start time; a no-op when the node is missing. */
  setNodeRunning(runId: string, nodeId: string, prompt: string): Promise<void>;
  /** Record a node's terminal status, output, and conversation; a no-op when the node is missing. */
  setNodeResult(
    runId: string,
    nodeId: string,
    status: WorkflowNodeStatus,
    output: string,
    conversationId?: ConversationId | undefined,
  ): Promise<void>;
  /** Mark a node waiting for input with its prompt and start time; a no-op when the node is missing. */
  setNodeWaiting(runId: string, nodeId: string, prompt: string): Promise<void>;
  /**
   * Complete a waiting node with `output`.
   *
   * @remarks
   * Only a `waiting` node can be completed here. `undefined` when the node is missing or not
   * waiting, so a duplicate resume cannot overwrite a finished node.
   */
  completeNode(runId: string, nodeId: string, output: string): Promise<WorkflowRunNode | undefined>;
  /**
   * Recover runs interrupted by a restart.
   *
   * @remarks
   * Nodes left `running` go back to `pending`, then the `queued` and `running` runs are
   * returned oldest first. The reset and the read are one D1 batch, so the returned runs are
   * the ones just reset. Runs in other states are not returned.
   */
  resumeRuns(): Promise<WorkflowRun[]>;
}

/**
 * Build the workflow repository over `context`.
 *
 * @internal
 */
export function workflowRepository(context: StoreContext): WorkflowRepository {
  const { sql, now, newId } = context;

  const get = async (id: string): Promise<Workflow | undefined> => {
    const row = await sql.get("SELECT * FROM workflows WHERE id = ?", [id]);
    return row === undefined ? undefined : parseWorkflow(row);
  };

  const getRun = async (id: string): Promise<WorkflowRun | undefined> => {
    const row = await sql.get("SELECT * FROM workflow_runs WHERE id = ?", [id]);
    if (row === undefined) return undefined;
    const nodes = (
      await sql.all("SELECT * FROM workflow_nodes WHERE run_id = ? ORDER BY rowid", [id])
    ).map((node) => parseWorkflowRunNode(node));
    return { ...parseWorkflowRun(row), nodes };
  };

  return {
    async list(projectId) {
      const rows =
        projectId === undefined
          ? await sql.all("SELECT * FROM workflows ORDER BY created_at")
          : await sql.all("SELECT * FROM workflows WHERE project_id = ? ORDER BY created_at", [
              projectId,
            ]);
      return rows.map((row) => parseWorkflow(row));
    },
    get,
    async create(input) {
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
      const row = await sql.get(
        "INSERT INTO workflows (id, project_id, name, version, graph_json, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
        [
          workflow.id,
          workflow.project_id,
          workflow.name,
          workflow.version,
          JSON.stringify(workflow.graph),
          workflow.created_at,
          workflow.updated_at,
        ],
      );
      if (row === undefined) throw new Error("workflow was not created");
      return parseWorkflow(row);
    },
    async update(id, graph) {
      const parsed = v.parse(WorkflowGraphSchema, graph);
      const row = await sql.get(
        "UPDATE workflows SET version = version + 1, graph_json = ?, updated_at = ? " +
          "WHERE id = ? RETURNING *",
        [JSON.stringify(parsed), now(), id],
      );
      return row === undefined ? undefined : parseWorkflow(row);
    },
    async delete(id) {
      return (await sql.run("DELETE FROM workflows WHERE id = ?", [id])) > 0;
    },
    async createRun(input) {
      const workflow = await get(input.workflowId);
      if (workflow === undefined) return undefined;
      const runId = newId();
      const createdAt = now();
      const statements: SqlStatement[] = [
        {
          sql:
            "INSERT INTO workflow_runs (id, workflow_id, version, graph_json, status, input, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
          params: [
            runId,
            workflow.id,
            workflow.version,
            JSON.stringify(workflow.graph),
            "queued",
            input.input,
            createdAt,
          ],
        },
        ...workflow.graph.nodes.map((node) => ({
          sql: "INSERT INTO workflow_nodes (run_id, node_id, status) VALUES (?, ?, 'pending')",
          params: [runId, node.id],
        })),
      ];
      await sql.batch(statements);
      const run = await getRun(runId);
      if (run === undefined) throw new Error("run was not created");
      return run;
    },
    getRun,
    async getRunGraph(id) {
      const row = await sql.get("SELECT graph_json FROM workflow_runs WHERE id = ?", [id]);
      if (row === undefined) return undefined;
      const graphJson = v.parse(v.object({ graph_json: v.string() }), row).graph_json;
      const parsed: unknown = JSON.parse(graphJson);
      return v.parse(WorkflowGraphSchema, parsed);
    },
    async listRuns(workflowId) {
      const rows =
        workflowId === undefined
          ? await sql.all("SELECT * FROM workflow_runs ORDER BY created_at DESC")
          : await sql.all(
              "SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC",
              [workflowId],
            );
      return rows.map((row) => parseWorkflowRun(row));
    },
    async setRunStatus(id, status) {
      await sql.run("UPDATE workflow_runs SET status = ? WHERE id = ?", [status, id]);
    },
    async finishRun(id, status, output) {
      await sql.run(
        "UPDATE workflow_runs SET status = ?, output = ?, finished_at = ? WHERE id = ?",
        [status, output ?? null, now(), id],
      );
    },
    async setNodeRunning(runId, nodeId, prompt) {
      await sql.run(
        "UPDATE workflow_nodes SET status = 'running', prompt = ?, started_at = ? WHERE run_id = ? AND node_id = ?",
        [prompt, now(), runId, nodeId],
      );
    },
    async setNodeResult(runId, nodeId, status, output, conversationId) {
      await sql.run(
        "UPDATE workflow_nodes SET status = ?, output = ?, conversation_id = ?, finished_at = ? WHERE run_id = ? AND node_id = ?",
        [status, output, conversationId ?? null, now(), runId, nodeId],
      );
    },
    async setNodeWaiting(runId, nodeId, prompt) {
      await sql.run(
        "UPDATE workflow_nodes SET status = 'waiting', prompt = ?, started_at = ? WHERE run_id = ? AND node_id = ?",
        [prompt, now(), runId, nodeId],
      );
    },
    async completeNode(runId, nodeId, output) {
      const row = await sql.get(
        "UPDATE workflow_nodes SET status = 'done', output = ?, finished_at = ? " +
          "WHERE run_id = ? AND node_id = ? AND status = 'waiting' RETURNING *",
        [output, now(), runId, nodeId],
      );
      return row === undefined ? undefined : parseWorkflowRunNode(row);
    },
    async resumeRuns() {
      const results = await sql.batch([
        { sql: "UPDATE workflow_nodes SET status = 'pending' WHERE status = 'running'" },
        {
          sql: "SELECT * FROM workflow_runs WHERE status IN ('queued', 'running') ORDER BY created_at",
        },
      ]);
      return (results[1] ?? []).map((row) => parseWorkflowRun(row));
    },
  };
}
