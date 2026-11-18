// The Trail model (D104): the unit of work that replaces Task. It is its own module rather than
// another block in `types.ts`, because the vocabulary is large and the transition table lives
// beside it. `types.ts` stays the place for the small, cross-cutting model types.

import type { ConversationId, ProjectId } from "./types.ts";

/**
 * The closed Trail state vocabulary (D104, trail-model-v1 §1.2).
 *
 * @remarks
 * Declaration order is the movement's order: draft, active, in_review, merged, observing,
 * closed, abandoned. `blocked` is not a state (D104): what is stuck is a decision or a gate,
 * not a column. Legal movement is only in this module's table.
 */
export const TRAIL_STATES = [
  "draft",
  "active",
  "in_review",
  "merged",
  "observing",
  "closed",
  "abandoned",
] as const;
/** One Trail state. */
export type TrailState = (typeof TRAIL_STATES)[number];

/** The closed Trail kind vocabulary: what sort of intent this Trail anchors. */
export const TRAIL_KINDS = ["feature", "fix", "chore", "spike"] as const;
/** One Trail kind. */
export type TrailKind = (typeof TRAIL_KINDS)[number];

/** The closed Trail priority vocabulary, highest first. */
export const TRAIL_PRIORITIES = ["urgent", "high", "normal", "low"] as const;
/** One Trail priority. */
export type TrailPriority = (typeof TRAIL_PRIORITIES)[number];

/** The closed Change state vocabulary; a Change names the code it moved to. */
export const TRAIL_CHANGE_STATES = ["open", "in_review", "merged", "abandoned"] as const;
/** One Change state. */
export type TrailChangeState = (typeof TRAIL_CHANGE_STATES)[number];

/**
 * The closed Finding severity vocabulary (trail-model-v1 §2.4).
 *
 * @remarks
 * `none` is "a note without weight", not "not yet decided": a finding without severity is what
 * blocks a gate, so an unknown value can never be read as `none`.
 */
export const TRAIL_FINDING_SEVERITIES = ["high", "medium", "low", "none"] as const;
/** One Finding severity. */
export type TrailFindingSeverity = (typeof TRAIL_FINDING_SEVERITIES)[number];

/** The closed Finding source vocabulary: who raised the point. */
export const TRAIL_FINDING_SOURCES = ["agent", "test", "human"] as const;
/** One Finding source. */
export type TrailFindingSource = (typeof TRAIL_FINDING_SOURCES)[number];

/** The closed Finding status vocabulary; resolving or dismissing is a later append. */
export const TRAIL_FINDING_STATUSES = ["open", "resolved", "dismissed"] as const;
/** One Finding status. */
export type TrailFindingStatus = (typeof TRAIL_FINDING_STATUSES)[number];

/**
 * The closed Decision action vocabulary (trail-model-v1 §1.1).
 *
 * @remarks
 * `approve` names the head commit it approves, so a later head invalidates it; `request_changes`
 * and `reject` are the refusal paths.
 */
export const TRAIL_DECISION_ACTIONS = ["approve", "request_changes", "reject"] as const;
/** One Decision action. */
export type TrailDecisionAction = (typeof TRAIL_DECISION_ACTIONS)[number];

/** The closed gate kind vocabulary (trail-model-v1 §5); metric and feedback gates are Phase 2. */
export const TRAIL_GATE_KINDS = ["human_review", "tests", "findings", "freshness"] as const;
/** One gate kind. */
export type TrailGateKind = (typeof TRAIL_GATE_KINDS)[number];

/** The closed gate status vocabulary: `ask` is the default a Trail's gates start at. */
export const TRAIL_GATE_STATUSES = ["pending", "pass", "fail", "ask"] as const;
/** One gate status. */
export type TrailGateStatus = (typeof TRAIL_GATE_STATUSES)[number];

/** The closed feedback channel vocabulary: where the signal came from. */
export const TRAIL_FEEDBACK_CHANNELS = [
  "in_app",
  "email",
  "support",
  "interview",
  "other",
] as const;
/** One feedback channel. */
export type TrailFeedbackChannel = (typeof TRAIL_FEEDBACK_CHANNELS)[number];

