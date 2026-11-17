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

/**
 * What an approval asks the store to do: store the candidate as the next revision and point at it,
 * but only while the base revision is still the active one.
 *
 * @remarks
 * The two writes are one operation because they must not come apart: a revision appended without
 * the pointer moving is an orphan the next approval's `baseRevision + 1` would then collide with,
 * and the workspace would answer `approval_stale` forever ("fail stuck", not "fail closed").
 */
export interface PolicyActivation {
  readonly workspaceId: string;
  /** The revision the decision was made against; the write only happens while it is still active. */
  readonly baseRevision: number;
  /** The hash of the base revision; part of the compare-and-swap, so a moved base of the same number cannot pass. */
  readonly baseHash: string;
  /** The revision to store; the caller computed `baseRevision + 1`. */
  readonly revision: number;
  readonly hash: string;
  readonly document: PolicyDocument;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: string;
}

/** The outcome of a proposal status change. */
export type ProposalTransition = "updated" | "missing" | "not_pending";

/**
 * The outcome of an approval's write.
 *
 * @remarks
 * `activated` is the only value that moved the pointer. `stale` and `exists` both mean **nothing was
 * written**: the base moved, or its successor number was already taken. A caller reports
 * `approval_stale` for either, and never has to clean up a revision that is not active.
 */
export type PolicyActivationResult = "activated" | "stale" | "exists";

/**
 * Policy revisions, the active pointer, and proposals.
 *
 * @remarks
 * The store is the durable half of the approval protocol (`docs/capability.md` §6, §9); it does not
 * decide anything. It does three things the server relies on:
 *
 * - **Revisions are append-only.** There is no method that updates or deletes a revision, and the
 *   table's primary key is `(workspace_id, revision)`.
 * - **The active pointer moves by compare-and-swap, with its revision.** {@link PolicyRepository.activate}
 *   is one batch in which the revision's insert is conditional on the same
 *   `UPDATE policy_active ... WHERE workspace_id = ? AND revision = ? AND hash = ?` predicate, so a
 *   decision built on a revision that has since moved writes **nothing** and reports `stale`.
 * - **The seed is created once.** {@link PolicyRepository.ensure} inserts revision 1 and the
 *   pointer in one D1 batch, each guarded by `ON CONFLICT DO NOTHING`; when both lose the race it
 *   reads what the winner wrote. Two concurrent first callers therefore leave one revision 1.
 *
 * A method that can miss returns `undefined` (or a closed result) rather than throwing. A write
 * that spans statements uses one D1 batch, but **a batch is not enough on its own**: D1 runs a batch
 * as a transaction yet does not roll it back when a statement changes no rows, so every statement
 * that must come apart is made conditional on the same predicate rather than relying on the batch.
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
  /**
   * Store `activation.revision` and move the active pointer to it, atomically and only while the
   * base revision is still active.
   *
   * @remarks
   * One D1 batch of two statements, both guarded by the same precondition (the pointer is at
   * `baseRevision` with `baseHash`):
   *
   * 1. `INSERT ... SELECT ... WHERE EXISTS (the pointer is at the base)` — the revision is written
   *    only while the swap can still happen.
   * 2. `UPDATE policy_active ... WHERE workspace_id = ? AND revision = ? AND hash = ?`.
   *
   * D1 runs a batch as a transaction but does **not** roll it back for a statement that changes no
   * rows, so a bare "append, then swap" would leave the revision behind when the base moved. The
   * guard on the insert is what makes the pair all-or-nothing: a stale approval writes neither row.
   *
   * @param activation - The base the decision was made on and the revision to activate.
   * @returns `activated` when the pointer moved; `stale` when the base moved first and nothing was
   * written; `exists` when that revision number was already stored (a concurrent approval of the
   * same base got there first), and nothing was written.
   */
  activate(activation: PolicyActivation): Promise<PolicyActivationResult>;
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
    async activate(activation) {
      const { workspaceId, baseRevision, baseHash, revision: next, hash } = activation;
      if (await revision(workspaceId, next)) return "exists";
      const guarded = "WHERE workspace_id = ? AND revision = ? AND hash = ?";
      const results = await sql.batch([
        {
          // The insert is conditional on the same predicate as the swap, so the pair cannot come
          // apart: if the base moved, this writes nothing and neither does the UPDATE.
          sql:
            "INSERT INTO policy_revisions " +
            "(workspace_id, revision, hash, document_json, created_at, created_by) " +
            "SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS " +
            "(SELECT 1 FROM policy_active " +
            guarded +
            ")",
          params: [
            workspaceId,
            next,
            hash,
            JSON.stringify(activation.document),
            activation.createdAt,
            activation.createdBy,
            workspaceId,
            baseRevision,
            baseHash,
          ],
        },
        {
          sql:
            "UPDATE policy_active SET revision = ?, hash = ?, updated_at = ? " +
            guarded +
            " RETURNING revision",
          params: [next, hash, context.now(), workspaceId, baseRevision, baseHash],
        },
      ]);
      // The swap is the second statement; a 0-row UPDATE returns no row, which is `stale`.
      const swapped = results[1]?.[0];
      return swapped === undefined ? "stale" : "activated";
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
