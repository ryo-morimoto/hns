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
 * The commit a Change's review is about: its head, or undefined when it has no Change.
 *
 * @param change - The Change being reviewed, or undefined for a Trail with none.
 * @returns The head commit, or undefined.
 *
 * @remarks
 * A review, an approval, and a gate are all about one commit (`trail-model-v1` §3, C2): the head
 * the Change names. A Trail with no Change has no commit to approve, which is why the answer is
 * not a separate state.
 */
export function trailHeadOf(
  change: { readonly head_commit: string } | undefined,
): string | undefined {
  return change?.head_commit;
}

/**
 * Whether an approval still holds for the head being reviewed (C2).
 *
 * @param decision - The approval, which names the head it decided on.
 * @param head - The commit under review now, or undefined when the Trail has no Change.
 * @returns `true` only for an approval recorded against exactly this head.
 *
 * @remarks
 * An approval is a statement about **one commit** (D104: `approve` names the head commit it
 * approves, so a later head invalidates it). A new head — a revise, a rebase, another Change —
 * therefore makes every earlier approval stale without anything being deleted: the record stays,
 * and the answer changes because the head changed. An approval with no `head_commit`, or a Trail
 * with no Change, is not valid for any head: a decision that does not name what it approved cannot
 * be checked, so it fails closed.
 */
export function trailApprovalHolds(
  decision: Pick<TrailDecision, "action" | "head_commit">,
  head: string | undefined,
): boolean {
  if (decision.action !== "approve") return false;
  if (decision.head_commit === null || head === undefined) return false;
  return decision.head_commit === head;
}

/**
 * The approval in force for a Trail's current head: the latest one that still holds (C2).
 *
 * @param decisions - The Trail's decisions, newest first.
 * @param head - The commit under review now, or undefined.
 * @returns The latest approval naming `head`, or undefined when none does.
 *
 * @remarks
 * "Newest first" is the order the Trail's `decisions` list is read in (the append-only record is
 * newest first, `core`'s Trail entity). Only `approve` counts here; a `request_changes` or a
 * `reject` is read by the caller that asks for the gate, because a refusal means something a
 * later approval has to be newer than.
 */
export function trailCurrentApproval(
  decisions: readonly Pick<TrailDecision, "action" | "head_commit">[],
  head: string | undefined,
): Pick<TrailDecision, "action" | "head_commit"> | undefined {
  return decisions.find((decision) => trailApprovalHolds(decision, head));
}

/** The finding severities that block a merge while the finding is open (C3). */
export const TRAIL_BLOCKING_SEVERITIES: readonly TrailFindingSeverity[] = ["high"];

/**
 * Whether a Finding stops a merge: `high` and still open (C3).
 *
 * @param finding - The finding as the gate reads it.
 * @returns `true` for a `high` finding whose status is `open`.
 *
 * @remarks
 * Only `high` blocks. `medium`, `low`, and `none` are recorded and shown, and a `high` one that
 * was resolved or dismissed stops blocking — dismissing is how a person says "I read this and it
 * does not stop the merge", which is a decision the record keeps.
 */
export function trailFindingBlocks(finding: Pick<TrailFinding, "severity" | "status">): boolean {
  return finding.status === "open" && TRAIL_BLOCKING_SEVERITIES.includes(finding.severity);
}

/**
 * One gate's answer, as a reviewer sees it: the gate, its status, and why.
 *
 * @remarks
 * `detail` is the reason in a few words ("2 findings open at high"), never a sentence a screen
 * has to parse; the screen shows it beside the gate's name. The four gates are the ones
 * `trail-model-v1` §5 names and the `trail_gates` table stores.
 */
export interface TrailGateLine {
  readonly gate: TrailGateKind;
  readonly status: TrailGateStatus;
  readonly detail: string;
}

