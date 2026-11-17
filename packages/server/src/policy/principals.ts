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
 * Phase 1 builds the actor from the authenticated session ({@link principalOf}). The session cookie
 * is a **person's** cookie until a login face replaces it, so the default is
 * {@link HumanPrincipal}; an agent's subject namespace is the one value refused, and that refusal
 * is the second fence the GraphQL face checks before it calls `decide`.
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
 * The subject namespace an agent's credential uses.
 *
 * @remarks
 * The edge mints one session for a person (the `hns_session` cookie); an agent's request is not a
 * session yet, so no agent subject exists in production. The namespace is declared here anyway so
 * the rule is one constant: a subject under it is **never** read as a human, and `decide` refuses
 * it. A session does not yet carry a `kind`, so this prefix is the only marker, and it is a
 * denial, not an identity.
 */
export const AGENT_SUBJECT_PREFIX = "agent:";

/**
 * The principal a verified session's subject acts as.
 *
 * @remarks
 * The session names a subject and nothing else; the face has already verified the cookie, so the
 * subject is either a person or a subject in the agent namespace. Only the second is an agent;
 * everything else is a human because the sole issuer of `hns_session` is the person's login. A login
 * face replaces that issuer. This is a **default**, not an identity proof: an agent that presents a
 * person's cookie is indistinguishable here, and a `Session.kind` is where that closes.
 *
 * @param subject - The verified session's subject.
 * @returns The agent principal for an agent namespace, a human principal otherwise.
 */
export function principalOf(subject: string): PolicyActor {
  if (subject.startsWith(AGENT_SUBJECT_PREFIX)) {
    return { kind: "agent", id: subject.slice(AGENT_SUBJECT_PREFIX.length) };
  }
  return { kind: "human", id: subject };
}

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
