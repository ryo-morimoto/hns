import { Denied, FileFailure } from "@hns/workspace";
import type { MutationResult } from "@hns/core";

/**
 * What a tool reports when it refuses. A failure is a value the model can read
 * and act on, not an exception: the run keeps its history (docs/typescript.md §3).
 */
export type ToolFailure =
  /** The workspace refused the request, such as a path outside the root. */
  | { readonly ok: false; readonly status: "denied"; readonly message: string }
  /** The environment failed; `code` is pi-durable's file error code, such as "not_found". */
  | {
      readonly ok: false;
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
    };

/**
 * What write_file returns: the workspace's outcome, or a refused boundary check.
 *
 * @remarks
 * Conflict and unknown are values, so a write that raced still carries the
 * operationId a caller reconciles with. Only a thrown check becomes a ToolFailure.
 * The tool sets isError for every status except "applied".
 */
export type WriteReply = MutationResult | ToolFailure;

/**
 * What read_file returns: the file through the tool's bound, or a refusal.
 *
 * @remarks
 * `version` and `characters` describe the whole file, not `content`; a truncated
 * reply can still be written back with `expectedVersion` set to this `version`.
 */
export type ReadReply =
  | {
      readonly ok: true;
      /** The head of the file, bounded by the read tool. */
      readonly content: string;
      /** The whole file's version, usable as write_file's expectedVersion. */
      readonly version: string;
      /** True when the file is larger than the tool returns; the version still names the whole file. */
      readonly truncated: boolean;
      /** Characters in the whole file. */
      readonly characters: number;
    }
  | ToolFailure;

/**
 * Map an expected workspace failure to a value; anything else is a defect and propagates.
 *
 * @param error - The error a workspace call threw.
 * @returns denied for a Denied, failed with its code for a FileFailure.
 * @throws The same error, unchanged, for anything else: a defect must not reach the
 * model as a tool failure it could retry.
 *
 * @example
 * ```ts @import.meta.vitest
 * expect(failureOf(new Denied("outside"))).toEqual({
 *   ok: false,
 *   status: "denied",
 *   message: "outside",
 * });
 * expect(failureOf(new FileFailure("not_found", "missing"))).toEqual({
 *   ok: false,
 *   status: "failed",
 *   code: "not_found",
 *   message: "missing",
 * });
 * expect(() => failureOf(new Error("bug"))).toThrow("bug");
 * ```
 */
export function failureOf(error: Error): ToolFailure {
  if (error instanceof Denied) return { ok: false, status: "denied", message: error.message };
  if (error instanceof FileFailure) {
    return { ok: false, status: "failed", code: error.code, message: error.message };
  }
  throw error;
}
