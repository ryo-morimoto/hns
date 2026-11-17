import { DENIAL_RETRY } from "./types.ts";
import type { DenialCode, DenialRetry, DenyDecision, PolicyDecision } from "./types.ts";

/**
 * The denial vocabulary and how a caller may act on it.
 *
 * @remarks
 * `DENIAL_CODES` is a closed union: a consumer `switch`es over it and ends with `never`, so a new
 * code cannot be added without every consumer deciding what it means. `DENIAL_RETRY` is the other
 * half of that: it is typed as `Record<DenialCode, DenialRetry>` (via `satisfies`), so a code without
 * a retry entry does not compile.
 */

/**
 * Whether a call refused with `code` may be sent again.
 *
 * @param code - A denial code.
 * @returns `retry` when the same call may succeed once the named state moved; `propose` when only a
 * policy change would allow it; `never` when repeating the call cannot help.
 */
export function retryOf(code: DenialCode): DenialRetry {
  return DENIAL_RETRY[code];
}

/** The policy revision a denial was decided against, when the caller knows it. */
export interface DenialPolicy {
  readonly revision: number;
  readonly hash: string;
}

/**
 * Build the value a denied call returns.
 *
 * @remarks
 * A denial is a value, not an exception: the model is told `{ok: false, code, message, retry}` and
 * the run continues. `policy` adds the revision and hash the refusal was decided against.
 *
 * @param code - One of `DENIAL_CODES`.
 * @param message - What a model can read; it must not carry a secret or raw arguments.
 * @param policy - The revision the refusal was decided against, when one is known.
 * @returns The `deny` decision.
 */
export function deny(code: DenialCode, message: string, policy?: DenialPolicy): DenyDecision {
  return policy === undefined
    ? { outcome: "deny", code, message }
    : { outcome: "deny", code, message, policyRevision: policy.revision, policyHash: policy.hash };
}

/**
 * The code of a decision.
 *
 * @param decision - Any decision.
 * @returns The denial code, or `null` when the decision allows the call.
 */
export function denialOf(decision: PolicyDecision): DenialCode | null {
  return decision.outcome === "deny" ? decision.code : null;
}
