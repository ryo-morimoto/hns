import { expect, test } from "vitest";
import { MAX_CHECKPOINT_PACK_BYTES, fitsCheckpointPack } from "@hns/core";
import {
  CHECKPOINT_FAILURES,
  CheckpointError,
  checkpointRun,
  type CheckpointOptions,
} from "@hns/workspace/checkpoint";

/**
 * The pack checks the machine's checkpoint path makes before it sends anything.
 *
 * @remarks
 * The 64 MiB bound is the checkpoint contract's (0243): the machine measures the pack, the upload
 * route refuses one over it, and the mirror records a run that cannot be mirrored as `skipped`.
 * The machine itself does not import the transport module (that is the Worker's half, 0245), so
 * it decides with the contract's own comparison; this test fixes that the two agree at the
 * boundary and that the checkpoint result carries what the decision needs.
 */

// Catches: a boundary that is exclusive, or a preflight measured with a different number than the
// route that receives the pack.
test("a pack exactly at 64 MiB is sent and one byte more is not", () => {
  expect(MAX_CHECKPOINT_PACK_BYTES).toBe(64 * 1024 * 1024);
  expect(fitsCheckpointPack(MAX_CHECKPOINT_PACK_BYTES)).toBe(true);
  expect(fitsCheckpointPack(MAX_CHECKPOINT_PACK_BYTES - 1)).toBe(true);
  expect(fitsCheckpointPack(MAX_CHECKPOINT_PACK_BYTES + 1)).toBe(false);
  expect(fitsCheckpointPack(0)).toBe(true);
});

// Catches: the checkpoint failing on its own rather than for the caller when a run id is unusable.
// The caller can branch on the code, and the ref has not moved.
test("an unusable run id is refused before git runs", async () => {
  const options: CheckpointOptions = { root: "/nonexistent", runId: "../escape" };
  const failure = await checkpointRun(options).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(CheckpointError);
  if (failure instanceof CheckpointError) {
    expect(failure.code).toBe("invalid-run-id");
    expect(CHECKPOINT_FAILURES).toContain(failure.code);
  }
});
