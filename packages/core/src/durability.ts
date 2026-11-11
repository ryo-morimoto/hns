/**
 * The failure classes the durability contract distinguishes.
 *
 * @remarks
 * The names are contract vocabulary: docs/durability.md, the failure table, and downstream
 * fault-injection tests use them. Adding a member is a contract change. Do not rename one to
 * make it stand for a different failure.
 *
 * `process-crash` is the machine's process dying while the machine stays up; `power-loss` is
 * the machine losing power; `machine-loss` is the machine being gone; `account-incident` is
 * the Cloudflare account being stopped, deleted, or compromised.
 */
export const FAILURE_CLASSES = [
  "process-crash",
  "power-loss",
  "machine-loss",
  "account-incident",
] as const;

/** One failure class the contract distinguishes. */
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * Who holds the only authoritative copy of durable state.
 *
 * @remarks
 * D1 is a rebuildable index; the machine's working tree and the browser's unsaved edits are
 * never authoritative. `(C, J)` is split between Workspace DO (the Journal and its watermark)
 * and R2 (the checkpoint commit and its objects). Session DO owns the run and conversation that
 * produced the checkpoint; it is not part of `(C, J)`.
 */
export const DURABILITY_AUTHORITIES = ["session-do", "workspace-do", "r2"] as const;

/** One authority that may hold the authoritative copy of durable state. */
export type DurabilityAuthority = (typeof DURABILITY_AUTHORITIES)[number];

/**
 * The `C` in `(C, J)`: the last checkpoint commit.
 *
 * @remarks
 * `commit` is a git object id; the objects live in R2. `runId` names
 * `refs/hns/checkpoints/<runId>`. The working tree is a projection and is not part of the
 * checkpoint.
 */
export interface CheckpointRef {
  /** The workspace the checkpoint belongs to. */
  readonly workspaceId: string;
  /** The run whose end produced the checkpoint. */
  readonly runId: string;
  /** The git commit id (hex) the checkpoint advanced to; the objects are in R2. */
  readonly commit: string;
}

/**
 * The durable unit `(C, J)`.
 *
 * @remarks
 * `throughSeq` is the highest Journal sequence already folded into `checkpoint`; J is every
 * settled entry above it. Restore expands the checkpoint and replays those entries in ascending
 * sequence. `throughSeq` is non-negative and never decreases for a workspace. Bodies up to 256KB
 * live in Workspace DO; larger bodies live in R2 with only the hash in the DO.
 */
export interface DurableUnit {
  /** The checkpoint the Journal is replayed on top of. */
  readonly checkpoint: CheckpointRef;
  /** Highest Journal sequence included in the checkpoint; J is every settled entry above it. */
  readonly throughSeq: number;
}
