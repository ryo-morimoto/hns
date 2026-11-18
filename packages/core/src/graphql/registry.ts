// The model types that the SDL may reference. Adding an entity to the schema means
// adding it here, so an object field cannot point at a type that is not registered.
import type { Machine, MachineStatus } from "../machine-types.ts";
import type {
  Trail,
  TrailChange,
  TrailChangeState,
  TrailDecision,
  TrailDecisionAction,
  TrailFinding,
  TrailFindingSeverity,
  TrailFindingSource,
  TrailFindingStatus,
  TrailGate,
  TrailGateKind,
  TrailGateStatus,
  TrailKind,
  TrailPriority,
  TrailSession,
  TrailState,
} from "../trail.ts";
import type {
  REVIEW_MIRROR_STATES,
  ReviewMirrorFallback,
  ReviewMirrorSide,
  ReviewReadSource,
} from "../review.ts";
import type { Conversation, Project, ProjectEgress } from "../types.ts";

/**
 * Model types the SDL may reference, keyed by GraphQL object name.
 *
 * @internal
 *
 * @remarks
 * `spec.ts` compares an object field's model type against these values at compile time. Adding
 * an entity to `entities.ts` without adding it here makes object fields that name it fail to
 * compile, so the registry and the SDL cannot drift.
 */
export interface EntityRegistry {
  readonly Project: Project;
  readonly Conversation: Conversation;
  /** The machine registry's row (0148): no ROOT, and no secret. */
  readonly Machine: Machine;
  /** The intent and its state (D104): what a Task used to be, plus what hangs off it. */
  readonly Trail: Trail;
  /** The `base..head` pair a Trail moved the code to. */
  readonly TrailChange: TrailChange;
  /** A link from a Trail to a conversation, a session, or a run. */
  readonly TrailSession: TrailSession;
  /** A point raised by a review, a test, or a person; a gate reads these. */
  readonly TrailFinding: TrailFinding;
  /** An approval, a change request, or a rejection, appended and never edited. */
  readonly TrailDecision: TrailDecision;
  /** What a gate said about a Trail or a Change at a moment. */
  readonly TrailGate: TrailGate;
  /** One commit of a Change and the store its bytes were read from (0248). */
  readonly ReviewMirror: ReviewMirrorFallback;
}

/**
 * Enum unions the SDL may reference, keyed by GraphQL enum name.
 *
 * @internal
 *
 * @remarks
 * A model string maps to an enum only when its union is registered here; otherwise it maps to
 * `String` or `ID`. Every Trail vocabulary is closed in `@hns/core` (`TRAIL_*`), so every one
 * of them is an enum rather than a free string: a stored value this build does not know is a
 * corrupt row, not a new state.
 */
export interface EnumRegistry {
  readonly ProjectEgress: ProjectEgress;
  /** `online` / `offline` / `revoked`; `revoked` is terminal. */
  readonly MachineStatus: MachineStatus;
  /** `draft` / `active` / `in_review` / `merged` / `observing` / `closed` / `abandoned`. */
  readonly TrailState: TrailState;
  readonly TrailKind: TrailKind;
  readonly TrailPriority: TrailPriority;
  /** A Change's own state; it names the code it moved to. */
  readonly TrailChangeState: TrailChangeState;
  readonly TrailFindingSeverity: TrailFindingSeverity;
  readonly TrailFindingSource: TrailFindingSource;
  readonly TrailFindingStatus: TrailFindingStatus;
  readonly TrailDecisionAction: TrailDecisionAction;
  readonly TrailGateKind: TrailGateKind;
  readonly TrailGateStatus: TrailGateStatus;
  /** Which store a review diff was read from (0248): `artifacts`, `r2`, or `machine`. */
  readonly ReviewReadSource: ReviewReadSource;
  /** The stored Artifacts mirror state of one commit (0248). */
  readonly ReviewMirrorStatus: (typeof REVIEW_MIRROR_STATES)[number];
  /** Which commit of a Change a mirror state is about (0248). */
  readonly ReviewMirrorSide: ReviewMirrorSide;
}
