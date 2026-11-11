import type { FileErrorCode } from "@earendil-works/pi-durable/env";

/**
 * The caller asked for something the workspace refuses.
 *
 * @remarks
 * Denied is an expected answer, not a bug: an absolute path, a `..` segment,
 * a path that resolves outside the root, a replaced root, a reused
 * `operationId`, or a write below `.git`. The workspace records a Denied in
 * its audit log and rethrows it, so a caller can log the refusal without
 * parsing the message.
 */
export class Denied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Denied";
  }
}

const CRASH_POINTS = ["intent", "temp", "rename"] as const;
/** Where a test makes the write stop. Not for callers. */
export type CrashPoint = (typeof CRASH_POINTS)[number];

/**
 * Thrown by the crash hook, standing in for a process that died.
 *
 * @remarks
 * Only `WorkspaceOptions.crashAt` produces one. The journal already holds the
 * intent written before the step, so the next `open` recovers the operation
 * instead of losing it.
 */
export class Crash extends Error {
  readonly step: CrashPoint;

  constructor(step: CrashPoint) {
    super(step);
    this.name = "Crash";
    this.step = step;
  }
}

/**
 * The environment cannot provide a guarantee that was required.
 *
 * @remarks
 * Raised when `rooted: "required"` is set and the rooted helper cannot run.
 * The default falls back to `mode: "checks"` instead of throwing, because the
 * path-based checks still hold the root, only with a wider race window.
 */
export class Unavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unavailable";
  }
}

/**
 * A file failure in pi-durable's vocabulary, so callers branch on code, not message.
 *
 * @remarks
 * The workspace converts `FileError` and unexpected OS errors from
 * `ExecutionEnv` into a FileFailure, so `code` keeps pi-durable's meaning
 * (`not_found`, `permission_denied`, `invalid`, `unknown`, and so on).
 */
export class FileFailure extends Error {
  readonly code: FileErrorCode;

  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = "FileFailure";
    this.code = code;
  }
}
