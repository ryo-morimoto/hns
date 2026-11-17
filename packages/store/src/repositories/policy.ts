import type { IsoTimestamp } from "@hns/core";
import type {
  PolicyDocument,
  PolicyProposal,
  PolicyProposalStatus,
  PolicyRevision,
} from "@hns/core/capability";
import type { StoreContext } from "../db.ts";
import { parsePolicyActive, parsePolicyProposal, parsePolicyRevision } from "../parse.ts";

/**
 * The single row that says which revision a workspace's calls run under.
 *
 * @remarks
 * The document is not copied here: it is read from `policy_revisions` at `revision`, so the pointer
 * and the revision can never disagree about a document. `hash` is repeated from that revision so
 * a reader that only needs the identity (a comparison, a CAS precondition) reads one row.
 */
export interface PolicyActive {
  readonly workspaceId: string;
  readonly revision: number;
  readonly hash: string;
  readonly updatedAt: IsoTimestamp;
}

/**
 * A proposal as stored: the public {@link PolicyProposal} plus the row's `updated_at`.
 *
 * @remarks
 * `updatedAt` is the store's own bookkeeping and is not part of the contract, so it stays out of
 * the model. It is what a CAS on the proposal row updates.
 */
export interface StoredPolicyProposal extends PolicyProposal {
  readonly updatedAt: IsoTimestamp;
}

/** The document a new workspace's revision 1 records. */
export interface PolicySeed {
  readonly document: PolicyDocument;
  readonly hash: string;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: string;
}

/** One proposal to add. */
export interface PolicyProposalInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly baseRevision: number;
  readonly baseHash: string;
  readonly candidate: PolicyDocument;
  readonly candidateHash: string;
  readonly reviewToken: string;
  readonly requestedBy: string;
  readonly reason: string;
}

/** What a compare-and-swap on the active pointer asks for. */
export interface PolicyActivation {
  readonly workspaceId: string;
  /** The revision the decision was made against; the swap only happens while it is still active. */
  readonly baseRevision: number;
  /** The revision to activate; it must already be stored in `policy_revisions`. */
  readonly revision: number;
  readonly hash: string;
}

/** The outcome of a proposal status change. */
export type ProposalTransition = "updated" | "missing" | "not_pending";

/**
 * Policy revisions, the active pointer, and proposals.
 *
 * @remarks
 * The store is the durable half of the approval protocol (`docs/capability.md` §6, §9); it does not
 * decide anything. It does three things the server relies on:
 *
 * - **Revisions are append-only.** There is no method that updates or deletes a revision, and the
 *   table's primary key is `(workspace_id, revision)`.
 * - **The active pointer moves by compare-and-swap.** {@link PolicyRepository.activate} is
 *   `UPDATE policy_active ... WHERE workspace_id = ? AND revision = ?`, so a decision built on a
 *   revision that has since moved changes nothing and reports `false`.
 * - **The seed is created once.** {@link PolicyRepository.ensure} inserts revision 1 and the
 *   pointer in one D1 batch, each guarded by `ON CONFLICT DO NOTHING`; when both lose the race it
 *   reads what the winner wrote. Two concurrent first callers therefore leave one revision 1.
 *
 * A method that can miss returns `undefined` (or a closed result) rather than throwing. A write
 * that spans statements uses one D1 batch: that is the only transaction D1 offers, and D1 runs a
 * batch atomically.
 */
export interface PolicyRepository {
  /**
   * Make sure the workspace has an active revision, creating revision 1 when it has none.
   *
   * @param workspaceId - The workspace the policy belongs to.
   * @param seed - The document, hash, and author revision 1 records when this call creates it.
   * @returns The active revision, whether this call created it or a previous (or concurrent)
   * caller did.
   *
   * @remarks
   * `seed` is ignored when the workspace already has an active pointer: a later caller must not
   * rewrite the policy it found. The insert is `INSERT ... ON CONFLICT DO NOTHING` for both the
   * revision and the pointer, so the second caller of a race reads the first one's row.
   *
   * @throws Error when the pointer is missing after the batch, which no successful run leaves.
   */
  ensure(workspaceId: string, seed: PolicySeed): Promise<PolicyRevision>;
  /** The active pointer, or `undefined` when the workspace has no policy yet. */
  active(workspaceId: string): Promise<PolicyActive | undefined>;
  /** The revision at `revision`, or `undefined` when it does not exist. */
  revision(workspaceId: string, revision: number): Promise<PolicyRevision | undefined>;
  /** Every revision of the workspace, oldest first. */
  revisions(workspaceId: string): Promise<PolicyRevision[]>;
  /** Append a revision; `false` when that `(workspace, revision)` already exists. */
  append(revision: PolicyRevision): Promise<boolean>;
  /**
   * Move the active pointer to `activation.revision`, but only while `baseRevision` is active.
   *
   * @returns Whether the pointer moved. `false` means the base moved first: the caller reports
   * `approval_stale` and leaves the proposal alone.
   */
  activate(activation: PolicyActivation): Promise<boolean>;
  /** Record a pending proposal and return it as stored. */
  createProposal(input: PolicyProposalInput): Promise<StoredPolicyProposal>;
  /** The proposal with `id`, or `undefined` when it does not exist. */
  proposal(id: string): Promise<StoredPolicyProposal | undefined>;
  /** The workspace's proposals, newest first, or only `status` when given. */
  proposals(
    workspaceId: string,
    status?: PolicyProposalStatus | undefined,
  ): Promise<StoredPolicyProposal[]>;
  /**
   * Move a pending proposal to a decided status.
   *
   * @remarks
   * The update is `... WHERE id = ? AND status = 'pending'`, so a second decision changes nothing
   * and reports `not_pending` instead of overwriting the first one's author.
   */
  decideProposal(input: {
    readonly id: string;
    readonly status: Exclude<PolicyProposalStatus, "pending">;
    readonly decidedBy: string;
    readonly decidedAt: IsoTimestamp;
    readonly decisionReason: string;
  }): Promise<ProposalTransition>;
}

