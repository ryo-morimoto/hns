/**
 * Who is asking, as the policy service names them.
 *
 * @remarks
 * The approval boundary is expressed in the **type**, not only in a check
 * (`docs/capability.md` §6, D091): an agent's tool token may propose, and only a human may decide.
 * {@link HumanPrincipal} is the one shape `decide` accepts, so a caller holding an agent
 * credential cannot even type a call to it. A value built outside the type system (a test cast, a
 * deserialized request) is still inspected at run time: {@link isHumanPrincipal} is the check the
 * service performs before it does anything, and a non-human actor is refused with
 * `policy_denied`.
 *
 * Phase 1 has no face that calls `decide` yet (0228 adds it); when it does, it builds the human
 * principal from the authenticated request and the agent path never has one.
 */

/** Credentials that may propose a policy revision but not approve one. */
export interface AgentPrincipal {
  readonly kind: "agent";
  /** The agent's stable id; recorded as the proposal's `requestedBy`. */
  readonly id: string;
}

/** A person, the only credential that may approve or reject a proposal. */
export interface HumanPrincipal {
  readonly kind: "human";
  /** The person's stable id; recorded as the revision's and the decision's author. */
  readonly id: string;
}

/** Anyone who acts on a policy. */
export type PolicyActor = AgentPrincipal | HumanPrincipal;

/**
 * Whether an actor is a human.
 *
 * @remarks
 * The service calls this on every decision, after the type said `HumanPrincipal`. The type is the
 * first fence and the run-time check is the second: a value that crossed a wire, a test, or an
 * `as` is not trusted to still be one.
 *
 * @param actor - The actor, whose `kind` is checked against the one value that may decide.
 */
export function isHumanPrincipal(actor: PolicyActor): actor is HumanPrincipal {
  return actor.kind === "human";
}
