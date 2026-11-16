import type { MutationResult } from "@hns/core";

/**
 * The content hash recorded for a version: "sha256:<hex>".
 *
 * @remarks
 * A version identifies bytes, not a file: it is the sha256 of the content that
 * was read, so rewriting the same bytes keeps the version and a write can
 * compare it against `expectedVersion`.
 */
export type Version = string;

/**
 * What a write expects to replace: a version, or nothing when the name is free.
 *
 * @remarks
 * There is no unconditional member: a write must name the version it saw.
 * `"absent"` requires the path not to exist, so it refuses a write that would
 * replace a file created since the caller looked.
 */
export type ExpectedVersion = Version | "absent";

/** The closed event vocabulary: every `kind` a journal event can carry. */
export const FILE_EVENT_KINDS = ["created", "changed", "deleted", "overflow"] as const;
/** One journal event kind: a file appeared, changed, disappeared, or coverage was lost. */
export type FileEventKind = (typeof FILE_EVENT_KINDS)[number];

interface FileEventStamp {
  /**
   * Journal sequence number, as a decimal string.
   *
   * @remarks
   * Monotonic per workspace; `watch` compares it numerically against its cursor.
   */
  readonly seq: string;
  /** ISO 8601 (UTC). */
  readonly at: string;
}

/**
 * One entry of the journal's event log. Produced by the workspace; consumed by watchers.
 *
 * @remarks
 * `version` is the content hash observed at that moment. `overflow` carries no
 * path: it means coverage was lost, so a consumer must re-read everything it
 * trusts instead of following the stream as a diff.
 */
export type FileEvent =
  | (FileEventStamp & {
      readonly kind: "created" | "changed";
      readonly path: string;
      readonly version: Version;
    })
  | (FileEventStamp & { readonly kind: "deleted"; readonly path: string })
  | (FileEventStamp & { readonly kind: "overflow" });

/** What a new event carries; the journal assigns `seq` and `at` when it stores the event. */
export type FileEventDraft =
  | { readonly kind: "created" | "changed"; readonly path: string; readonly version: Version }
  | { readonly kind: "deleted"; readonly path: string }
  | { readonly kind: "overflow" };

/**
 * A refused operation, kept in the journal for the audit trail.
 *
 * @remarks
 * Written for refusals and containment violations. A FileFailure is reported to
 * the caller but not audited, because it is an environment failure rather than a
 * refusal. A temp file that could not be removed is recorded here too, so a
 * failed cleanup is not silent; its reason names the temp step.
 */
export interface AuditEntry {
  /** ISO 8601 (UTC). */
  readonly at: string;
  /** The attempt's id, or null when it had no valid id to record. */
  readonly operationId: string | null;
  /** The path as the attempt named it, or null when the refusal names no path. */
  readonly path: string | null;
  /** Short reason from the refusal, such as "escapes root" or "root replaced". */
  readonly reason: string;
  /** Always true on a stored entry: the journal has no allow record. */
  readonly denied: true;
}

/**
 * A mutation the journal has accepted but not yet settled.
 *
 * @remarks
 * The intent is saved before the temp file is written, so a crash leaves
 * enough (`expectedVersion`, `contentHash`, `temp`) to reconcile later.
 * `outcome` stays absent while the write is pending.
 *
 * @internal
 */
export interface JournalIntent {
  abs: string;
  rel: string;
  expectedVersion: ExpectedVersion;
  contentHash: Version;
  temp: string;
  outcome?: MutationResult | undefined;
}

/**
 * The whole journal. Stored outside the root; parsed when the workspace opens.
 *
 * @remarks
 * `id` is the workspace identity, compared with the marker inside the root on
 * every open. `seq` is the last event sequence issued; `events` and `audit`
 * are bounded in memory and on disk.
 *
 * @internal
 */
export interface JournalState {
  id?: string | undefined;
  ops: Record<string, JournalIntent>;
  seq: number;
  events: FileEvent[];
  audit: AuditEntry[];
}
