/**
 * The bounds one agent runs under.
 *
 * @remarks
 * Every bound is a positive integer. They are checked when the agent starts, so
 * a configuration mistake stops the process instead of silently disabling a
 * limit.
 */
export interface Limits {
  /** Wall-clock budget for one JSON operation, body included. */
  readonly timeoutMs: number;
  /**
   * Wall-clock budget for one pack upload, body included.
   *
   * @remarks
   * A checkpoint's pack is tens of MiB over a tunnel, so it does not share {@link timeoutMs}
   * with the JSON operations (0244). It shares the concurrency slots, though: the upload holds
   * one of the {@link maxConcurrency} slots while it runs, exactly as a JSON operation does.
   */
  readonly packUploadTimeoutMs: number;
  /** Requests handled at once; the rest are refused as busy. */
  readonly maxConcurrency: number;
  /** Bytes in one request body. */
  readonly maxRequestBytes: number;
  /** Bytes in one response body; a larger answer is refused, not truncated. */
  readonly maxResponseBytes: number;
}

/** Pack uploads share the agent's own default with {@link Limits.timeoutMs}. */
const DEFAULT_PACK_UPLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * The defaults for an agent: 30 seconds for an operation, five minutes for a pack, eight at once,
 * 16 MiB in, 256 KiB out.
 */
export const DEFAULT_LIMITS: Limits = {
  timeoutMs: 30_000,
  packUploadTimeoutMs: DEFAULT_PACK_UPLOAD_TIMEOUT_MS,
  maxConcurrency: 8,
  maxRequestBytes: 16 * 1024 * 1024,
  maxResponseBytes: 256 * 1024,
};

/** One bound, validated. */
function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`the machine limit ${name} must be a positive integer`);
  }
  return value;
}

/**
 * Fill in the limits an agent uses.
 *
 * @param overrides - The bounds to change; the rest keep their defaults.
 * @returns A complete set of bounds.
 * @throws {Error} When any bound is not a positive integer.
 */
export function resolveLimits(overrides?: Partial<Limits>): Limits {
  return {
    timeoutMs: positiveInteger("timeoutMs", overrides?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs),
    packUploadTimeoutMs: positiveInteger(
      "packUploadTimeoutMs",
      overrides?.packUploadTimeoutMs ?? DEFAULT_LIMITS.packUploadTimeoutMs,
    ),
    maxConcurrency: positiveInteger(
      "maxConcurrency",
      overrides?.maxConcurrency ?? DEFAULT_LIMITS.maxConcurrency,
    ),
    maxRequestBytes: positiveInteger(
      "maxRequestBytes",
      overrides?.maxRequestBytes ?? DEFAULT_LIMITS.maxRequestBytes,
    ),
    maxResponseBytes: positiveInteger(
      "maxResponseBytes",
      overrides?.maxResponseBytes ?? DEFAULT_LIMITS.maxResponseBytes,
    ),
  };
}

/**
 * The concurrency counter: a slot is taken before work starts and returned once.
 *
 * @remarks
 * A request that cannot take a slot is refused as busy; it never waits, because
 * waiting would turn the bound into a queue that can be filled on purpose.
 */
export class InFlight {
  readonly #max: number;
  #count = 0;

  constructor(max: number) {
    this.#max = positiveInteger("maxConcurrency", max);
  }

  /** The number of requests holding a slot now. */
  get count(): number {
    return this.#count;
  }

  /** The most requests allowed at once. */
  get max(): number {
    return this.#max;
  }

  /**
   * Take a slot.
   *
   * @returns true when a slot was free; false when every slot is taken.
   */
  enter(): boolean {
    if (this.#count >= this.#max) return false;
    this.#count += 1;
    return true;
  }

  /**
   * Return a slot.
   *
   * @throws {Error} When called more times than `enter` succeeded: a double
   * release would let more requests in than the bound allows.
   */
  leave(): void {
    if (this.#count === 0) throw new Error("InFlight.leave() without a matching enter()");
    this.#count -= 1;
  }
}
