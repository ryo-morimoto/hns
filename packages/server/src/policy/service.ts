import type { PolicyRepository } from "@hns/store";
import { isoTimestamp, type IsoTimestamp } from "@hns/core";
import type {
  PolicyDiff,
  PolicyDocument,
  PolicyProposal,
  PolicyRevision,
} from "@hns/core/capability";
import { diffPolicy, reviewToken } from "@hns/core/capability";
import { isHumanPrincipal, type HumanPrincipal, type PolicyActor } from "./principals.ts";
import { baselineDocument, documentHash } from "./revisions.ts";

/**
 * Why a policy operation was refused.
 *
 * @remarks
 * The failure is a **closed union of values**, not an exception: the expected refusals are
 * `approval_stale` (the active policy moved, the review token no longer matches, or the proposal is
 * no longer pending), `policy_denied` (the actor may not do this), and `unsupported` (a document or
 * a diff this contract cannot decide). A database failure is none of these and throws, because a
 * 500 is a defect, not an answer to a user (`docs/capability.md` §7).
 */
/** The closed set of expected refusals. */
export type PolicyFailureCode = "approval_stale" | "policy_denied" | "unsupported";

/** One expected refusal. */
interface PolicyFailure {
  readonly ok: false;
  readonly code: PolicyFailureCode;
  readonly message: string;
}

/** A success carrying `T`, or one expected refusal. */
type PolicyResult<T> = ({ readonly ok: true } & T) | PolicyFailure;

/** What a proposal is made of, as the proposer supplies it. */
interface ProposeInput {
  readonly workspaceId: string;
  /** The document the proposer wants to become active. */
  readonly candidate: PolicyDocument;
  /** Why; shown to the human who decides. */
  readonly reason: string;
}

/** How a human decided a proposal. */
interface DecideInput {
  readonly proposalId: string;
  /** `approve` activates the candidate at `revision + 1`; `reject` only closes the proposal. */
  readonly decision: "approve" | "reject";
  /** Why; recorded with the decision. */
  readonly reason: string;
}

/** A workspace's active revision. */
interface PolicyState {
  readonly active: PolicyRevision;
}

/** A proposal with the diff a human reads before deciding. */
interface PolicyProposalView {
  readonly proposal: PolicyProposal;
  readonly diff: PolicyDiff;
}

/**
 * An approved decision: the new active revision and the diff that was approved.
 *
 * @remarks
 * `proposalStale` says the **policy moved but the proposal record did not close**: the swap
 * succeeded and the candidate is active, while another decision had already decided this proposal
 * row in between, so this call could not also stamp it. The approval is real and must not be
 * retried (a retry is `approval_stale` against the moved pointer, which would tell the caller the
 * policy did not move when it did). An auditor reads the decision from the revision's row.
 */
interface PolicyApproval {
  readonly revision: PolicyRevision;
  readonly proposal: PolicyProposal;
  readonly diff: PolicyDiff;
  readonly proposalStale?: true;
}

/** A rejected decision: the closed proposal and the diff the human refused. */
interface PolicyRejection {
  readonly proposal: PolicyProposal;
  readonly diff: PolicyDiff;
}

/**
 * The version that computes the review token.
 *
 * @remarks
 * A token binds the proposal id, the base hash, the candidate hash, and the reader's credential
 * fingerprint. Phase 1 passes `""` as the fingerprint — the contract leaves the reader out until a
 * credential has a stable fingerprint — and the fingerprint is part of the hashed input like any
 * other value. **Turning it on changes every token this build computes**: a proposal stored by an
 * older build will not match the token a newer one recomputes, so it is `approval_stale` and must
 * be proposed again. The token is never compared while ignoring a field.
 */
const CREDENTIAL_FINGERPRINT = "";

/** The injection points; production leaves the optional ones out. */
export interface PolicyServiceOptions {
  /** The control database's policy rows (migration 7). */
  readonly policy: PolicyRepository;
  /** Whether the workspace has a sandbox, which decides revision 1's `bash`. Defaults to false. */
  readonly bashSandbox?: boolean | undefined;
  /** The clock for row timestamps; defaults to `new Date()`. */
  readonly now?: (() => IsoTimestamp) | undefined;
  /** The id source for proposals; defaults to `crypto.randomUUID`. */
  readonly newId?: (() => string) | undefined;
}

