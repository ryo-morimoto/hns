/** How far a work record has progressed, from an artifact to accumulated learning. */
export const DONE_LEVELS = [
  "generated",
  "intended",
  "verified",
  "integrated",
  "observed",
  "learned",
] as const;

/** One level of the done ladder. */
export type DoneLevel = (typeof DONE_LEVELS)[number];

/** The closed criterion vocabulary: how a criterion is verified. */
export const CRITERION_KINDS = ["test", "eval", "demo", "manual"] as const;

/** One verification kind. */
export type CriterionKind = (typeof CRITERION_KINDS)[number];

/** The closed criterion state vocabulary. */
export const CRITERION_STATUSES = ["unchecked", "passed", "failed", "waived"] as const;

/** One criterion state. */
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

/** The closed outcome source vocabulary. */
export const OUTCOME_SOURCES = ["deploy", "infra", "analytics", "support", "billing"] as const;

/** One external source of an observed outcome. */
export type OutcomeSource = (typeof OUTCOME_SOURCES)[number];

/** One acceptance criterion of a work record. */
export interface Criterion {
  /** Stable id within the record, such as C1. */
  readonly id: string;
  /** How the criterion is verified. */
  readonly kind: CriterionKind;
  /** Current state. */
  readonly status: CriterionStatus;
  /** Where the evidence lives. Required when passed. */
  readonly evidence?: string | undefined;
  /** Why the criterion is waived, or what failed. Required when waived. */
  readonly note?: string | undefined;
}

/** Who accepted the work, when, and on what basis. */
export interface Decision {
  /** Who accepted it. */
  readonly by: string;
  /** ISO 8601 (validated by core). */
  readonly at: string;
  /** What was checked, in one sentence. */
  readonly basis: string;
}

/** Where the change became live: a commit, a deploy, or a demo. */
export interface Integration {
  /** Commit, deploy id, or demo url. */
  readonly ref: string;
  /** ISO 8601 (validated by core). */
  readonly at: string;
}

/** One observed outcome from outside hns. */
export interface Outcome {
  /** Which external system observed it. */
  readonly source: OutcomeSource;
  /** Reference inside that system; not the raw data. */
  readonly ref: string;
  /** ISO 8601 (validated by core). */
  readonly observed_at: string;
  /** What changed, in one sentence. */
  readonly note?: string | undefined;
  /** 0..1 when the source reports one. */
  readonly confidence?: number | undefined;
}

/** Where the learning was written: a rule, a test, an eval, or a decision. */
export interface Learning {
  /** Reference to the rule, test, eval, or decision. */
  readonly ref: string;
  /** ISO 8601 (validated by core). */
  readonly at: string;
}

/**
 * One work record for one issue.
 *
 * @remarks
 * The record is the source of truth for completion. The done level is derived from it and
 * never stored as input.
 */
export interface WorkRecord {
  /** Schema version. A new shape needs a new version, not a silent change. */
  readonly schema: 1;
  /** Four digit issue number. */
  readonly issue: string;
  /** Who needs what, and why now. */
  readonly intent: string;
  /** Acceptance criteria. At least one is required. */
  readonly criteria: readonly Criterion[];
  /** What the evidence does not prove. At least one is required. */
  readonly limits: readonly string[];
  /** Who accepted the record. */
  readonly decision: Decision;
  /** What makes this record stale. At least one is required. */
  readonly invalidation: readonly string[];
  /** Present once the change is live. */
  readonly integration?: Integration | undefined;
  /** Present once an external outcome is observed. */
  readonly outcome?: Outcome | undefined;
  /** Present once the learning is written back. */
  readonly learning?: Learning | undefined;
}
