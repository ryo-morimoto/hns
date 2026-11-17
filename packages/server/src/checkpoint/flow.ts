import {
  CheckpointRecordSchema,
  canMirrorTransition,
  isoTimestamp,
  type CheckpointRecord,
  type MirrorFailure,
  type MirrorState,
} from "@hns/core";
import * as v from "valibot";

/**
 * The checkpoint flow's decisions, away from the Durable Object that stores them.
 *
 * @remarks
 * One checkpoint is three calls: prepare (the machine commits and answers metadata), pack (the
 * machine's signed pack reaches the store), and complete (the watermark moves and the record is
 * written). The Durable Object owns the storage and the machine; this module owns what each
 * answer means, so the rules that keep `(C, J)` consistent read in one place and the object only
 * sequences them. Every rule below is checked by the object with these functions.
 */

/**
 * Why a checkpoint call was refused.
 *
 * @remarks
 * `invalid_request` is a malformed or inconsistent input; `conflict` is a checkpoint whose pack
 * never arrived, or a watermark asked to move past entries a checkpoint does not cover. Both are
 * answers a caller may act on (send the pack, name the right seq), so they are values rather
 * than defects. `unauthorized` is a pack whose device signature did not verify.
 */
const CHECKPOINT_REFUSALS = ["invalid_request", "conflict", "unauthorized"] as const;

/** One refusal code of a checkpoint call. */
export type CheckpointRefusal = (typeof CHECKPOINT_REFUSALS)[number];

/**
 * A checkpoint request the object refuses with an answer instead of a defect.
 *
 * @remarks
 * Thrown inside the object's handlers and turned into the RPC's failure envelope; the code is
 * the closed vocabulary above, so no handler spells a status or a free-text reason.
 */
export class CheckpointRefusedError extends Error {
  /** The closed code the RPC answers with. */
  readonly code: CheckpointRefusal;

  constructor(code: CheckpointRefusal, message: string) {
    super(message);
    this.name = "CheckpointRefusedError";
    this.code = code;
  }
}

/** Artifacts' per-file push limit, read by the mirror to choose `skipped` (D106). */
const ARTIFACTS_BLOB_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * The mirror state a checkpoint is recorded with when no push failed yet.
 *
 * @param now - The clock, in milliseconds.
 * @param packBytes - The pack's size.
 * @param maxBlobBytes - The largest blob in the pack.
 * @param packLimitBytes - The pack's push limit; the checkpoint contract's 64 MiB by default.
 * @returns `pending`, or `skipped` with `too_large` when the run is over Artifacts' limits.
 *
 * @remarks
 * The mirror never decides the checkpoint's answer. A run over the push limit is `skipped`, the
 * contract's terminal state for it (no retry can fit it); every other run waits at `pending` for
 * the push (0246). This is state only: the token a push needs is never stored (see `MirrorTarget`
 * in `@hns/core`).
 */
export function initialMirror(
  now: number,
  packBytes: number,
  maxBlobBytes: number,
  packLimitBytes: number,
): MirrorState {
  const updatedAt = isoTimestamp(new Date(now).toISOString());
  if (packBytes > packLimitBytes || maxBlobBytes > ARTIFACTS_BLOB_LIMIT_BYTES) {
    return { status: "skipped", failure: "too_large", updatedAt };
  }
  return { status: "pending", updatedAt };
}

/**
 * Build the record a completed checkpoint stores.
 *
 * @param fields - The prepare answer the pack was sent for, and the mirror state to record.
 * @returns The checkpoint record.
 * @throws ValiError when a field is not what the contract names.
 *
 * @remarks
 * The schema is the contract's, so a field the record does not name cannot be stored (the pack's
 * bytes and the mirror's token are both absent by design). `packKey` comes from the prepare
 * answer, which is the machine's commit, not from the upload request.
 */
export function checkpointRecordOf(fields: {
  readonly runId: string;
  readonly ref: string;
  readonly commit: string;
  readonly packKey: string;
  readonly objectCount: number;
  readonly packBytes: number;
  readonly maxBlobBytes: number;
  readonly mirror: MirrorState;
}): CheckpointRecord {
  return v.parse(CheckpointRecordSchema, {
    runId: fields.runId,
    ref: fields.ref,
    commit: fields.commit,
    packKey: fields.packKey,
    objectCount: fields.objectCount,
    packBytes: fields.packBytes,
    maxBlobBytes: fields.maxBlobBytes,
    mirror: fields.mirror,
  });
}

/**
 * Parse one record a row holds.
 *
 * @param text - The JSON the row stored.
 * @returns The record, with keys the contract does not name dropped.
 * @throws ValiError when the text is not a checkpoint record.
 *
 * @remarks
 * The schema is the trust boundary: a row written by an older build, or by hand, cannot bring a
 * field the contract does not name (the pack's bytes and a mirror token are both absent) into
 * the stored value this returns.
 */
export function parseCheckpointRecord(text: string): CheckpointRecord {
  // The row's text is untrusted: valibot parses it, and the schema is what decides its shape.
  return v.parse(CheckpointRecordSchema, JSON.parse(text));
}

/** What a pack upload answers: the object's RPC body for it. */
export interface PackUploadAnswer {
  readonly ok: true;
  readonly runId: string;
  readonly packKey: string;
  readonly receivedBytes: number;
  readonly stored: boolean;
}

/**
 * What a pack upload answers.
 *
 * @param fields - The Run, the key, the bytes received, and whether this call wrote the pack.
 * @returns The upload answer.
 *
 * @remarks
 * `receivedBytes` is what the object compared with the prepare answer's `packBytes` before it
 * records the checkpoint: a pack of the wrong size is a different pack, and restore would fail.
 */
export function packUploadAnswer(fields: {
  readonly runId: string;
  readonly packKey: string;
  readonly receivedBytes: number;
  readonly stored: boolean;
}): PackUploadAnswer {
  return { ok: true, ...fields };
}

/**
 * The mirror state after an asynchronous push answered.
 *
 * @param from - The state currently recorded.
 * @param to - The status the push reached, with its failure when it failed.
 * @param now - The clock, in milliseconds.
 * @returns The next state, or undefined when the core transition table refuses the move.
 *
 * @remarks
 * The table is the state machine (`MIRROR_TRANSITIONS`): `failed` may go back to `pending` on a
 * retry, and `mirrored` and `skipped` are terminal. Recording the state that is already there is
 * not a transition, so it returns undefined and the caller leaves the row alone.
 */
export function nextMirror(
  from: MirrorState,
  to: { readonly status: MirrorState["status"]; readonly failure?: MirrorFailure | undefined },
  now: number,
): MirrorState | undefined {
  if (!canMirrorTransition(from.status, to.status)) return undefined;
  const updatedAt = isoTimestamp(new Date(now).toISOString());
  return to.failure === undefined
    ? { status: to.status, updatedAt }
    : { status: to.status, failure: to.failure, updatedAt };
}
