import * as v from "valibot";
import { SignedGrantSchema, authorizeCall, digestCall, denialOf } from "@hns/core/capability";
import type {
  DenialCode,
  PolicyDecision,
  SignedGrant,
  ToolCall,
  ToolManifest,
} from "@hns/core/capability";
import type { GrantKeys } from "./keys.ts";

/**
 * Whether one call may run under one grant, decided by the machine that would run it (0225,
 * `docs/capability.md` §5, §7, D091).
 *
 * @remarks
 * This is the machine's side of the fast path: the Worker issues one grant per session × tool ×
 * manifest × machine, and the machine decides every call **locally**, so the 28 ms of a round trip
 * to the Session object per tool call becomes a signature check and a file read. The proof is the
 * contract's, not a second one: {@link verifyGrant} hands the grant, the call, its manifest, the
 * key, the clock, the newest epoch, and the revocation set to `@hns/core/capability`'s
 * `authorizeCall`, which is the one implementation of "signature → alg → expiry → epoch → manifest
 * → scope → exact". The machine adds only what a machine has: the key it enrolled (0205), the
 * counter it keeps, the epoch it has seen, and the policy revision its control channel told it.
 *
 * **The order the checks happen in** is `authorizeCall`'s (each step refuses without looking at the
 * next, so a refusal names the earliest reason), with two machine-side checks around it:
 *
 * 1. **the machine it is for** — `payload.machineId` must be this machine (`grant_invalid`). A
 *    grant is addressed to one machine; another machine's grant is not a weaker capability, it is
 *    not this machine's to run at all.
 * 2. `authorizeCall`'s checks, unchanged.
 * 3. **the policy the machine was told is active** — `payload.epoch` / `payload.policyHash` must be
 *    the revision and hash of the `activePolicy` this request carried (`epoch_stale` otherwise).
 *    That check is `authorizeCall`'s too (it is the caller's `activePolicy`), because the machine
 *    must not trust a snapshot it once stored: a policy revision that moves retires every grant
 *    issued under the old revision, which is what makes "改訂前の grant は TTL まで有効" true and
 *    bounded.
 *
 * Where the `activePolicy` comes from is the **control channel**: 0226 carries the active revision
 * and hash on every request that presents a grant, exactly as it carries the call. Until 0226 wires
 * it, the machine has nothing to compare against, and `verifyGrant` refuses with `policy_denied`
 * (fail closed) rather than guess — an allow without a revision is an allow the audit cannot name.
 *
 * **What an unreadable key means.** A machine with no key for a grant's `keyId` refuses
 * (`grant_invalid`); it does not fall back to a pinned key, and the grant never carries its own key.
 *
 * The result is a `PolicyDecision`: a value, never an exception. A grant is attacker-controlled
 * input, so a shape the contract does not know, a signature that does not verify, and a key this
 * machine cannot use are all denials.
 */

/** What one verification is given. */
export interface VerifyGrantInput {
  /** The grant, as it arrived; unparsed, because a grant is untrusted input too. */
  readonly grant: unknown;
  /** The call the machine is about to run, built from the operation it received. */
  readonly call: ToolCall;
  /** The manifest of that tool, as this machine serves it. */
  readonly manifest: ToolManifest;
  /** The control-plane keys this machine enrolled with (0225's `keys.ts`, 0147 / 0148). */
  readonly keys: GrantKeys;
  /** This machine's id, as its Machine record names it; a grant for another machine is refused. */
  readonly machineId: string;
  /** The machine's clock. */
  readonly now: Date;
  /** The active policy revision and hash, as the control channel told this request (0226). */
  readonly activePolicy: { readonly revision: number; readonly hash: string } | undefined;
  /** The newest epoch this machine has accepted, if it has recorded one. */
  readonly lastEpoch?: number | undefined;
  /** The grant ids this machine knows are revoked; `undefined` means it knows nothing. */
  readonly revokedGrants?: ReadonlySet<string> | undefined;
}

/** What one verification decided, and the grant's bounds when the grant itself parsed. */
export interface VerifyGrantResult {
  readonly decision: PolicyDecision;
  /**
   * The parsed grant when the decision allows it.
   *
   * @remarks
   * The counter needs the grant's `maxCalls` / `maxBytes` and id, and taking them from the parsed
   * value (not from the raw input) is what keeps a second parse and a second shape from disagreeing.
   */
  readonly grant?: SignedGrant | undefined;
}

/** The `grant_invalid` answer for a grant this machine will not even look up a key for. */
function invalid(message: string): VerifyGrantResult {
  return { decision: { outcome: "deny", code: "grant_invalid", message } };
}

/**
 * Decide whether one call may run under one grant, on this machine.
 *
 * @param input - The grant, the call, its manifest, the enrolled keys, this machine's id, the
 * clock, the policy the control channel names, and the machine's epoch and revocation state.
 * @returns The decision, and the parsed grant when it is an allow. Nothing is thrown for bad input:
 * a forged or malformed grant is `grant_invalid`, another machine's is `grant_invalid`, an expired
 * one is `grant_expired`, one issued under another revision is `epoch_stale`, and a call outside
 * the grant's scope is the scope's own code (`path_outside_root`, `command_not_allowed`,
 * `egress_denied`, `scope_exceeded`).
 *
 * @remarks
 * The verification **spends nothing**: `maxCalls` / `maxBytes` are the counter's
 * ({@link ./counter.ts}'s `consume`), and a caller runs the tool only after both allow. Keeping the
 * two apart is what makes this function pure — the same inputs decide the same way — and what lets a
 * caller retry a decision it did not act on.
 */
export async function verifyGrant(input: VerifyGrantInput): Promise<VerifyGrantResult> {
  const parsed = v.safeParse(SignedGrantSchema, input.grant);
  if (!parsed.success) return invalid("the grant is not a signed grant");
  const grant = parsed.output;
  if (grant.payload.machineId !== input.machineId) {
    return invalid("the grant is for another machine");
  }
  if (input.activePolicy === undefined) {
    // A machine that was told no revision has nothing to record an allow against (fail closed).
    return {
      decision: {
        outcome: "deny",
        code: "policy_denied",
        message: "no active policy revision was presented with the call",
      },
    };
  }
  const lookup = await input.keys.publicKey(grant.payload.keyId, grant.payload.alg);
  if (!lookup.ok) {
    return { decision: { outcome: "deny", code: lookup.code, message: lookup.message } };
  }
  const digest = await digestCall(input.call);
  const decision = await authorizeCall({
    grant,
    call: input.call,
    manifest: input.manifest,
    key: lookup.key,
    now: input.now,
    callHash: digest.callHash,
    activePolicy: input.activePolicy,
    lastEpoch: input.lastEpoch,
    revokedGrants: input.revokedGrants,
  });
  if (decision.outcome === "deny") return { decision };
  return { decision, grant };
}

/**
 * The denial code of a verification, or `null` when it allowed the call.
 *
 * @param result - What {@link verifyGrant} decided.
 * @returns The code (one of `DENIAL_CODES`), or `null`.
 */
export function verifyDenialOf(result: VerifyGrantResult): DenialCode | null {
  return denialOf(result.decision);
}
