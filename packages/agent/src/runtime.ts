import { deny } from "@hns/core/capability";
import type {
  PolicyDecision,
  SignedGrant,
  ToolCall,
  ToolId,
  ToolManifest,
} from "@hns/core/capability";
import type { GrantedAnswer } from "@hns/workspace/protocol";

/**
 * The agent's granted call: one tool call, decided by the machine that runs it (0226,
 * `docs/capability.md` §3, §5, §10).
 *
 * @remarks
 * The agent does not evaluate policy and does not decide a call. It asks for a grant for a
 * **(session × tool × manifest × machine)** and hands the machine the call, the grant, and the
 * active policy; the machine verifies and spends, and answers a `PolicyDecision`. This module holds
 * both halves of the agent's side and nothing else:
 *
 * - {@link GrantSource}: the caller's port to the issuer — the Session Durable Object, which signs a
 *   grant from the policy snapshot the Worker sent with the turn (0224). The agent never sees a
 *   signing key and cannot widen a grant: it names the tool, the version, the manifest hash, and the
 *   machine, and the object answers what the policy allows or refuses.
 * - {@link ToolTransport}: the caller's port to the machine side — the Session object's relay, which
 *   carries the call to the machine over the control-plane signature and records the decision before
 *   it answers. The agent cannot reach a machine directly: its credential is the run token the
 *   Session minted for this run, and the object checks it.
 * - {@link grantSource}: the cache. One grant per tool × manifest × machine lives until just before
 *   its expiry, so a turn of tool calls costs one issuance per tool rather than one per call; a
 *   grant the machine refused as `grant_expired` / `epoch_stale` is dropped and asked for once more.
 *
 * **The grant is not the budget.** The machine spends `maxCalls` / `maxBytes` from its own counter
 * (`~/.config/hns/grants`, which the agent's shell cannot read); the agent's count of the calls it
 * sent is observation, never an authority. A cached grant that the machine has exhausted is refused
 * as `counter_exhausted`, and the agent asks for a fresh one on the next call.
 */

/** What a tool's manifest is, as the agent names it to the issuer and the machine. */
export interface ToolContract {
  readonly manifest: ToolManifest;
  readonly manifestHash: string;
}

/**
 * What one grant is asked for: everything the agent is allowed to say, and nothing it can widen.
 *
 * @remarks
 * The machine id is the one the Session object relays to; the agent learns it from the Session, not
 * from the model. `maxBytes` is the tool contract's model-facing bound, so the grant covers the
 * output the tool can return.
 */
export interface GrantRequest {
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly manifestHash: string;
  readonly maxBytes?: number | undefined;
}

/**
 * What the issuer answered: a signed grant, or the decision that refused it.
 *
 * @remarks
 * A refusal is a value (`policy_denied`, `tool_disabled`, ...) the model may read as the call's
 * failure; a transport failure is not a decision and is raised as {@link GrantUnavailableError},
 * because a call that could not ask for a grant must not run as if it had.
 */
export type GrantAnswer =
  | { readonly ok: true; readonly grant: SignedGrant }
  | { readonly ok: false; readonly decision: PolicyDecision };

/**
 * The agent's port to the Session object's issuer.
 *
 * @remarks
 * Production is the Session object's own issuer through the run's transport (the object issues,
 * records, and signs). A test can supply any implementation, which is how the cache's behaviour is
 * proved without a Durable Object.
 */
export interface GrantSource {
  /**
   * Ask for one grant.
   *
   * @param request - The tool, its version and manifest hash, and the output bound.
   * @returns The signed grant, or the refusal.
   * @throws {GrantUnavailableError} When the issuer could not be reached or answered nonsense: a
   * call whose grant could not be asked for does not run (fail closed).
   */
  issue(request: GrantRequest): Promise<GrantAnswer>;
}

/** One run's granted path: where a grant is asked for, and where the call is relayed. */
export interface RuntimeGrantPath {
  readonly source: GrantSource;
  readonly transport: ToolTransport;
}

/** The issuer could not be asked, so no grant exists. */
export class GrantUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantUnavailableError";
  }
}

/** What one granted call is handed to the machine as. */
export interface GrantedCallInput {
  /** The call the machine runs. */
  readonly call: ToolCall;
  /** The tool's contract, as the agent built it. */
  readonly contract: ToolContract;
  /** The bytes this call may count against the grant's `maxBytes`. */
  readonly bytes: number;
  /** The grant the issuer signed. */
  readonly grant: SignedGrant;
}

/**
 * The agent's port to the machine, through the Session object's relay.
 *
 * @remarks
 * The transport is bound to one run: the object checks the run token it minted for this run, so a
 * call cannot be relayed as another run's, and the grants issued for this run end when the run does
 * (the object revokes them, and refuses a relayed call with `grant_revoked`). The agent never
 * carries a control-plane key and never reaches a machine's URL.
 */
export interface ToolTransport {
  /**
   * Relay one granted call to the machine and return its decision.
   *
   * @param input - The call, its contract, the grant, and the bytes.
   * @returns The machine's answer: an allow with the operation's result, or the denial.
   * @throws {ToolTransportError} When the relay could not be reached, the run's token was refused,
   * or the machine's answer was not one: nothing ran, or nothing that can be reported ran.
   */
  call(input: GrantedCallInput): Promise<GrantedAnswer>;
  /**
   * End this run: no further call relays, and the grants this run holds are revoked by the issuer.
   *
   * @remarks
   * Called when the run's conversation is closed or aborted, and by the Session when the object
   * closes. A call already in flight settles on its own; a call that starts after this is refused
   * locally (and the issuer would refuse it too).
   */
  closeRun(): Promise<void>;
}

