/* oxlint-disable anti-slop/no-unknown-parameters --
   These functions are the DB boundary: they take an unknown row and parse it.
*/
import * as v from "valibot";
import type {
  Automation,
  Conversation,
  Firing,
  Project,
  Task,
  Trail,
  TrailChange,
  TrailDecision,
  TrailEval,
  TrailFeedback,
  TrailFinding,
  TrailGate,
  TrailMetric,
  TrailNote,
  TrailSession,
  Workflow,
  WorkflowRun,
  WorkflowRunNode,
} from "@hns/core";
import type { PolicyRevision } from "@hns/core/capability";
import {
  AutomationRowSchema,
  ConversationRowSchema,
  FiringRowSchema,
  PolicyActiveRowSchema,
  PolicyProposalRowSchema,
  PolicyRevisionRowSchema,
  ProjectRowSchema,
  TaskRowSchema,
  TrailChangeRowSchema,
  TrailDecisionRowSchema,
  TrailEvalRowSchema,
  TrailFeedbackRowSchema,
  TrailFindingRowSchema,
  TrailGateRowSchema,
  TrailMetricRowSchema,
  TrailNoteRowSchema,
  TrailRowSchema,
  TrailSessionRowSchema,
  WorkflowRowSchema,
  WorkflowRunNodeRowSchema,
  WorkflowRunRowSchema,
} from "./schemas.ts";
import type { PolicyActive, StoredPolicyProposal } from "./repositories/policy.ts";

/**
 * Parse a raw `projects` row into the public {@link Project}.
 *
 * @remarks
 * This is the DB boundary: the row is untrusted until it passes {@link ProjectRowSchema}.
 * Storage shapes do not leave the package; callers only see the public model.
 *
 * @param input - A row read from SQLite.
 * @returns The validated project.
 * @throws ValiError if a required column is missing or has the wrong type.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(parseProject({ id: "p1", name: "Project", workspace_root: "projects/p1", egress: "inherit", created_at: "2026-01-01T00:00:00.000Z" }).agent_cwd).toBe("projects/p1");
 * expect(() => parseProject({ id: "p1", name: "Project", workspace_root: "../x", egress: "inherit", created_at: "2026-01-01T00:00:00.000Z" })).toThrow();
 * expect(() => parseProject({ name: "Project" })).toThrow();
 * ```
 */
export function parseProject(input: unknown): Project {
  return v.parse(ProjectRowSchema, input);
}

/**
 * Parse a raw `conversations` row into the public {@link Conversation}.
 *
 * @remarks
 * The 0 or 1 `archived` column becomes a boolean. A soft-deleted conversation still parses;
 * `deleted_at` is the tombstone, not a reason to fail.
 *
 * @param input - A row read from SQLite.
 * @returns The validated conversation.
 * @throws ValiError if a required column is missing or has an unknown value.
 */
export function parseConversation(input: unknown): Conversation {
  return v.parse(ConversationRowSchema, input);
}

/**
 * Parse a raw `tasks` row into the public {@link Task}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated task.
 * @throws ValiError if a required column is missing or `status` is not a known status.
 */
export function parseTask(input: unknown): Task {
  return v.parse(TaskRowSchema, input);
}

/**
 * Parse a raw `workflows` row into the public {@link Workflow}.
 *
 * @remarks
 * `graph_json` is decoded and validated into a `WorkflowGraph`; a stored graph that no
 * longer validates throws rather than being returned partially.
 *
 * @param input - A row read from SQLite.
 * @returns The validated workflow.
 * @throws ValiError if a column or the decoded graph is invalid.
 * @throws SyntaxError if `graph_json` is not valid JSON.
 */
export function parseWorkflow(input: unknown): Workflow {
  return v.parse(WorkflowRowSchema, input);
}

/**
 * Parse a raw `workflow_runs` row into the public {@link WorkflowRun}.
 *
 * @remarks
 * `nodes` stays absent when the input did not include it, which is different from a run with
 * no nodes. `version` is the workflow version the run pinned at start.
 *
 * @param input - A row read from SQLite, optionally with its nodes.
 * @returns The validated run.
 * @throws ValiError if a required column is missing or `status` is unknown.
 */
export function parseWorkflowRun(input: unknown): WorkflowRun {
  return v.parse(WorkflowRunRowSchema, input);
}

/**
 * Parse a raw `workflow_nodes` row into the public {@link WorkflowRunNode}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated node.
 * @throws ValiError if a required column is missing or `status` is unknown.
 */
export function parseWorkflowRunNode(input: unknown): WorkflowRunNode {
  return v.parse(WorkflowRunNodeRowSchema, input);
}

/**
 * Parse a raw `automations` row into the public {@link Automation}.
 *
 * @remarks
 * `trigger_json` and `action_json` are decoded and validated, and the 0 or 1 `enabled`
 * column becomes a boolean.
 *
 * @param input - A row read from SQLite.
 * @returns The validated automation.
 * @throws ValiError if a column or a decoded trigger or action is invalid.
 * @throws SyntaxError if the trigger or action text is not valid JSON.
 */
export function parseAutomation(input: unknown): Automation {
  return v.parse(AutomationRowSchema, input);
}

/**
 * Parse a raw `firings` row into the public {@link Firing}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated firing.
 * @throws ValiError if a required column is missing or `status` is unknown.
 */
export function parseFiring(input: unknown): Firing {
  return v.parse(FiringRowSchema, input);
}

