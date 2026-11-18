import { MAX_ARTIFACT_BYTES, MIN_OFFICE_TIMEOUT_MS, OFFICE_DEADLINE_MARGIN_MS } from "@hns/core";

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
  /**
   * Bytes in one JSON response; a larger answer is refused, not truncated.
   *
   * @remarks
   * It bounds a JSON answer, not a file: the office artifact travels on `GET /artifact`, whose
   * range is bounded by {@link maxArtifactBytes} instead (docs/office.md §5).
   */
  readonly maxResponseBytes: number;
  /** Bytes in one `GET /artifact` range; a larger `length` is refused, not shortened. */
  readonly maxArtifactBytes: number;
  /**
   * The office engine's own bounds: its wall clock, and the memory one job may take.
   *
   * @remarks
   * `timeoutMs` is what the 30 second `timeoutMs` above cannot be for a conversion: a job is
   * clamped to `timeoutMs - OFFICE_DEADLINE_MARGIN_MS` so the machine answers `engine_timeout`
   * itself instead of being cut off mid-answer, and every other op keeps the 30 seconds it had.
   * `maxRssMb` is enforced outside the engine (`RLIMIT_AS` in the sandbox): an engine that asks
   * for more is killed, not swapped.
   */
  readonly office: OfficeLimits;
}

/** The office engine's bounds. */
interface OfficeLimits {
  /** Wall-clock budget for one office job, in milliseconds. Never below {@link MIN_OFFICE_TIMEOUT_MS}. */
  readonly timeoutMs: number;
  /** Address space one engine process may take, in MiB. */
  readonly maxRssMb: number;
}

/** Pack uploads share the agent's own default with {@link Limits.timeoutMs}. */
const DEFAULT_PACK_UPLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * The default office engine budget: 90 seconds (docs/office.md §5, U-03).
 *
 * @remarks
 * The heaviest conversion measured in the spike took 17 seconds, and a job is clamped to
 * `OFFICE_DEADLINE_MARGIN_MS` (5 s) below this, so the common case is a 60 second job under a
 * 90 second envelope. It is deliberately **not** {@link Limits.timeoutMs}: a conversion that runs
 * 60 seconds is normal, and the 30 second bound would always cut it first (review B2 / N10).
 */
const DEFAULT_OFFICE_TIMEOUT_MS = 90_000;

/**
 * The default address-space bound for one engine: 2 GiB.
 *
 * @remarks
 * The spike measured 2.5 GB for a heavy workbook and 4.4 GB for a million cells before the OOM
 * abort (S18 / S20); the prescan refuses those inputs before the engine starts, so the bound is
 * the backstop for what the prescan cannot see. It sits at the documented 2 GB working set
 * (docs/office.md §10), and the engine's own fixed cost (about 250 MB measured) is well inside it.
 */
const DEFAULT_OFFICE_MAX_RSS_MB = 2048;

/**
 * The defaults for an agent: 30 seconds for an operation, five minutes for a pack, eight at once,
 * 16 MiB in, 256 KiB out, 8 MiB per artifact range, and a 90 second / 2 GiB office engine.
 */
export const DEFAULT_LIMITS: Limits = {
  timeoutMs: 30_000,
  packUploadTimeoutMs: DEFAULT_PACK_UPLOAD_TIMEOUT_MS,
  maxConcurrency: 8,
  maxRequestBytes: 16 * 1024 * 1024,
  maxResponseBytes: 256 * 1024,
  maxArtifactBytes: MAX_ARTIFACT_BYTES,
  office: {
    timeoutMs: DEFAULT_OFFICE_TIMEOUT_MS,
    maxRssMb: DEFAULT_OFFICE_MAX_RSS_MB,
  },
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
 * @throws {Error} When any bound is not a positive integer, or the office engine's wall clock is
 * below {@link MIN_OFFICE_TIMEOUT_MS}.
 *
 * @remarks
 * An office budget under a minute is a configuration mistake, not a small bound: the engine needs
 * tens of seconds for a real document, and a short budget would turn every preview into
 * `engine_timeout`. It stops the agent at start instead of failing jobs one by one (docs/office.md
 * §5: "office が有効で office.timeoutMs < 60_000 のときは起動時に落とす"). `maxRssMb` is bounded
 * the same way: it is a positive integer in MiB.
 */
export function resolveLimits(overrides?: Partial<Limits>): Limits {
  const officeTimeout = positiveInteger(
    "office.timeoutMs",
    overrides?.office?.timeoutMs ?? DEFAULT_LIMITS.office.timeoutMs,
  );
  if (officeTimeout < MIN_OFFICE_TIMEOUT_MS) {
    throw new Error(
      "the machine limit office.timeoutMs must be at least " +
        String(MIN_OFFICE_TIMEOUT_MS) +
        " ms; " +
        String(officeTimeout) +
        " would time out every preview",
    );
  }
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
    maxArtifactBytes: positiveInteger(
      "maxArtifactBytes",
      overrides?.maxArtifactBytes ?? DEFAULT_LIMITS.maxArtifactBytes,
    ),
    office: {
      timeoutMs: officeTimeout,
      maxRssMb: positiveInteger(
        "office.maxRssMb",
        overrides?.office?.maxRssMb ?? DEFAULT_LIMITS.office.maxRssMb,
      ),
    },
  };
}

/**
 * The budget one job runs under: the job's own, clamped below the machine's envelope.
 *
 * @param jobTimeoutMs - The job's `limits.timeoutMs`, which the server resolved.
 * @param officeTimeoutMs - The machine's `office.timeoutMs`.
 * @returns `min(jobTimeoutMs, officeTimeoutMs - OFFICE_DEADLINE_MARGIN_MS)`.
 *
 * @remarks
 * The clamp is what lets the machine answer "timed out" itself: the request's own deadline is the
 * office envelope, and the job is cut off five seconds earlier so the refusal is written instead
 * of the connection being abandoned mid-answer (docs/office.md §5).
 */
export function officeJobTimeoutMs(jobTimeoutMs: number, officeTimeoutMs: number): number {
  return Math.min(jobTimeoutMs, officeTimeoutMs - OFFICE_DEADLINE_MARGIN_MS);
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
