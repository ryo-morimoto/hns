import type { CheckpointPackUploadResult } from "@hns/core";
import { MAX_CHECKPOINT_PACK_BYTES } from "@hns/core";

/**
 * The pack receiving port: give the checkpoint path one pack of bytes, without HTTP details.
 *
 * @remarks
 * The machine sends a checkpoint's pack as a signed binary request, and the Workspace object
 * writes it to R2 under `checkpoints/<commit>.pack`. This port is the seam between the Durable
 * Object and that request, so the object decides what a pack means and the edge decides how the
 * bytes arrived. The object calls {@link CheckpointPackTransport.upload} and never reads a
 * request, a header, or a signature.
 *
 * `maxBytes` is the size this receiver accepts, taken from the checkpoint contract
 * ({@link MAX_CHECKPOINT_PACK_BYTES}) so the machine, the endpoint, and this port refuse the same
 * number. A pack over it is `too_large`, and neither the port nor the endpoint reads a partial
 * body: the machine must check before it sends.
 */
export interface CheckpointPackTransport {
  /**
   * Store one pack for one Run.
   *
   * @param runId - The Run the pack belongs to.
   * @param commit - The checkpoint commit the pack is keyed by (C in `(C, J)`).
   * @param bytes - The complete git pack.
   * @returns What the store acknowledged; `receivedBytes` equals `bytes.length`.
   */
  upload(runId: string, commit: string, bytes: Uint8Array): Promise<CheckpointPackUploadResult>;

  /**
   * The largest pack this transport accepts.
   *
   * @returns The limit in bytes; a caller compares a pack's size with it before uploading.
   */
  readonly maxBytes: number;
}

/**
 * The limit every receiver of a checkpoint pack shares.
 *
 * @remarks
 * Re-exported from the checkpoint contract so a transport module does not import a second
 * number. It is Artifacts' push limit, not the Worker's request limit.
 */
export const PACK_MAX_BYTES = MAX_CHECKPOINT_PACK_BYTES;

/**
 * A pack that must not be uploaded.
 *
 * @remarks
 * `too_large` is the only failure of this port: a pack over {@link PACK_MAX_BYTES} is refused
 * before it is read, so the run's mirror is `skipped` rather than half-stored. A store that
 * fails is a defect of the adapter, not a value here.
 */
export class PackTooLargeError extends Error {
  /** The closed failure code. */
  readonly code = "too_large" as const;

  /** The size that was offered and the limit it broke. */
  readonly offeredBytes: number;
  readonly limitBytes: number;

  constructor(offeredBytes: number, limitBytes: number) {
    super(
      "pack of " +
        String(offeredBytes) +
        " bytes is over the " +
        String(limitBytes) +
        " byte limit",
    );
    this.name = "PackTooLargeError";
    this.offeredBytes = offeredBytes;
    this.limitBytes = limitBytes;
  }
}

/**
 * Check a pack's size against the limit every receiver shares.
 *
 * @param bytes - The pack's size.
 * @returns Nothing when the pack may be uploaded.
 * @throws {@link PackTooLargeError} when the pack is over {@link PACK_MAX_BYTES}.
 *
 * @remarks
 * Both the machine's send path and the endpoint's receive path call this with
 * {@link PACK_MAX_BYTES} read from the transport, so the two cannot disagree. A pack exactly at
 * the limit is accepted.
 */
export const assertPackFits = (bytes: number, limit: number = PACK_MAX_BYTES): void => {
  if (bytes > limit) throw new PackTooLargeError(bytes, limit);
};