/**
 * Build the policy repository over `context`.
 *
 * @internal
 */
export function policyRepository(context: StoreContext): PolicyRepository {
  const { sql } = context;

  const active = async (workspaceId: string): Promise<PolicyActive | undefined> => {
    const row = await sql.get("SELECT * FROM policy_active WHERE workspace_id = ?", [workspaceId]);
    return row === undefined ? undefined : parsePolicyActive(row);
  };

  const revision = async (workspaceId: string, at: number): Promise<PolicyRevision | undefined> => {
    const row = await sql.get(
      "SELECT * FROM policy_revisions WHERE workspace_id = ? AND revision = ?",
      [workspaceId, at],
    );
    return row === undefined ? undefined : parsePolicyRevision(row);
  };

  const proposal = async (id: string): Promise<StoredPolicyProposal | undefined> => {
    const row = await sql.get("SELECT * FROM policy_proposals WHERE id = ?", [id]);
    return row === undefined ? undefined : parsePolicyProposal(row);
  };

  return {
    async ensure(workspaceId, seed) {
      const existing = await active(workspaceId);
      if (existing !== undefined) {
        const found = await revision(workspaceId, existing.revision);
        if (found === undefined) {
          throw new Error("the active policy revision is missing");
        }
        return found;
      }
      // One batch, both statements guarded: a concurrent first caller that commits between the
      // read above and this write leaves the conflict to `DO NOTHING`, and both callers read the
      // row the first one wrote.
      await sql.batch([
        {
          sql:
            "INSERT INTO policy_revisions " +
            "(workspace_id, revision, hash, document_json, created_at, created_by) " +
            "VALUES (?, 1, ?, ?, ?, ?) ON CONFLICT(workspace_id, revision) DO NOTHING",
          params: [
            workspaceId,
            seed.hash,
            JSON.stringify(seed.document),
            seed.createdAt,
            seed.createdBy,
          ],
        },
        {
          sql:
            "INSERT INTO policy_active (workspace_id, revision, hash, updated_at) " +
            "VALUES (?, 1, ?, ?) ON CONFLICT(workspace_id) DO NOTHING",
          params: [workspaceId, seed.hash, seed.createdAt],
        },
      ]);
      const created = await revision(workspaceId, 1);
      if (created === undefined) throw new Error("the policy revision was not created");
      return created;
    },
    active,
    revision,
    async revisions(workspaceId) {
      const rows = await sql.all(
        "SELECT * FROM policy_revisions WHERE workspace_id = ? ORDER BY revision",
        [workspaceId],
      );
      return rows.map((row) => parsePolicyRevision(row));
    },
    async append(next) {
      const inserted = await sql.run(
        "INSERT INTO policy_revisions " +
          "(workspace_id, revision, hash, document_json, created_at, created_by) " +
          "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, revision) DO NOTHING",
        [
          next.workspaceId,
          next.revision,
          next.hash,
          JSON.stringify(next.document),
          next.createdAt,
          next.createdBy,
        ],
      );
      return inserted > 0;
    },
    async activate({ workspaceId, baseRevision, revision: next, hash }) {
      const updated = await sql.run(
        "UPDATE policy_active SET revision = ?, hash = ?, updated_at = ? " +
          "WHERE workspace_id = ? AND revision = ?",
        [next, hash, context.now(), workspaceId, baseRevision],
      );
      return updated > 0;
    },
    async createProposal(input) {
      const at = context.now();
      const row = await sql.get(
        "INSERT INTO policy_proposals " +
          "(id, workspace_id, base_revision, base_hash, candidate_json, candidate_hash, " +
          "review_token, requested_by, reason, status, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING *",
        [
          input.id,
          input.workspaceId,
          input.baseRevision,
          input.baseHash,
          JSON.stringify(input.candidate),
          input.candidateHash,
          input.reviewToken,
          input.requestedBy,
          input.reason,
          at,
          at,
        ],
      );
      if (row === undefined) throw new Error("the policy proposal was not created");
      return parsePolicyProposal(row);
    },
    proposal,
    async proposals(workspaceId, status) {
      const rows =
        status === undefined
          ? await sql.all(
              "SELECT * FROM policy_proposals WHERE workspace_id = ? ORDER BY created_at DESC",
              [workspaceId],
            )
          : await sql.all(
              "SELECT * FROM policy_proposals WHERE workspace_id = ? AND status = ? " +
                "ORDER BY created_at DESC",
              [workspaceId, status],
            );
      return rows.map((row) => parsePolicyProposal(row));
    },
    async decideProposal(input) {
      const current = await proposal(input.id);
      if (current === undefined) return "missing";
      const row = await sql.get(
        "UPDATE policy_proposals SET status = ?, decided_by = ?, decided_at = ?, " +
          "decision_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending' RETURNING id",
        [
          input.status,
          input.decidedBy,
          input.decidedAt,
          input.decisionReason,
          context.now(),
          input.id,
        ],
      );
      return row === undefined ? "not_pending" : "updated";
    },
  };
}
