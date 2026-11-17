import * as v from "valibot";
import { IsoTimestampSchema } from "./codecs.ts";
import type { IsoTimestamp } from "./codecs.ts";

/**
 * The checkpoint and Artifacts-mirror contract shared by the machine, the Workspace object, and
 * the review service.
 *
 * @remarks
 * R2 holds the authoritative checkpoint; Artifacts is a mirror of it (D106). This module fixes
 * the vocabulary both sides spell, so the mirror's states and reasons cannot drift between the
 * Worker that records them and the machine that reports them. It holds types and schemas only:
 * the commit and pack belong to `@hns/workspace`'s checkpoint, the push belongs to the machine,
 * and no adapter lives here.
 *
 * A pack is bytes and never JSON. {@link CheckpointRecord} is what the Workspace object stores
 * after R2 has the pack; {@link CheckpointPrepareResult} is what the machine answers with before
 * the pack is sent; the pack itself travels on its own binary request
 * ({@link CHECKPOINT_PACK_CONTENT_TYPE}).
 */

/**
 * The states of one checkpoint's Artifacts mirror.
 *
 * @remarks
 * `pending` is the state R2's acknowledgement writes; the mirror moves out of it asynchronously
 * (the ack never waits for Artifacts). `mirrored` and `skipped` are terminal: a mirror that
 * succeeded is not redone, and a run too large for Artifacts is not retried into the same limit.
 * `failed` is a mirror that may be retried, and is the only state a retry returns to `pending`
 * from ({@link MIRROR_TRANSITIONS}).
 */
export const MIRROR_STATUSES = ["pending", "mirrored", "skipped", "failed"] as const;

/** One state of a checkpoint's Artifacts mirror. */
export type MirrorStatus = (typeof MIRROR_STATUSES)[number];

/**
 * Why a checkpoint's Artifacts mirror failed.
 *
 * @remarks
 * These are expected failures of the mirror, not defects: the run's checkpoint is safe in R2 in
 * every one of them, so none may fail the checkpoint's acknowledgement. `too_large` is a blob or
 * pack over Artifacts' push limit; `unauthorized` is a refused token; `push_rejected` is the
 * remote refusing the ref; `network` is a transport failure; `repo_unavailable` is the repo
 * binding failing to get or create the repository; `unknown` is a failure the mirror could not
 * classify, kept so the state can be recorded instead of guessed at.
 */
export const MIRROR_FAILURES = [
  "too_large",
  "unauthorized",
  "push_rejected",
  "network",
  "repo_unavailable",
  "unknown",
] as const;

/** One reason a checkpoint's Artifacts mirror failed. */
export type MirrorFailure = (typeof MIRROR_FAILURES)[number];

/**
 * Every state one mirror status may move to.
 *
 * @remarks
 * The table is the state machine, and callers read it from here rather than re-deriving it. A
 * mirror starts `pending` and settles as `mirrored`, is `skipped` when the run is over
 * Artifacts' limits, or `failed`. Only from `failed` does a retry move the mirror back to
 * `pending`. `mirrored` and `skipped` are terminal, so their rows are empty. A status added to
 * {@link MIRROR_STATUSES} does not compile until it has a row here.
 */
export const MIRROR_TRANSITIONS: Readonly<Record<MirrorStatus, readonly MirrorStatus[]>> = {
  pending: ["mirrored", "skipped", "failed"],
  mirrored: [],
  skipped: [],
  failed: ["pending"],
};

/**
 * The statuses a mirror may move to.
 *
 * @param from - The status the mirror is in.
 * @returns The target statuses; empty for a terminal status.
 */
export const mirrorTargets = (from: MirrorStatus): readonly MirrorStatus[] =>
  MIRROR_TRANSITIONS[from];

/**
 * Whether one mirror status may move to another.
 *
 * @param from - The status the mirror is in.
 * @param to - The status a caller wants to record next.
 * @returns True when {@link MIRROR_TRANSITIONS} has the move. A move from a status to itself is
 * false: recording the same state again is not a transition.
 */
export const canMirrorTransition = (from: MirrorStatus, to: MirrorStatus): boolean =>
  from !== to && MIRROR_TRANSITIONS[from].some((target) => target === to);

interface MirrorStateFields {
  readonly status: MirrorStatus;
  readonly failure?: MirrorFailure | undefined;
  readonly updatedAt: IsoTimestamp;
}

/**
 * The persisted state of one checkpoint's Artifacts mirror.
 *
 * @remarks
 * This is what the Workspace object stores, so it holds no credential: the token a push needs
 * lives in {@link MirrorTarget}, handed to the machine once and never saved. `failure` is
 * present only when `status` is `failed`; `updatedAt` is when the state was recorded.
 * {@link MirrorStateSchema} drops a key the shape does not name, so a credential that came over
 * the wire cannot enter the stored value through the schema contract.
 */