/** The closed feedback sentiment vocabulary. */
export const TRAIL_FEEDBACK_SENTIMENTS = ["positive", "neutral", "negative"] as const;
/** One feedback sentiment. */
export type TrailFeedbackSentiment = (typeof TRAIL_FEEDBACK_SENTIMENTS)[number];

/**
 * The closed provenance vocabulary: who recorded an attachment (trail-model-v1 §2.2).
 *
 * @remarks
 * `user`, `agent`, and `service` are the same actors the decisions and journals name.
 */
export const TRAIL_ACTOR_KINDS = ["user", "agent", "service"] as const;
/** One attachment provenance. */
export type TrailActorKind = (typeof TRAIL_ACTOR_KINDS)[number];

/** The closed evaluation status vocabulary; `error` is "the check could not decide". */
export const TRAIL_EVAL_STATUSES = ["pass", "fail", "error"] as const;
/** One evaluation status. */
export type TrailEvalStatus = (typeof TRAIL_EVAL_STATUSES)[number];

/**
 * One Trail: the intent, its state, and when it moved.
 *
 * @remarks
 * A Trail belongs to exactly one Project (trail-model-v1 T-1). It has no board column: the state
 * is this field, and what is stuck is said by a Decision or a Gate. `description` and
 * `acceptance` are free text; `acceptance` says how a person would know the intent was met.
 */
export interface Trail {
  /**
   * The Trail's id.
   *
   * @remarks
   * For a Trail the backfill made from a task, the id is `trail-<task id>`, so removing the
   * `tasks` table later still leaves a way back to the row it came from.
   */
  readonly id: string;
  /** The Project that owns this Trail. */
  readonly project_id: ProjectId;
  readonly title: string;
  readonly description: string;
  /** How a person would know the intent was met; free text. */
  readonly acceptance: string;
  readonly kind: TrailKind;
  readonly state: TrailState;
  readonly priority: TrailPriority;
  /** The session subject or agent that created the Trail. */
  readonly created_by: string;
  /** ISO 8601 (UTC). */
  readonly created_at: string;
  /** ISO 8601 (UTC). */
  readonly updated_at: string;
}

/**
 * One Change: the `base..head` pair a Trail moved the code to.
 *
 * @remarks
 * A Change is the diff's address, not its contents (trail-model-v1 §3): the diff comes from the
 * commits. `head_commit` differs from `base_commit` (T-2). `repo_id` is null until a Trail spans
 * more than one repository; the column exists so that day does not reshape the Trail.
 */
