import { Denied, FileFailure } from "@hns/workspace";
import type { MutationResult } from "@hns/core";

/**
 * What a tool reports when it refuses. A failure is a value the model can read
 * and act on, not an exception: the run keeps its history (docs/typescript.md §3).
 */
export type ToolFailure =
  | { readonly ok: false; readonly status: "denied"; readonly message: string }
  | {
      readonly ok: false;
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
    };

/** A write already carries its own outcome; only a thrown boundary check is a failure. */
export type WriteReply = MutationResult | ToolFailure;

export type ReadReply =
  | { readonly ok: true; readonly content: string; readonly version: string }
  | ToolFailure;

/** Map an expected workspace failure to a value; anything else is a defect and propagates. */
export function failureOf(error: Error): ToolFailure {
  if (error instanceof Denied) return { ok: false, status: "denied", message: error.message };
  if (error instanceof FileFailure) {
    return { ok: false, status: "failed", code: error.code, message: error.message };
  }
  throw error;
}