export interface MirrorState extends MirrorStateFields {}

/**
 * A short-lived credential to push one checkpoint into Artifacts.
 *
 * @remarks
 * The Workspace object builds this when it prepares a checkpoint and passes it to the machine in
 * that one exchange. It is never persisted, logged, or put in an event, and it is not a member of
 * {@link CheckpointRecord} or {@link MirrorState}: a record that outlives the push has no place
 * to keep a token. `expiresAt` bounds the token's life; the machine pushes to `ref` before then.
 */
export interface MirrorTarget {
  /** The Artifacts remote the machine pushes to. */
  readonly remote: string;
  /** The write token; a secret, valid only for the duration of the push. */
  readonly token: string;
  /** The ref to push under, `refs/heads/hns/run/<runId>`. */
  readonly ref: string;
  /** When the token stops working. */
  readonly expiresAt: IsoTimestamp;
}

interface CheckpointRecordFields {
  readonly runId: string;
  readonly ref: string;
  readonly commit: string;
  readonly packKey: string;
  readonly objectCount: number;
  readonly packBytes: number;
  readonly maxBlobBytes: number;
  readonly mirror: MirrorStateFields;
}

/**
 * What the Workspace object records for one checkpoint after R2 has its pack.
 *
 * @remarks
 * The field names and meanings are the checkpoint contract's (`@hns/workspace`'s
 * `checkpointRun`): `runId` names `refs/hns/checkpoints/<runId>`, `ref` and `commit` are the
 * commit C the ref advanced to, `packKey` is `checkpoints/<commit>.pack`, and `objectCount` is
 * how many objects the pack holds. It adds what the machine measures for the pack it sent:
 * `packBytes` (the pack's size) and `maxBlobBytes` (the largest blob in it), which the mirror
 * reads against Artifacts' limits. `maxBlobBytes` is not part of the `checkpointRun` result
 * yet; the machine's checkpoint operation adds both to its answer.
 *
 * The pack's bytes are not a field: they travel in their own binary request and live in R2 under
 * `packKey`. `mirror` starts at `pending` and moves asynchronously. `token` is not a field by
 * design (see {@link MirrorTarget}).
 */
export interface CheckpointRecord extends CheckpointRecordFields {}

interface CheckpointPrepareFields {
  readonly runId: string;
  readonly ref: string;
  readonly commit: string;
  readonly packKey: string;
  readonly objectCount: number;
  readonly packBytes: number;
  readonly maxBlobBytes: number;
  readonly created: boolean;
}

/**
 * What the machine answers for a checkpoint, before its pack is sent.
 *
 * @remarks
 * The answer is metadata only: the pack is a separate binary request. `created` is false when the
 * Run already had a checkpoint, so a retried prepare returns the same `commit` and `packKey`, and
 * the caller can skip the upload when the key is already in R2. None of these fields is a secret.
 */
export interface CheckpointPrepareResult extends CheckpointPrepareFields {}

interface CheckpointPackUploadFields {
  readonly runId: string;
  readonly receivedBytes: number;
}

/**
 * What a pack upload received.
 *
 * @remarks
 * `receivedBytes` is what `Content-Length` promised and the body delivered, so the caller can
 * compare it with the prepare's `packBytes` before it advances the watermark.
 */
export interface CheckpointPackUploadResult extends CheckpointPackUploadFields {}

/**
 * The largest pack the checkpoint path accepts: 64 MiB.
 *
 * @remarks
 * This is Artifacts' push limit, not the Worker's request limit. The machine refuses to send a
 * larger pack and the pack endpoint refuses to receive one, so both sides refuse at the same
 * number. A larger pack is not an error of the checkpoint itself: its R2 copy is still valid and
 * the mirror records the run as `skipped` with `too_large`.
 */
export const MAX_CHECKPOINT_PACK_BYTES = 64 * 1024 * 1024;

/** The media type of a checkpoint pack's body: a git pack, not JSON. */
export const CHECKPOINT_PACK_CONTENT_TYPE = "application/x-git-pack";

/**
 * The largest single file Artifacts accepts: 32 MiB.
 *
 * @remarks
 * Artifacts refuses a push whose largest blob is over this, however small the pack is. The
 * mirror reads it against the machine's `maxBlobBytes` and records `skipped` with `too_large`
 * before any push, so a run that cannot be mirrored is not retried into the same refusal.
 */
