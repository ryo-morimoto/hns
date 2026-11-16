import type { IsoTimestamp } from "./codecs.ts";

/**
 * Why a workspace refuses a write under the lease contract.
 *
 * @remarks
 * Closed vocabulary: the Workspace DO returns one of these instead of a message, and the
 * machine treats every one as "do not write". `lease_not_held` means no lease covers the
 * machine, `lease_expired` means the lease's `expiresAt` has passed, and
 * `lease_epoch_stale` means the presented epoch is older than the workspace's current one
 * (the lease moved to another machine). Adding a member is a contract change. The lease
 * itself is implemented by 0156 and used by 0157.
 */
export const LEASE_REFUSALS = ["lease_not_held", "lease_expired", "lease_epoch_stale"] as const;

/** One reason a write is refused under the lease contract. */
export type LeaseRefusal = (typeof LEASE_REFUSALS)[number];

/**
 * The write lease one machine holds for one workspace.
 *
 * @remarks
 * The Workspace DO issues the lease (0156). While it is valid the machine keeps writing
 * locally with the existing version check (dirfd + hash, or `checks` when the helper cannot
 * run), so a write does not pay a round trip to the DO. The check is not bypassed: the lease
 * moves the version check to the machine, it does not remove it.
 *
 * `expiresAt` is enforced on both sides. The DO refuses a write whose lease is past it, and
 * the machine refuses to write without a live lease, because a machine that cannot reach the
 * DO cannot tell whether its lease is still current. Expiry fails closed; there is no mode in
 * which a stale lease may write.
 *
 * `epoch` is monotonic per workspace and increases whenever the lease is granted or taken
 * over. A write that carries an older epoch than the workspace's current one is refused, so a
 * machine that lost the lease cannot overwrite the new holder. Reads need no lease.
 *
 * One workspace has at most one valid lease. Requirement 2 (run agents on several machines)
 * does not mean two machines may edit one workspace at the same time.
 */
export interface WorkspaceLease {
  /** The workspace whose writes the lease covers. */
  readonly workspaceId: string;
  /** The machine that holds the lease. */
  readonly machineId: string;
  /** Monotonic per workspace; a write carrying an older epoch is stale. */
  readonly epoch: number;
  /** When the lease stops being valid; both sides fail closed past it. */
  readonly expiresAt: IsoTimestamp;
}
