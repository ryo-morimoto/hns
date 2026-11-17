import * as v from "valibot";
import type { ProjectId, Workflow, WorkflowGraph, WorkflowRun } from "@hns/core";
import { WorkflowGraphSchema } from "../schemas.ts";
import type { StoreContext } from "../db.ts";
import { parseWorkflow, parseWorkflowRun, parseWorkflowRunNode } from "../parse.ts";

/**
 * Workflows and their runs.
 *
 * @remarks
 * The store hands out the read side only: no face edits a workflow or drives a run yet, so the
 * writes stay out of `Store`. A run pins the workflow's `version` and graph at the moment it is
 * created, so a later edit never changes a run in flight (the property `createRun` keeps).
 * Missing rows return `undefined`.
 */
export interface WorkflowRepository {
  /** Workflows across every project, or only `projectId`; oldest first. */
  list(projectId?: ProjectId | undefined): Promise<Workflow[]>;
  /** The workflow with `id`, or `undefined` when it does not exist. */
  get(id: string): Promise<Workflow | undefined>;
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
}

/**
 * Build the workflow repository over `context`.
 *
 * @internal
 */
export function workflowRepository(context: StoreContext): WorkflowRepository {
  const { sql } = context;

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
  };
}