/** What the server's faces call. */
export interface PolicyService {
  /**
   * Make sure the workspace has an active policy and return it.
   *
   * @param workspaceId - The workspace.
   * @returns The active revision: revision 1 the first time, unchanged afterwards.
   *
   * @remarks
   * Idempotent: a second call returns the same revision, and concurrent first calls leave one
   * revision 1 (the store inserts it with `ON CONFLICT DO NOTHING`). Revision 1 is
   * {@link baselineDocument}: `read_file` / `write_file` over the workspace root, `bash` only with
   * a sandbox (`network: "none"`, not writable), and no egress.
   *
   * @throws Error when the store cannot read or write; there is no partial answer.
   */
  ensure(workspaceId: string): Promise<PolicyRevision>;
  /** The active revision, ensuring the baseline exists first. */
  current(workspaceId: string): Promise<PolicyState>;
  /**
   * Record a proposal built on the active revision.
   *
   * @param actor - Who proposes. An agent may, and so may a human.
   * @param input - The workspace, the candidate document, and the reason.
   * @returns The pending proposal and the diff a human will read.
   *
   * @remarks
   * The proposal is bound to the revision it was built on (`baseRevision` / `baseHash`) and to the
   * exact candidate (`candidateHash`), and carries the `reviewToken` a decision must reproduce.
   * Proposing changes nothing active.
   *
   * A candidate the atom algebra cannot compare (a glob root, a scope it does not know) is
   * **refused here with `unsupported`** instead of being stored as a proposal no approval could
   * ever accept; an `equal` candidate is refused too, because approving it would move the revision
   * without changing the policy. Approval still refuses `unsupported` on its own, because the
   * algebra is the authority at both times.
   *
   * @throws Error when the store cannot read or write.
   */
  propose(actor: PolicyActor, input: ProposeInput): Promise<PolicyResult<PolicyProposalView>>;
  /**
   * Approve or reject a proposal.
   *
   * @param actor - Who decides. Only a {@link HumanPrincipal} may: an agent's actor is refused
   * with `policy_denied` at run time as well as by the type.
   * @param input - The proposal and the decision.
   * @returns The new active revision when approved, or the decided proposal when rejected.
   *
   * @remarks
   * Approval re-reads the active revision and requires it to be still `baseRevision` with
   * `baseHash`, recomputes the review token from the **same inputs** and requires the stored one,
   * and re-runs the diff, refusing `unsupported`. Then it appends the candidate as revision
   * `baseRevision + 1` and moves the pointer with a compare-and-swap on `baseRevision`; a pointer
   * that moved in between makes the swap change nothing and the answer `approval_stale`. The
   * proposal is marked `approved` only after the swap, and only while it is still `pending`.
   *
   * Rejection needs the same currency checks: it is a decision on a policy view, and a view that
   * moved is not the one the human saw.
   *
   * @throws Error when the store cannot read or write.
   */
  decide(
    actor: HumanPrincipal,
    input: DecideInput,
  ): Promise<PolicyResult<PolicyApproval | PolicyRejection>>;
}

/**
 * Refuse with a typed failure.
 *
 * @internal
 */
function failure(code: PolicyFailureCode, message: string): PolicyFailure {
  return { ok: false, code, message };
}

/**
 * Build the policy service.
 *
 * @param options - The store's policy repository, the workspace's sandbox fact, and the hooks.
 * @returns The service.
 */