/** The relay could not be reached or answered something that is not a decision. */
export class ToolTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolTransportError";
  }
}

/** What a grant cache hands back: its source, and the way to forget every grant it holds. */
export interface CachedGrants {
  readonly source: GrantSource;
  /** Drop every cached grant, as a run's end does. */
  readonly clear: () => void;
}

/** How long before a grant's expiry the cache stops using it, in milliseconds. */
const CACHE_MARGIN_MS = 5_000;

/** One cached grant and when the cache stops handing it out. */
interface CachedGrant {
  readonly grant: SignedGrant;
  /** Epoch milliseconds after which the grant is not reused (its expiry, less the margin). */
  readonly usableUntil: number;
}

/** What a {@link grantCache} is given. */
export interface GrantCacheOptions {
  /** The issuer. */
  readonly source: GrantSource;
  /** The clock; `Date.now` in production, a fixed one in a test. */
  readonly now?: (() => number) | undefined;
  /** The milliseconds before expiry a grant is no longer reused; defaults to {@link CACHE_MARGIN_MS}. */
  readonly marginMs?: number | undefined;
}

/**
 * The agent's grant cache: ask once per tool and manifest, and again only when the old one is spent.
 *
 * @remarks
 * The cache holds one grant per tool × manifest × machine and hands it out until {@link CACHE_MARGIN_MS}
 * before its expiry; the machine is the authority on the remaining calls, so a cached grant that
 * the machine has exhausted is refused there and re-asked here. Two calls that miss at the same
 * moment share one issuance (the in-flight promise), so a turn's first tool calls do not each ask.
 *
 * A refusal is **not** cached: `tool_disabled` or a manifest mismatch is the policy's answer for
 * this call, and caching it would keep refusing a call the policy later allows.
 */
export function grantCache(options: GrantCacheOptions): CachedGrants {
  const now = options.now ?? Date.now;
  const margin = options.marginMs ?? CACHE_MARGIN_MS;
  const cached = new Map<string, CachedGrant>();
  const inFlight = new Map<string, Promise<GrantAnswer>>();
  const request = async (asked: GrantRequest): Promise<GrantAnswer> => {
    // The cache is keyed by the contract, and the request names the same contract: a caller that
    // asked for another tool would be another key.
    const key = asked.toolId + "\u0000" + asked.toolVersion + "\u0000" + asked.manifestHash;
    const known = cached.get(key);
    if (known !== undefined && now() < known.usableUntil) return { ok: true, grant: known.grant };
    const pending = inFlight.get(key);
    if (pending !== undefined) return await pending;
    const issuing = (async (): Promise<GrantAnswer> => {
      const answer = await options.source.issue(asked);
      if (answer.ok) {
        const expiry = Date.parse(answer.grant.payload.expiresAt);
        if (!Number.isFinite(expiry)) {
          throw new GrantUnavailableError("the issued grant has no readable expiry");
        }
        cached.set(key, { grant: answer.grant, usableUntil: expiry - margin });
      }
      return answer;
    })();
    inFlight.set(key, issuing);
    try {
      return await issuing;
    } finally {
      inFlight.delete(key);
    }
  };
  return {
    source: {
      async issue(asked) {
        try {
          return await request(asked);
        } catch (error) {
          if (error instanceof GrantUnavailableError) throw error;
          // The issuer is the Session object: an outage is "no grant", never "no policy".
          throw new GrantUnavailableError(
            "the issuer could not be asked: " +
              (error instanceof Error ? error.name : "unknown error"),
          );
        }
      },
    },
    clear() {
      cached.clear();
    },
  };
}

/**
 * The contract a tool call was made against, as the cache and the issuer name it.
 *
 * @param contract - The tool's manifest and hash.
 * @returns The tool id, version, manifest hash, and the manifest's model-facing byte bound.
 */
export function grantRequestFor(contract: ToolContract): GrantRequest {
  return {
    toolId: contract.manifest.toolId,
    toolVersion: contract.manifest.version,
    manifestHash: contract.manifestHash,
    // The tool's own output ceiling. The issuer clamps this to the manifest's limit, so the grant's
    // byte bound is the manifest's: a turn's total model-facing output. A call that returns more
    // than what is left of it is refused `counter_exhausted`, which is the budget working.
    maxBytes: contract.manifest.outputLimits.maxBytes,
  };
}

/**
 * One run's granted path, from the two ports the Session object answers.
 *
 * @param input - Where a grant is asked for and where calls are relayed.
 * @returns The granted path the tools take, with its grants cached for the run's lifetime.
 *
 * @remarks
 * The cache is per run (one runtime per run), so a grant issued for one run is never handed to
 * another: the Session object binds each grant to its run and revokes it when the run ends.
 */
export function sessionGrantPath(input: {
  readonly source: GrantSource;
  readonly transport: ToolTransport;
  readonly now?: (() => number) | undefined;
}): RuntimeGrantPath {
  const cache = grantCache(
    input.now === undefined ? { source: input.source } : { source: input.source, now: input.now },
  );
  return { source: cache.source, transport: input.transport };
}

/** The decision for a call whose grant could not be obtained: no grant, so nothing runs. */
export function grantUnavailableDecision(error: GrantUnavailableError): PolicyDecision {
  return deny("grant_invalid", "no grant could be obtained for this call: " + error.message);
}

/** The decision for a call whose relay failed: no decision came back, so nothing is reported as run. */
export function relayUnavailableDecision(error: ToolTransportError): PolicyDecision {
  return deny("grant_invalid", "the call could not be relayed to its machine: " + error.message);
}
