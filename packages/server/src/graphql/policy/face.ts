import type {
  PolicyDiff,
  PolicyDocument,
  PolicyProposal,
  PolicyProposalStatus,
  PolicyRevision,
} from "@hns/core/capability";
import type { ProjectId } from "@hns/core";
import { diffPolicy } from "@hns/core/capability";
import type { Store } from "@hns/store";
import type { HumanPrincipal, PolicyActor } from "../../policy/principals.ts";
import { createPolicyService } from "../../policy/service.ts";

/**
 * The policy operations one GraphQL request performs.
 *
 * @remarks
 * One port for the whole policy face instead of one per field: the four fields are four views of
 * one service, and separate ports would let a test pair a propose with a decision from a
 * different service. A unit test replaces this port with a fake; production builds it over the
 * request's store, and the integration test builds the same service over a real D1.
 *
 * **Every operation answers with an outcome**, never with a bare value or a throw for a refusal,
 * so the resolver has one shape to read: the service's refusals are values, and only an outage or a
 * defect throws.
 */
export interface PolicyFace {
  /**
   * The workspace's active document, after ensuring the baseline exists.
   *
   * @remarks
   * A proposal is decoded against it: a root list the input leaves empty keeps the active roots,
   * so the face needs the document before it can build the candidate (and before it can check the
   * roots' meaning). It is the `ensure` read, so calling it is what gives a fresh workspace its
   * revision 1.
   */
  readonly activeDocument: (workspaceId: ProjectId) => Promise<PolicyOutcome<PolicyDocument>>;
  /** Every revision of the workspace, oldest first, and the active one's number. */
  readonly revisions: (workspaceId: ProjectId) => Promise<PolicyOutcome<PolicyRevisionsRead>>;
  /** The workspace's proposals, newest first, all of them or only \`status\`. */
  readonly proposals: (
    workspaceId: ProjectId,
    status?: PolicyProposalStatus | undefined,
  ) => Promise<PolicyOutcome<readonly PolicyProposalRead[]>>;
  /** Record a proposal built on the active revision; nothing active changes. */
  readonly propose: (
    actor: PolicyActor,
    input: ProposeRequest,
  ) => Promise<PolicyOutcome<PolicyProposalRead>>;
  /** Approve or reject a pending proposal. */
  readonly decide: (
    actor: HumanPrincipal,
    input: DecideRequest,
  ) => Promise<PolicyOutcome<DecideOutcome>>;
}

/** What a revisions read returns. */
export interface PolicyRevisionsRead {
  readonly active: number;
  readonly revisions: readonly PolicyRevision[];
}

/** A proposal with the diff a human reads before deciding. */
export interface PolicyProposalRead {
  readonly proposal: PolicyProposal;
  readonly diff: PolicyDiff;
}

/** What a proposal asks for. */
export interface ProposeRequest {
  readonly workspaceId: string;
  readonly candidate: PolicyDocument;
  readonly reason: string;
}

/** How a human decided a proposal. */
export interface DecideRequest {
  readonly proposalId: string;
  /**
   * The token the human read.
   *
   * @remarks
   * Carried so a decision names the view it was made on. The service does not compare it against
   * the input — it recomputes the token from the stored proposal's inputs — so a token the client
   * invents cannot pass. The input carries it because the contract's \`DecidePolicyInput\` does, and a
   * future credential fingerprint will bind the token to the reader.
   */
  readonly reviewToken: string;
  readonly decision: "approve" | "reject";
  readonly reason: string;
}

/** A decision's success: the new active revision when approved, the closed proposal when rejected. */
export type DecideOutcome =
  | {
      readonly kind: "approved";
      readonly revision: PolicyRevision;
      readonly proposal: PolicyProposal;
      readonly diff: PolicyDiff;
      /** The policy moved while the proposal row could not be stamped; the approval is still real. */
      readonly proposalStale: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly proposal: PolicyProposal;
      readonly diff: PolicyDiff;
    };

/** The service's refusal codes; the face adds \`not_found\` and \`invalid_request\` itself. */
export type PolicyRefusalCode = "policy_denied" | "approval_stale" | "unsupported";