/** What a gate evaluation is made from: the Trail's head and what the record says about it. */
export interface TrailGateInput {
  /** The commit under review, or undefined for a Trail with no Change. */
  readonly head: string | undefined;
  /** Whether the Change's `base_commit` is what the workspace's base ref holds now. */
  readonly fresh: boolean;
  /** The Trail's findings, in any order. */
  readonly findings: readonly Pick<TrailFinding, "severity" | "status">[];
  /** The Trail's decisions, newest first. */
  readonly decisions: readonly Pick<TrailDecision, "action" | "head_commit">[];
}

/**
 * Evaluate the four gates (C3): human, tests, findings, freshness.
 *
 * @param input - The head, freshness, findings, and decisions the evaluation reads.
 * @returns One line per gate in `TRAIL_GATE_KINDS` order, each with the reason it holds.
 *
 * @remarks
 * **The gates are computed, not stored.** A change of head moves the human gate by itself, a
 * resolved finding moves the findings gate by itself, and a moved base ref moves freshness by
 * itself; a stored row would be an answer from a moment, shown beside a Trail that moved after
 * it. The `trail_gates` table records what a gate said (append-only evidence); this function is
 * what a screen asks now.
 *
 * - **human_review**: `pass` when the latest approval names the current head; otherwise `fail`
 *   naming what is missing (no Change, no approval at this head).
 * - **tests**: `ask`. This build stores evaluations (`trail_evals`) but nothing records one yet,
 *   so "no evidence" and "failed evidence" would read the same. It says "ask" rather than "pass"
 *   because a gate that passes by default is not a gate.
 * - **findings**: `pass` when nothing open is `high`; `fail` naming the count when something is.
 * - **freshness**: `pass` when the base the Change was taken from is still the base, `fail` when it
 *   moved (a rebase is needed), and `ask` for a Trail with no Change.
 */
export function trailGates(input: TrailGateInput): readonly TrailGateLine[] {
  const approval = trailCurrentApproval(input.decisions, input.head);
  const blocking = input.findings.filter(trailFindingBlocks).length;
  return [
    {
      gate: "human_review",
      status: approval === undefined ? "fail" : "pass",
      detail: humanDetailOf(input.head, approval),
    },
    {
      gate: "tests",
      status: "ask",
      detail: "no test evidence is recorded on this Trail",
    },
    {
      gate: "findings",
      status: blocking > 0 ? "fail" : "pass",
      detail: blocking > 0 ? String(blocking) + " high finding(s) open" : "no high finding is open",
    },
    {
      gate: "freshness",
      status: input.head === undefined ? "ask" : input.fresh ? "pass" : "fail",
      detail:
        input.head === undefined
          ? "no Change to compare with the base"
          : input.fresh
            ? "the base the Change names is still the base"
            : "the base moved: the Change was taken from an earlier commit",
    },
  ];
}

/** The human gate's reason, for the head and the approval that holds for it. */
function humanDetailOf(
  head: string | undefined,
  approval: Pick<TrailDecision, "action" | "head_commit"> | undefined,
): string {
  if (head === undefined) return "no Change to approve";
  if (approval !== undefined) return "approved at " + head;
  return "not approved at " + head;
}

/**
 * The line a reviewer reads first: whether a merge may go ahead, and what stops it (C3).
 *
 * @param gates - {@link trailGates}'s answer.
 * @returns `merge: ready` when every gate passes, and otherwise `merge: blocked — <each gate that
 * does not pass, with why>`.
 *
 * @remarks
 * This is the "one line" the issue asks for (C3): a person opening a Trail reads it before the
 * diff and decides whether anything needs doing. `ask` blocks like `fail` does: a gate nobody has
 * answered has not passed. The reasons are the gates' own `detail`, so the line and the gate list
 * cannot say different things.
 */
export function trailGateLine(gates: readonly TrailGateLine[]): string {
  const blocked = gates.filter((gate) => gate.status !== "pass");
  if (blocked.length === 0) return "merge: ready";
  return (
    "merge: blocked — " + blocked.map((gate) => gate.gate + " (" + gate.detail + ")").join("; ")
  );
}

