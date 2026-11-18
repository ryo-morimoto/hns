/**
 * The review face's rules for what a screen decides on the wire (0232).
 *
 * @remarks
 * The gates, the approval, and the revise input are the **server's** answers (`Trail.gates`,
 * `Trail.decisions`, `decideTrail.nextRunInput`). What lives here is what a screen decides without
 * asking the server again: which findings a reader sees first (blocking only by default), and the
 * sentence beside the decision buttons ("approved at <head>"), both from the same rule the server
 * applies (`core`'s `trailApprovalHolds`) so the screen and the gate cannot disagree.
 */
import { trailApprovalHolds } from "@hns/core";

/** The GraphQL finding severity names, plus the forward-compatibility marker Relay adds. */
type FindingSeverityName = "HIGH" | "MEDIUM" | "LOW" | "NONE" | "%future added value";

/** The GraphQL finding status names, plus the marker. */
type FindingStatusName = "OPEN" | "RESOLVED" | "DISMISSED" | "%future added value";

/** The GraphQL decision action names, plus the marker. */
type DecisionActionName = "APPROVE" | "REQUEST_CHANGES" | "REJECT" | "%future added value";

/** The GraphQL gate kind names, plus the marker. */
type GateKindName = "HUMAN_REVIEW" | "TESTS" | "FINDINGS" | "FRESHNESS" | "%future added value";

/** One finding as the review screen reads it. */
export interface ReviewFinding {
  readonly id: string;
  readonly severity: FindingSeverityName;
  readonly source: string;
  readonly status: FindingStatusName;
  readonly file: string | null;
  readonly hunk: string | null;
  readonly summary: string;
}

/** One decision as the review screen reads it (newest first, as the server sends them). */
export interface ReviewDecision {
  readonly id: string;
  readonly action: DecisionActionName;
  readonly actor: string;
  readonly headCommit: string | null;
  readonly note: string;
  readonly at: string;
}

/** The words a gate goes by. */
export const GATE_LABELS: Readonly<Record<GateKindName, string>> = {
  HUMAN_REVIEW: "human",
  TESTS: "tests",
  FINDINGS: "findings",
  FRESHNESS: "freshness",
  "%future added value": "gate",
};

/** The words a severity goes by. */
export const SEVERITY_LABELS: Readonly<Record<FindingSeverityName, string>> = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  NONE: "note",
  "%future added value": "finding",
};

/**
 * Whether a finding is shown by default: only the ones that block a merge (C3).
 *
 * @param finding - The finding as the screen reads it.
 * @returns `true` for an open `high` finding.
 *
 * @remarks
 * The default list is what stops a merge, not everything raised: a reviewer reads the points that
 * hold the merge first, and the rest are one toggle away. `high` is the blocking severity the gate
 * uses (C3); the server sends every finding, and the screen chooses what to show.
 */
function isBlocking(finding: ReviewFinding): boolean {
  return finding.status === "OPEN" && finding.severity === "HIGH";
}

/**
 * The findings a reader sees: blocking ones, with the rest behind a toggle.
 *
 * @param findings - The Trail's findings, newest first.
 * @param showAll - Whether the reader asked for the rest.
 * @returns The findings to render, keeping the server's order.
 */
export function visibleFindings(
  findings: readonly ReviewFinding[],
  showAll: boolean,
): readonly ReviewFinding[] {
  return showAll ? findings : findings.filter((finding) => isBlocking(finding));
}

/**
 * The latest approval that still holds for `head`, or undefined (C2).
 *
 * @param decisions - The Trail's decisions, newest first.
 * @param head - The commit on screen.
 * @returns The decision, when it is an approval of exactly this head.
 *
 * @remarks
 * `core`'s `trailApprovalHolds` applied to the wire's names: an approval is about one commit, so
 * a head that moved leaves no approval in force and the screen says so. The **status** is the
 * server's `gates`; this is the sentence beside the buttons, from the same rule.
 */
export function currentApproval(
  decisions: readonly ReviewDecision[],
  head: string | undefined,
): ReviewDecision | undefined {
  return decisions.find((decision) => {
    if (decision.action !== "APPROVE") return false;
    return trailApprovalHolds({ action: "approve", head_commit: decision.headCommit }, head);
  });
}
