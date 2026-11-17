import { fitsArtifacts, type MirrorState } from "@hns/core";

/**
 * The mirror's decisions: whether a run can go to Artifacts, what its ref is called, and where
 * a reader gets the review when it cannot.
 *
 * @remarks
 * The push itself is a git process and lives in `./mirror-push` (a subpath export, because it
 * spawns `git` and the Worker bundle has no `node:child_process`). This module is pure, so the
 * Workspace object (in the Worker) and the machine read the same rules without one importing the
 * other's runtime.
 *
 * Artifacts is a **mirror** of the authoritative checkpoint in R2 (D106). Nothing here decides
 * whether a checkpoint exists: a run that cannot be mirrored is still checkpointed, and its
 * review is read from the machine.
 */

/**
 * Where one checkpoint's review is read from.
 *
 * @remarks
 * `artifacts` means the commit is in the workspace's Artifacts repository, so the review is read
 * from there and does not need the machine. `machine` is the fallback: the run was skipped (over
 * Artifacts' limits), the mirror failed, or nothing has pushed yet.
 */
export const REVIEW_SOURCES = ["artifacts", "machine"] as const;

/** One place a checkpoint's review is read from. */
export type ReviewSource = (typeof REVIEW_SOURCES)[number];

/**
 * The review source a mirror state implies.
 *
 * @param mirror - The stored mirror state.
 * @returns `artifacts` for a mirrored run, `machine` for every other state.
 *
 * @remarks
 * Only `mirrored` is terminal proof that the commit is in Artifacts. `pending` and `failed` are
 * not: a review read from Artifacts for them would be read from a ref that may not exist.
 */
export const reviewSourceFor = (mirror: MirrorState): ReviewSource =>
  mirror.status === "mirrored" ? "artifacts" : "machine";

/**
 * Whether one checkpoint is within the limits an Artifacts push shares.
 *
 * @param packBytes - The pack's size.
 * @param maxBlobBytes - The largest blob in the pack.
 * @returns True when the push may be attempted.
 *
 * @remarks
 * Re-exported from the checkpoint contract so the Worker (which decides `skipped`) and the
 * machine (which decides before a push) compare one pair of numbers (32 MiB file, 64 MiB push).
 */
export const fitsMirrorLimits = (packBytes: number, maxBlobBytes: number): boolean =>
  fitsArtifacts(packBytes, maxBlobBytes);

/** The ref prefix every mirrored Run sits under. */
const MIRROR_REF_PREFIX = "refs/heads/hns/run/";

/** A Run id is one ref component: no slash, no traversal, no lock suffix. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * The ref one Run's checkpoint is pushed under.
 *
 * @param runId - The Run id.
 * @returns `refs/heads/hns/run/<runId>`.
 * @throws RangeError when the Run id is not one ref component.
 *
 * @remarks
 * **Under `refs/heads/` on purpose.** Artifacts' binding resolves branches and tags only, so a
 * checkpoint under a private namespace (the `refs/hns/checkpoints/` the R2 path uses) could be
 * pushed but never read back, and a fork would not carry it. The `hns/run/` prefix keeps it out
 * of the way of a user's own branches. `/run/` is singular for the same reason: the checkpoint
 * ref of the same Run is under a private namespace and cannot collide.
 */
export function mirrorRef(runId: string): string {
  if (
    !RUN_ID.test(runId) ||
    runId.includes("..") ||
    runId.endsWith(".") ||
    runId.endsWith(".lock")
  ) {
    throw new RangeError("invalid run id: " + JSON.stringify(runId));
  }
  return MIRROR_REF_PREFIX + runId;
}