/** An expected refusal, carried as a value so the resolver can map it to a union member. */
export interface PolicyRefusal {
  readonly ok: false;
  readonly code: PolicyRefusalCode;
  readonly message: string;
}

/** A success or one expected refusal. */
export type PolicyOutcome<T> = { readonly ok: true; readonly value: T } | PolicyRefusal;

/** What the face needs to build the production port. */
export interface PolicyFaceOptions {
  /** Whether the workspace has a sandbox, which is what turns the baseline's \`bash\` on. */
  readonly bashSandbox: boolean;
}

/** A success for the port to build. */
function ok<T>(value: T): PolicyOutcome<T> & { readonly ok: true } {
  return { ok: true, value };
}

/** A refusal for the port to build. */
function refused(code: PolicyRefusalCode, message: string): PolicyRefusal {
  return { ok: false, code, message };
}

/**
 * The diff a proposal would have made against its base.
 *
 * @internal
 * @param base - The revision the proposal names, or undefined when it is unreadable.
 * @param proposal - The proposal to compare.
 * @returns The diff, or \`unsupported\` when the base is gone or the algebra cannot compare the pair.
 *
 * @remarks
 * The base is the revision the proposal **names** (\`baseRevision\`), not the workspace's active one:
 * after an approval the active revision is the candidate itself, and a diff against it would be
 * \`equal\`, hiding what the approved proposal changed. A proposal whose base is gone is still
 * listed with an \`unsupported\` diff: a list is a read, and one unreadable proposal must not hide
 * the others.
 */
function diffAgainst(base: PolicyRevision | undefined, proposal: PolicyProposal): PolicyDiff {
  if (base === undefined) return { kind: "unsupported", added: [], removed: [] };
  return diffPolicy(base.document, proposal.candidate);
}

/**
 * The policy face over the request's store.
 *
 * @param store - The control database, already opened for this request.
 * @param options - The workspace's sandbox fact.
 * @returns The port. An outage or a defect throws; the service's refusals are values.
 *
 * @remarks
 * The service owns every decision: the principal check, the review token, the compare-and-
 * swap, and \`unsupported\`. This port converts its results into the one outcome shape and adds the
 * read the list needs (each proposal's diff against the revision it names).
 */
export function policyFaceOver(store: Store, options: PolicyFaceOptions): PolicyFace {
  const service = createPolicyService({
    policy: store.policy,
    bashSandbox: options.bashSandbox,
  });
  return {
    async activeDocument(workspaceId) {
      return ok((await service.ensure(workspaceId)).document);
    },
    async revisions(workspaceId) {
      await service.ensure(workspaceId);
      const [active, revisions] = await Promise.all([
        store.policy.active(workspaceId),
        store.policy.revisions(workspaceId),
      ]);
      if (active === undefined) throw new Error("the ensured policy has no active revision");
      return ok({ active: active.revision, revisions });
    },
    async proposals(workspaceId, status) {
      const proposals = await store.policy.proposals(workspaceId, status);
      const read = await Promise.all(
        proposals.map(async (proposal) => {
          const base = await store.policy.revision(workspaceId, proposal.baseRevision);
          return { proposal, diff: diffAgainst(base, proposal) };
        }),
      );
      return ok(read);
    },
    async propose(actor, input) {
      const result = await service.propose(actor, {
        workspaceId: input.workspaceId,
        candidate: input.candidate,
        reason: input.reason,
      });
      return result.ok
        ? ok({ proposal: result.proposal, diff: result.diff })
        : refused(result.code, result.message);
    },
    async decide(actor, input) {
      const result = await service.decide(actor, {
        proposalId: input.proposalId,
        decision: input.decision,
        reason: input.reason,
      });
      if (!result.ok) return refused(result.code, result.message);
      if ("revision" in result) {
        return ok({
          kind: "approved",
          revision: result.revision,
          proposal: result.proposal,
          diff: result.diff,
          proposalStale: result.proposalStale === true,
        });
      }
      return ok({ kind: "rejected", proposal: result.proposal, diff: result.diff });
    },
  };
}
