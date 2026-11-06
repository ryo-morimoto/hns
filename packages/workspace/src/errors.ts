import type { FileErrorCode } from "@earendil-works/pi-durable/env";

/** The caller asked for something the workspace refuses. */
export class Denied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Denied";
  }
}

const CRASH_POINTS = ["intent", "temp", "rename"] as const;
/** Where a test makes the write stop. Not for callers. */
export type CrashPoint = (typeof CRASH_POINTS)[number];

/** Thrown by the crash hook, standing in for a process that died. */
export class Crash extends Error {
  readonly step: CrashPoint;

  constructor(step: CrashPoint) {
    super(step);
    this.name = "Crash";
    this.step = step;
  }
}

/** The environment cannot provide a guarantee that was required. */
export class Unavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unavailable";
  }
}

/** A file failure in pi-durable's vocabulary, so callers branch on code, not message. */
export class FileFailure extends Error {
  readonly code: FileErrorCode;

  constructor(code: FileErrorCode, message: string) {
    super(message);
    this.name = "FileFailure";
    this.code = code;
  }
}