export const ARTIFACTS_MAX_BLOB_BYTES = 32 * 1024 * 1024;

/**
 * Whether one checkpoint can be mirrored to Artifacts.
 *
 * @param packBytes - The pack's size.
 * @param maxBlobBytes - The largest blob in the pack.
 * @returns True when both are within Artifacts' limits.
 *
 * @remarks
 * The one place the two limits are compared, so the Workspace object's initial state and the
 * machine's pre-push check cannot disagree. A value exactly at a limit fits.
 */
export const fitsArtifacts = (packBytes: number, maxBlobBytes: number): boolean =>
  fitsCheckpointPack(packBytes) && maxBlobBytes <= ARTIFACTS_MAX_BLOB_BYTES;

/**
 * Whether a pack is within {@link MAX_CHECKPOINT_PACK_BYTES}.
 *
 * @param bytes - The pack's size.
 * @returns True when the pack may be sent; false when it is over the limit.
 *
 * @remarks
 * A pure comparison, so the machine (before sending), the pack endpoint (before reading), and the
 * mirror (before choosing `skipped`) decide with the same number. A pack exactly at the limit is
 * accepted.
 */
export const fitsCheckpointPack = (bytes: number): boolean => bytes <= MAX_CHECKPOINT_PACK_BYTES;

interface CheckpointPrepareAnswerFields {
  readonly checkpoint: CheckpointPrepareResult;
  readonly watermark: number;
  readonly mirror?: MirrorTarget | undefined;
}

/**
 * What a prepare answers: the machine's metadata, the Journal watermark, and the mirror target.
 *
 * @remarks
 * The Workspace object's answer to `POST /rpc/checkpoint/prepare`. `mirror` is present only
 * when the mirror is switched on and the run is within Artifacts' limits, and it is the **one**
 * place {@link MirrorTarget} travels: it is not stored, logged, or put in an event, so the
 * schema below is the boundary that keeps the token out of everything that outlives the answer.
 */
export interface CheckpointPrepareAnswer extends CheckpointPrepareAnswerFields {}

/** A non-empty string. */
const nonEmpty = v.pipe(v.string(), v.minLength(1));

/** A byte count or object count: a non-negative integer. */
const count = v.pipe(v.number(), v.integer(), v.minValue(0));

/** The stored mirror state as it arrives, parsed at the boundary. */
export const MirrorStateSchema: v.GenericSchema<unknown, MirrorState> = v.object({
  status: v.picklist(MIRROR_STATUSES),
  failure: v.optional(v.picklist(MIRROR_FAILURES)),
  updatedAt: IsoTimestampSchema,
});

/** The checkpoint record as it arrives, parsed at the boundary. */
export const CheckpointRecordSchema: v.GenericSchema<unknown, CheckpointRecord> = v.object({
  runId: nonEmpty,
  ref: nonEmpty,
  commit: nonEmpty,
  packKey: nonEmpty,
  objectCount: count,
  packBytes: count,
  maxBlobBytes: count,
  mirror: MirrorStateSchema,
});

/** The prepare answer as it arrives, parsed at the boundary. */
export const CheckpointPrepareResultSchema: v.GenericSchema<unknown, CheckpointPrepareResult> =
  v.object({
    runId: nonEmpty,
    ref: nonEmpty,
    commit: nonEmpty,
    packKey: nonEmpty,
    objectCount: count,
    packBytes: count,
    maxBlobBytes: count,
    created: v.boolean(),
  });

/**
 * The mirror target as it travels to the machine, parsed where it is read.
 *
 * @remarks
 * This is a **transient** schema: it parses an in-flight answer, and nothing parses a stored or
 * logged value with it. `ref` is a full ref name under `refs/heads/`, because Artifacts'
 * binding resolves only branches and tags and a fork carries only those.
 */
const MirrorTargetSchema: v.GenericSchema<unknown, MirrorTarget> = v.object({
  remote: nonEmpty,
  token: nonEmpty,
  ref: v.pipe(nonEmpty, v.startsWith("refs/heads/")),
  expiresAt: IsoTimestampSchema,
});

/** The prepare answer as it arrives, parsed at the boundary. */
export const CheckpointPrepareAnswerSchema: v.GenericSchema<unknown, CheckpointPrepareAnswer> =
  v.object({
    checkpoint: CheckpointPrepareResultSchema,
    watermark: count,
    mirror: v.optional(MirrorTargetSchema),
  });

/** The pack upload answer as it arrives, parsed at the boundary. */
export const CheckpointPackUploadResultSchema: v.GenericSchema<
  unknown,
  CheckpointPackUploadResult
> = v.object({
  runId: nonEmpty,
  receivedBytes: count,
});