export function createPolicyService(options: PolicyServiceOptions): PolicyService {
  const { policy } = options;
  const now = options.now ?? ((): IsoTimestamp => isoTimestampOf(new Date()));
  const newId = options.newId ?? ((): string => crypto.randomUUID());
  const baseline = baselineDocument({ bashSandbox: options.bashSandbox ?? false });

  const tokenOf = (proposal: Pick<PolicyProposal, "id" | "baseHash" | "candidateHash">) =>
    reviewToken({
      proposalId: proposal.id,
      baseHash: proposal.baseHash,
      candidateHash: proposal.candidateHash,
      credentialFingerprint: CREDENTIAL_FINGERPRINT,
    });

  const ensure = async (workspaceId: string): Promise<PolicyRevision> => {
    const hash = await documentHash(baseline);
    if (hash === undefined) throw new Error("the baseline policy has no canonical form");
    return policy.ensure(workspaceId, {
      document: baseline,
      hash,
      createdAt: now(),
      createdBy: "system",
    });
  };

  /** The decided proposal, or `undefined` when another decision got there first. */
  const close = async (
    id: string,
    actor: HumanPrincipal,
    reason: string,
    status: "approved" | "rejected",
  ): Promise<PolicyProposal | undefined> => {
    const at = now();
    const outcome = await policy.decideProposal({
      id,
      status,
      decidedBy: actor.id,
      decidedAt: at,
      decisionReason: reason,
    });
    if (outcome !== "updated") return undefined;
    const decided = await policy.proposal(id);
    if (decided === undefined) throw new Error("the decided proposal is missing");
    return decided;
  };

  return {
    ensure,
    async current(workspaceId) {
      return { active: await ensure(workspaceId) };
    },
    async propose(actor, input) {
      const active = await ensure(input.workspaceId);
      const candidateHash = await documentHash(input.candidate);
      if (candidateHash === undefined) {
        return failure("unsupported", "the candidate policy has no canonical form");
      }
      const diff = diffPolicy(active.document, input.candidate);
      if (diff.kind === "unsupported") {
        return failure("unsupported", "the policy difference cannot be computed");
      }
      if (diff.kind === "equal") {
        return failure("unsupported", "the candidate policy equals the active one");
      }
      const id = newId();
      const proposal = await policy.createProposal({
        id,
        workspaceId: input.workspaceId,
        baseRevision: active.revision,
        baseHash: active.hash,
        candidate: input.candidate,
        candidateHash,
        reviewToken: await tokenOf({
          id,
          baseHash: active.hash,
          candidateHash,
        }),
        requestedBy: actor.id,
        reason: input.reason,
      });
      return { ok: true, proposal, diff };
    },
    async decide(actor, input) {
      // The type is the first fence; a value that crossed a wire is checked again here.
      if (!isHumanPrincipal(actor)) {
        return failure("policy_denied", "only a human may decide a policy proposal");
      }
      const proposal = await policy.proposal(input.proposalId);
      if (proposal === undefined) {
        return failure("policy_denied", "the proposal does not exist");
      }
      if (proposal.status !== "pending") {
        return failure("approval_stale", "the proposal is already decided");
      }
      const active = await policy.active(proposal.workspaceId);
      if (active === undefined) {
        return failure("approval_stale", "the workspace has no active policy");
      }
      if (active.revision !== proposal.baseRevision || active.hash !== proposal.baseHash) {
        return failure("approval_stale", "the active policy moved since the proposal");
      }
      if ((await tokenOf(proposal)) !== proposal.reviewToken) {
        return failure("approval_stale", "the review token does not match");
      }
      const base = await policy.revision(proposal.workspaceId, active.revision);
      if (base === undefined) {
        return failure("approval_stale", "the active revision is missing");
      }
      const diff = diffPolicy(base.document, proposal.candidate);
      if (diff.kind === "unsupported") {
        return failure("unsupported", "the policy difference cannot be computed");
      }
      if (input.decision === "reject") {
        const decided = await close(proposal.id, actor, input.reason, "rejected");
        return decided === undefined
          ? failure("approval_stale", "the proposal is already decided")
          : { ok: true, proposal: decided, diff };
      }
      // One atomic write: the revision and the pointer move together, or neither moves.
      const activation = await policy.activate({
        workspaceId: proposal.workspaceId,
        baseRevision: proposal.baseRevision,
        baseHash: proposal.baseHash,
        revision: proposal.baseRevision + 1,
        hash: proposal.candidateHash,
        document: proposal.candidate,
        createdAt: now(),
        createdBy: actor.id,
      });
      if (activation !== "activated") {
        return failure("approval_stale", "the active policy moved during the swap");
      }
      // The policy already moved. A failure to stamp the proposal row must not be reported as a
      // refused approval: the caller would retry, and the retry would answer `approval_stale`
      // against the revision this call just activated.
      const decided = await close(proposal.id, actor, input.reason, "approved");
      const stored = decided ?? (await policy.proposal(proposal.id));
      if (stored === undefined) throw new Error("the decided proposal is missing");
      const revision = await policy.revision(proposal.workspaceId, proposal.baseRevision + 1);
      if (revision === undefined) throw new Error("the activated revision is missing");
      return decided === undefined
        ? { ok: true, revision, proposal: stored, diff, proposalStale: true }
        : { ok: true, revision, proposal: decided, diff };
    },
  };
}

/**
 * The contract's ISO timestamp spelling of an instant.
 *
 * @internal
 * @param at - The instant.
 * @throws ValiError never; `Date#toISOString` always yields this spelling.
 */
function isoTimestampOf(at: Date): IsoTimestamp {
  return isoTimestamp(at.toISOString());
}
