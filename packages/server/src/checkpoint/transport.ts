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
   * @param packKey - The key the pack belongs at, `checkpoints/<commit>.pack` (C in `(C, J)`).
   *   The Workspace object computes it from the checkpoint's metadata, never from a caller's
   *   claim, so the key restore looks up is the key that was written.
   * @param bytes - The complete git pack.
   * @returns What the store did: `stored` when this call wrote the pack, `present` when the
   * key already held it (a retried upload, which costs no write).
   */
  upload(runId: string, packKey: string, bytes: Uint8Array): Promise<PackStoreOutcome>;

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
/**
 * Where a checkpoint pack goes: the object store, narrowed to the three calls this path makes.
 *
 * @remarks
 * The same structural shape the Worker's `OBJECTS` binding and `@hns/workspace`'s
 * `ObjectBucket` have: a fake bucket, R2, and the tests all fit without an adapter. Keys are the
 * content-derived `checkpoints/<commit>.pack`; nothing here names a Run's key, because the key
 * must be the one restore computes from the commit.
 */
export interface PackBucket {
  /** Store one object; null means the bucket refused the write. */
  put(key: string, value: Uint8Array): Promise<{ readonly key: string } | null>;
  /** Whether the key exists; null means it does not. */
  head(key: string): Promise<{ readonly key: string } | null>;
}

/** What one upload did to the store. */
export type PackStoreOutcome =
  | { readonly status: "stored"; readonly packKey: string }
  | { readonly status: "present"; readonly packKey: string };

/** A pack was offered that the transport must not store. */
export class PackRejectedError extends Error {
  /** The closed code, the same vocabulary the pack endpoint answers with. */
  readonly code: "too_large" | "invalid_request";

  constructor(code: "too_large" | "invalid_request", message: string) {
    super(message);
    this.name = "PackRejectedError";
    this.code = code;
  }
}

/**
 * The checkpoint pack store: one pack per commit in the object store, written once.
 *
 * @remarks
 * The Workspace object hands this the bytes a pack endpoint authenticated and verified; the
 * transport owns the key, the size bound, and the no-overwrite rule. One checkpoint is one put:
 * an existing key is a no-op, so a retried upload costs no write and cannot replace a pack
 * restore already depends on (the key is content-derived, and R2 has no bucket versioning).
 *
 * The bound is checked again here even though the endpoint checked it, because the transport is
 * the last place before a write and a caller that skipped the endpoint must not reach R2.
 */
export class R2PackTransport implements CheckpointPackTransport {
  readonly maxBytes: number;
  readonly #bucket: PackBucket;

  /**
   * @param bucket - The object store; production passes the Worker's `OBJECTS` binding.
   * @param maxBytes - The limit this transport accepts; defaults to the checkpoint contract's.
   */
  constructor(bucket: PackBucket, maxBytes: number = PACK_MAX_BYTES) {
    this.#bucket = bucket;
    this.maxBytes = maxBytes;
  }

  /**
   * Store one pack under its commit's key, or leave an existing one alone.
   *
   * @param runId - The Run the pack belongs to; it is not part of the key.
   * @param packKey - `checkpoints/<commit>.pack`, computed from the checkpoint's metadata.
   * @param bytes - The complete git pack, already authenticated and verified.
   * @returns Whether this call wrote the pack, and the key it is at.
   * @throws {@link PackRejectedError} when the bytes are empty or over {@link maxBytes}.
   * @throws Error when the bucket refuses the write: a checkpoint must never be acknowledged
   * without its pack, so the failure propagates instead of being recorded as success.
   *
   * @remarks
   * `runId` is accepted because the port does, and it is not used: the key is the commit's, so
   * two Runs that reach the same commit share one pack, and restore finds C's pack by C alone.
   */
  /**
   * Whether the store already holds a pack under the key.
   *
   * @param packKey - `checkpoints/<commit>.pack`.
   * @returns True when the key exists; a store that cannot answer is a defect and throws.
   *
   * @remarks
   * `complete` checks this before it acknowledges a checkpoint, so an acknowledgement never
   * stands without its pack. A failed lookup is not rounded to "absent": the caller must see the
   * store failing, not a checkpoint that is claimed complete without a pack.
   */
  async has(packKey: string): Promise<boolean> {
    return (await this.#bucket.head(packKey)) !== null;
  }

  async upload(runId: string, packKey: string, bytes: Uint8Array): Promise<PackStoreOutcome> {
    void runId;
    if (bytes.byteLength === 0) {
      throw new PackRejectedError("invalid_request", "a checkpoint pack is never empty");
    }
    assertPackFits(bytes.byteLength, this.maxBytes);
    if ((await this.#bucket.head(packKey)) !== null) return { status: "present", packKey };
    const stored = await this.#bucket.put(packKey, bytes);
    if (stored === null) throw new Error("the object store refused " + packKey);
    return { status: "stored", packKey };
  }
}
