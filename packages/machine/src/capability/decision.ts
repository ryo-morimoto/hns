import { denialOf, retryOf } from "@hns/core/capability";
import type { PolicyDecision, SignedGrant, ToolCall, ToolManifest } from "@hns/core/capability";
import type { GrantCounter } from "./counter.ts";
import type { GrantKeys } from "./keys.ts";
import { verifyGrant } from "./verify.ts";

/**
 * The machine's one decision about one tool call: verify the grant, then spend its budget (0225,
 * `docs/capability.md` §5, §7).
 *
 * @remarks
 * A caller has one question — "may I run this call, as this machine, under this grant?" — and the
 * answer has two parts that must not drift apart: the grant must **verify** (signature, expiry,
 * epoch, manifest, scope, the active policy), and the grant must still have **budget** (calls and
 * bytes). {@link authorizeGrantedCall} runs both in that order and answers one `PolicyDecision`:
 *
 * - a verification that refuses never spends, so a forged or escaped call does not eat the budget
 *   of the grant it was offered for;
 * - a spend that refuses is the answer, so `counter_exhausted` reaches the caller exactly as
 *   `grant_expired` does — the model is told why, and the run is not dropped;
 * - an allowed call is spent **before** the tool runs, so a crash or a hung command cannot let the
 *   same grant pay for two calls.
 *
 * This is the seam 0226 wires to the RPC: it parses `authorization` and `call` from the request,
 * resolves the manifest and the operation, and calls this. Nothing here reads the request, the
 * network, or a log — a denial is a value, and the caller's audit row names the decision.
 */

/** What one granted call is given. */
export interface AuthorizeGrantedCallInput {
  /** The grant, as it arrived (unparsed). */
  readonly grant: unknown;
  /** The call the machine is about to run. */
  readonly call: ToolCall;
  /** The tool's manifest, as this machine serves it. */
  readonly manifest: ToolManifest;
  /** The machine's enrolled control-plane keys. */
  readonly keys: GrantKeys;
  /** The counter the grant's budget is spent from. */
  readonly counter: GrantCounter;
  /** This machine's id. */
  readonly machineId: string;
  /** The machine's clock. */
  readonly now: Date;
  /** The active policy revision and hash, as the control channel told this request (0226). */
  readonly activePolicy: { readonly revision: number; readonly hash: string } | undefined;
  /** The bytes this call may return, counted against the grant's `maxBytes`. */
  readonly bytes: number;
  /** The newest epoch this machine has accepted. */
  readonly lastEpoch?: number | undefined;
  /** The grant ids this machine knows are revoked. */
  readonly revokedGrants?: ReadonlySet<string> | undefined;
}

/** What one granted call decided. */
export interface AuthorizeGrantedCallResult {
  readonly decision: PolicyDecision;
  /** The grant that was decided on, when it verified; a denial may still name it. */
  readonly grant?: SignedGrant | undefined;
}

/**
 * Decide whether one call may run, and spend it.
 *
 * @param input - The grant, call, manifest, keys, counter, machine, clock, policy, and byte count.
 * @returns The allow (with the grant id and the policy revision) or the first refusal.
 *
 * @remarks
 * The order is verify then spend. Two refusals never happen in the other order: a call outside the
 * scope is `scope_exceeded` even when the grant has no calls left, because the scope is a fact
 * about the grant and the budget is a fact about its past.
 */
export async function authorizeGrantedCall(
  input: AuthorizeGrantedCallInput,
): Promise<AuthorizeGrantedCallResult> {
  const verified = await verifyGrant({
    grant: input.grant,
    call: input.call,
    manifest: input.manifest,
    keys: input.keys,
    machineId: input.machineId,
    now: input.now,
    activePolicy: input.activePolicy,
    lastEpoch: input.lastEpoch,
    revokedGrants: input.revokedGrants,
  });
  const grant = verified.grant;
  if (verified.decision.outcome === "deny" || grant === undefined) {
    return { decision: verified.decision, grant };
  }
  const spent = await input.counter.consume({
    grantId: grant.payload.grantId,
    maxCalls: grant.payload.maxCalls,
    maxBytes: grant.payload.maxBytes,
    bytes: input.bytes,
    now: input.now.getTime(),
  });
  if (spent.outcome === "deny") return { decision: spent.decision, grant };
  return { decision: verified.decision, grant };
}

/**
 * Whether a decision may be sent again, for a caller that wants to tell "ask for a fresh grant"
 * from "this will never work" without switching on every code.
 *
 * @param decision - Any decision.
 * @returns `true` when the same call may succeed once the state it names has moved
 * (`grant_expired`, `epoch_stale`, `approval_stale`), `false` for an allow and for every code
 * repeating cannot fix.
 */
export function mayRetry(decision: PolicyDecision): boolean {
  const code = denialOf(decision);
  return code !== null && retryOf(code) === "retry";
}