export interface TrailChange {
  readonly id: string;
  readonly trail_id: string;
  readonly workspace_id: string;
  /** The repository inside the workspace; null while a Trail has one repository. */
  readonly repo_id: string | null;
  readonly base_commit: string;
  readonly head_commit: string;
  /** The run that produced the change, when a run did. */
  readonly run_id: string | null;
  readonly state: TrailChangeState;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * One link from a Trail to a conversation, session, or run.
 *
 * @remarks
 * A Trail may have zero links (trail-model-v1 T-3): a dispatched piece of work has no
 * conversation. The link exists so a reader can go from the intent to the transcript, which is
 * kept in the Session object and is not copied here.
 */
export interface TrailSession {
  readonly id: string;
  readonly trail_id: string;
  readonly conversation_id: ConversationId | null;
  readonly session_id: string;
  readonly run_id: string | null;
  /** ISO 8601 (UTC) when the link was made. */
  readonly linked_at: string;
}

/**
 * One finding: a point raised by a review, a test, or a person.
 *
 * @remarks
 * Findings are records with a status, not attachments (trail-model-v1 §2.4), because a gate reads
 * them. `file` and `hunk` locate the point; they are null when the point is not about one place.
 */
export interface TrailFinding {
  readonly id: string;
  readonly trail_id: string;
  /** The change the point is about; null when it is about the Trail. */
  readonly change_id: string | null;
  readonly severity: TrailFindingSeverity;
  readonly source: TrailFindingSource;
  readonly status: TrailFindingStatus;
  readonly file: string | null;
  readonly hunk: string | null;
  readonly summary: string;
  /** ISO 8601 (UTC). */
  readonly created_at: string;
  /** ISO 8601 (UTC); null while open. */
  readonly resolved_at: string | null;
  /** Who resolved or dismissed it; null while open. */
  readonly resolved_by: string | null;
}

/**
 * One decision: an approval, a change request, or a rejection, appended and never edited.
 *
 * @remarks
 * `head_commit` is the commit the decision was made against (trail-model-v1 T-5). An approval
 * names it so a later head invalidates the approval; null means the decision was about the Trail
 * rather than a particular change.
 */
export interface TrailDecision {
  readonly id: string;
  readonly trail_id: string;
  readonly change_id: string | null;
  /** The session subject that decided. */
  readonly actor: string;
  readonly action: TrailDecisionAction;
  readonly head_commit: string | null;
  readonly note: string;
  /** ISO 8601 (UTC) when the decision was made. */
  readonly at: string;
}

/**
 * One gate evaluation: what a gate said about a Trail or a Change at a moment.
 *
 * @remarks
 * A gate result names the commit it was evaluated against (trail-model-v1 §5), so a changed head
 * is re-evaluated rather than reusing the old answer. `detail` is free text; it is null when the
 * gate has nothing to add.
 */
export interface TrailGate {
  readonly id: string;
  readonly trail_id: string;
  readonly change_id: string | null;
  readonly gate: TrailGateKind;
  readonly status: TrailGateStatus;
  readonly detail: string | null;
  /** ISO 8601 (UTC) when the gate was evaluated. */
  readonly evaluated_at: string;
}

/**
 * One piece of user feedback, a product signal attached after the fact.
 *
 * @remarks
 * Attachments are append-only (trail-model-v1 T-4): a correction is a new row whose
 * `supersedes_id` names the row it replaces. `occurred_at` is when the signal happened;
 * `recorded_at` is when it was attached, and `occurred_at <= recorded_at`. `external_id` is the
 * idempotency key when the signal came from somewhere else.
 */
export interface TrailFeedback {
  readonly id: string;
  readonly trail_id: string;
  /** The change the feedback is about; null when it is about the Trail. */
  readonly change_id: string | null;
  readonly channel: TrailFeedbackChannel;
  readonly summary: string;
  readonly sentiment: TrailFeedbackSentiment;
  /** Where the feedback can be read in full, when it exists somewhere else. */
  readonly source_url: string | null;
  readonly source: string;
  readonly actor: TrailActorKind;
  readonly external_id: string | null;
  /** ISO 8601 (UTC) when the signal happened. */
  readonly occurred_at: string;
  /** ISO 8601 (UTC) when it was attached. */
  readonly recorded_at: string;
  /** The row this one corrects; null for the first statement of a signal. */
  readonly supersedes_id: string | null;
}

/**
 * One product metric attached to a Trail.
 *
 * @remarks
 * A metric is a correlation, not a gate (D104): it has a window and a source, and a reader shows
 * the trend beside the change rather than passing or failing it. `value` is a number, so a unit
 * and window are what make it meaningful.
 */
export interface TrailMetric {
  readonly id: string;
  readonly trail_id: string;
  readonly change_id: string | null;
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  /** ISO 8601 (UTC) start of the measured window. */
  readonly window_start: string;
  /** ISO 8601 (UTC) end of the measured window. */
  readonly window_end: string;
  readonly source: string;
  readonly external_id: string | null;
  /** ISO 8601 (UTC) when the measurement happened. */
  readonly occurred_at: string;
  /** ISO 8601 (UTC) when it was attached. */
  readonly recorded_at: string;
}

/**
 * One evaluation attached to a Trail: a test, lint, or review verdict.
 *
 * @remarks
 * An evaluation is evidence (trail-model-v1 §2.1), not a gate: the gate reads the evaluations it
 * cares about and records its own result. `detail` is free text and is null when there is none.
 */
export interface TrailEval {
  readonly id: string;
  readonly trail_id: string;
  readonly change_id: string | null;
  readonly name: string;
  readonly status: TrailEvalStatus;
  readonly detail: string | null;
  readonly source: string;
  /** ISO 8601 (UTC) when the evaluation ran. */
  readonly occurred_at: string;
  /** ISO 8601 (UTC) when it was attached. */
  readonly recorded_at: string;
}

/**
 * One note attached to a Trail: a decision's context or a meeting's minutes.
 *
 * @remarks
 * `body` is markdown. A note is append-only like every attachment.
 */
export interface TrailNote {
  readonly id: string;
  readonly trail_id: string;
  readonly body: string;
  readonly author: string;
  /** ISO 8601 (UTC) when it was written. */
  readonly occurred_at: string;
  /** ISO 8601 (UTC) when it was attached. */
  readonly recorded_at: string;
}

/**
 * The Trail state machine's table: the states one state may move to (trail-model-v1 §1.2).
 *
 * @remarks
 * The two diagrams collapse to this table: forward movement, `in_review` back to `active`
 * (a change request), and any live state to `abandoned`. `closed` and `abandoned` are terminal,
 * so a Trail that ended is not reopened by moving it back; a reopen is a new Trail or, from
 * `observing`, the explicit move to `active` that the table allows. The table is the only
 * definition of legal movement; `store` reads it before it writes a state.
 */
const TRAIL_TRANSITIONS: Record<TrailState, readonly TrailState[]> = {
  draft: ["active", "abandoned"],
  active: ["in_review", "abandoned"],
  in_review: ["active", "merged", "abandoned"],
  merged: ["observing"],
  observing: ["active", "closed"],
  closed: [],
  abandoned: [],
};

/**
 * The transition table, for the store and for the test that pins it.
 *
 * @internal
 * @remarks
 * Exported because the store imports core at run time (the test alias maps `@hns/core` to source,
 * the build to dist) and because the test that pins the table needs the thing it pins. It is
 * deliberately not part of `@hns/core`'s own tests' input: the expected table is written out.
 */
export const TRAIL_TRANSITIONS_FOR_TEST: Readonly<Record<TrailState, readonly TrailState[]>> =
  TRAIL_TRANSITIONS;

/**
 * Whether a Trail may move from one state to another.
 *
 * @param from - The Trail's current state.
 * @param to - The state a caller wants to store.
 * @returns `true` when the move is in the Trail transition table.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(canTrailTransition("draft", "active")).toBe(true);
 * expect(canTrailTransition("merged", "abandoned")).toBe(false);
 * ```
 */
export function canTrailTransition(from: TrailState, to: TrailState): boolean {
  return TRAIL_TRANSITIONS[from].includes(to);
}

/**
 * The first state a Trail enters once it has a Change.
 *
 * @param from - The Trail's current state.
 * @returns `active` for a draft, and `from` for any state the first change leaves alone.
 *
 * @remarks
 * A draft is an intent with no change yet; adding the first change is what makes it active
 * (trail-model-v1 §1.2). A Change added to a Trail that is already moving does not move the Trail
 * by itself, because the change's own review is what moves it. The `switch` is exhaustive so a
 * new state fails to compile until this function says what a first change does to it.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(trailStateWithFirstChange("draft")).toBe("active");
 * expect(trailStateWithFirstChange("observing")).toBe("observing");
 * ```
 */
export function trailStateWithFirstChange(from: TrailState): TrailState {
  switch (from) {
    case "draft":
      return "active";
    case "active":
    case "in_review":
    case "merged":
    case "observing":
    case "closed":
    case "abandoned":
      return from;
    default:
      return assertNever(from);
  }
}

/**
 * Whether a state still tracks the Trail: not closed and not abandoned.
 *
 * @param state - A Trail state.
 * @returns `false` for `closed` and `abandoned`.
 *
 * @remarks
 * The exhaustive `switch` is the second reader of the state union: adding a state fails to
 * compile here until someone says whether it tracks. An ended Trail still accepts attachments
 * (trail-model-v1 §2.2), so this answers "does the Trail move?", not "may it be written to?".
 */
export function isTrailOpen(state: TrailState): boolean {
  switch (state) {
    case "draft":
    case "active":
    case "in_review":
    case "merged":
    case "observing":
      return true;
    case "closed":
    case "abandoned":
      return false;
    default:
      return assertNever(state);
  }
}

/**
 * Fail on an unhandled union member.
 *
 * @internal
 * @remarks
 * The `never` arm of an exhaustive `switch`: a new member fails to compile here, and a value
 * that bypassed the type (a hand-written row) throws instead of being read as a default.
 * @throws Error naming the unexpected value.
 */
function assertNever(value: never): never {
  throw new Error("unexpected trail state: " + String(value));
}