/**
 * Parse a raw `policy_revisions` row into the public {@link PolicyRevision}.
 *
 * @remarks
 * `document_json` is decoded into a `PolicyDocument`; a stored document this build cannot parse
 * throws rather than being returned partially, because a revision is immutable.
 *
 * @param input - A row read from SQLite.
 * @returns The validated revision.
 * @throws ValiError if a column or the decoded document is invalid.
 * @throws SyntaxError if `document_json` is not valid JSON.
 */
export function parsePolicyRevision(input: unknown): PolicyRevision {
  return v.parse(PolicyRevisionRowSchema, input);
}

/**
 * Parse a raw `policy_active` row into the active pointer.
 *
 * @param input - A row read from SQLite.
 * @returns The validated pointer.
 * @throws ValiError if a column is missing or `revision` is not positive.
 */
export function parsePolicyActive(input: unknown): PolicyActive {
  return v.parse(PolicyActiveRowSchema, input);
}

/**
 * Parse a raw `policy_proposals` row into the stored proposal.
 *
 * @remarks
 * `candidate_json` is decoded into a `PolicyDocument`. The optional `decided*` members are
 * absent, not `undefined`, until the row carries them.
 *
 * @param input - A row read from SQLite.
 * @returns The validated proposal, with the store's `updatedAt` alongside the public fields.
 * @throws ValiError if a column, `status`, or the decoded candidate is invalid.
 * @throws SyntaxError if `candidate_json` is not valid JSON.
 */
export function parsePolicyProposal(input: unknown): StoredPolicyProposal {
  return v.parse(PolicyProposalRowSchema, input);
}

/**
 * Parse a raw `trails` row into the public {@link Trail}.
 *
 * @remarks
 * This is the one place a Trail row becomes a Trail. `state`, `kind`, and `priority` are closed
 * vocabularies: a row that holds a value this build does not know throws, so a corrupted row is
 * never read as a default state. The Trail table's CHECK refuses most such rows on the way in, so
 * the corruption this catches is the kind the column cannot see (a value that is a vocabulary
 * member plus a stray byte, a column of the wrong type, or a row written before the CHECK).
 *
 * @param input - A row read from SQLite.
 * @returns The validated Trail.
 * @throws ValiError if a required column is missing, a column has the wrong type, or `state`,
 * `kind`, or `priority` is unknown.
 *
 * @example
 * ```ts @import.meta.vitest
 * const row = { id: "t1", project_id: "p1", title: "T", description: "", acceptance: "", kind: "feature", state: "draft", priority: "normal", created_by: "u1", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
 * expect(parseTrail(row).state).toBe("draft");
 * expect(() => parseTrail({ ...row, state: "blocked" })).toThrow();
 * expect(() => parseTrail({ ...row, state: "merged " })).toThrow();
 * ```
 */
export function parseTrail(input: unknown): Trail {
  return v.parse(TrailRowSchema, input);
}

/**
 * Parse a raw `trail_changes` row into the public {@link TrailChange}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated Change.
 * @throws ValiError if a column is missing or `state` is unknown.
 */
export function parseTrailChange(input: unknown): TrailChange {
  return v.parse(TrailChangeRowSchema, input);
}

/**
 * Parse a raw `trail_sessions` row into the public {@link TrailSession}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated link.
 * @throws ValiError if a column is missing or `conversation_id` is not a conversation id.
 */
export function parseTrailSession(input: unknown): TrailSession {
  return v.parse(TrailSessionRowSchema, input);
}

/**
 * Parse a raw `trail_feedback` row into the public {@link TrailFeedback}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated feedback.
 * @throws ValiError if a column is missing or `channel`, `sentiment`, or `actor` is unknown.
 */
export function parseTrailFeedback(input: unknown): TrailFeedback {
  return v.parse(TrailFeedbackRowSchema, input);
}

/**
 * Parse a raw `trail_metrics` row into the public {@link TrailMetric}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated metric.
 * @throws ValiError if a column is missing or `value` is not a number.
 */
export function parseTrailMetric(input: unknown): TrailMetric {
  return v.parse(TrailMetricRowSchema, input);
}

/**
 * Parse a raw `trail_evals` row into the public {@link TrailEval}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated evaluation.
 * @throws ValiError if a column is missing or `status` is unknown.
 */
export function parseTrailEval(input: unknown): TrailEval {
  return v.parse(TrailEvalRowSchema, input);
}

/**
 * Parse a raw `trail_notes` row into the public {@link TrailNote}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated note.
 * @throws ValiError if a column is missing.
 */
export function parseTrailNote(input: unknown): TrailNote {
  return v.parse(TrailNoteRowSchema, input);
}

/**
 * Parse a raw `trail_decisions` row into the public {@link TrailDecision}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated decision.
 * @throws ValiError if a column is missing or `action` is unknown.
 */
export function parseTrailDecision(input: unknown): TrailDecision {
  return v.parse(TrailDecisionRowSchema, input);
}

/**
 * Parse a raw `trail_findings` row into the public {@link TrailFinding}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated finding.
 * @throws ValiError if a column is missing or `severity`, `source`, or `status` is unknown.
 */
export function parseTrailFinding(input: unknown): TrailFinding {
  return v.parse(TrailFindingRowSchema, input);
}

/**
 * Parse a raw `trail_gates` row into the public {@link TrailGate}.
 *
 * @param input - A row read from SQLite.
 * @returns The validated gate result.
 * @throws ValiError if a column is missing or `gate` or `status` is unknown.
 */
export function parseTrailGate(input: unknown): TrailGate {
  return v.parse(TrailGateRowSchema, input);
}