/**
 * The findings a revise hands to the next Run as its input (C4).
 *
 * @param findings - The Trail's findings, in any order.
 * @param head - The commit under review now, or undefined.
 * @returns The open findings, `high` first, as the lines the next Run's prompt carries.
 *
 * @remarks
 * **Revise means the points go to the next Run as input** (D104 / run review sheet §4.4), so this
 * is the text that travels: one line per open finding, naming where it is when the record says.
 * Only `open` ones travel — a resolved or dismissed point is not a task. The order is severity
 * then place, so two Runs given the same record are given the same input.
 *
 * An empty list answers `""`: nothing is open, so a next Run has nothing to fix.
 */
export function trailReviseInput(
  findings: readonly Pick<TrailFinding, "severity" | "status" | "file" | "hunk" | "summary">[],
  head: string | undefined,
): string {
  const open = findings.filter((finding) => finding.status === "open");
  if (open.length === 0) return "";
  const ordered = [...open].sort((left, right) => {
    const severity =
      TRAIL_FINDING_SEVERITIES.indexOf(left.severity) -
      TRAIL_FINDING_SEVERITIES.indexOf(right.severity);
    if (severity !== 0) return severity;
    const leftAt = left.file ?? "";
    const rightAt = right.file ?? "";
    if (leftAt !== rightAt) return leftAt < rightAt ? -1 : 1;
    const leftHunk = left.hunk ?? "";
    const rightHunk = right.hunk ?? "";
    if (leftHunk === rightHunk) return 0;
    return leftHunk < rightHunk ? -1 : 1;
  });
  const heading =
    head === undefined
      ? "Review findings to address:"
      : "Review findings to address (head " + head + "):";
  return [
    heading,
    ...ordered.map((finding) => {
      const where =
        finding.file === null
          ? ""
          : finding.hunk === null
            ? finding.file + ": "
            : finding.file + " " + finding.hunk + ": ";
      return "- [" + finding.severity + "] " + where + finding.summary;
    }),
  ].join("\n");
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

// The table is not exported: it is an implementation detail a caller reaches through
// `canTrailTransition`, and a test-only export on the package's public surface would be shipped.
// The in-source test below runs it instead, so the table it pins is the one this module uses.
if (import.meta.vitest) {
  const { expect, test } = import.meta.vitest;
  // The expected table is written out, not read from the module: a test that compared the
  // implementation's own table with itself would agree with any edit to it.
  const EXPECTED: Readonly<Record<TrailState, readonly TrailState[]>> = {
    draft: ["active", "abandoned"],
    active: ["in_review", "abandoned"],
    in_review: ["active", "merged", "abandoned"],
    merged: ["observing"],
    observing: ["active", "closed"],
    closed: [],
    abandoned: [],
  };
  test("the Trail transition table is the one the model names, and it has a row per state", () => {
    expect(TRAIL_TRANSITIONS).toStrictEqual(EXPECTED);
    expect(Object.keys(TRAIL_TRANSITIONS).sort()).toStrictEqual([...TRAIL_STATES].sort());
  });
  // Catches: a move the diagram draws being refused, or one it does not draw being allowed.
  test("canTrailTransition answers the table, for every ordered pair of states", () => {
    for (const from of TRAIL_STATES) {
      for (const to of TRAIL_STATES) {
        const legal = EXPECTED[from].includes(to);
        expect(TRAIL_TRANSITIONS[from].includes(to), from + " -> " + to).toBe(legal);
        expect(canTrailTransition(from, to), from + " -> " + to).toBe(legal);
        // A state never transitions to itself: staying put is not a move the table records.
        if (from === to) expect(legal, from).toBe(false);
      }
    }
  });
  // Catches: the refusal the issue names — a merged Trail must not be abandoned.
  test("a merged Trail cannot be abandoned", () => {
    expect(canTrailTransition("merged", "abandoned")).toBe(false);
  });
}
