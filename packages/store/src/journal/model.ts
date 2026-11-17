import type { IsoTimestamp, MutationUnknownReason, OperationId } from "@hns/core";
import type { JournalRefusalCode } from "./refusals.ts";
import type { JournalEventKind, JournalOutcomeStatus } from "./schema.ts";

/**
 * One body the Journal stores: in its row up to 256KB, or in the object store.
 *
 * @remarks
 * `bytes` is null on the object variant only when the entry was parsed from its row; a cursor
 * read attaches the bytes it fetched from the object store. `hash` is `sha256:<hex>` over them
 * and `size` is their length.
 */
export type JournalBody =
  | {
      readonly storage: "inline";
      readonly hash: string;
      readonly size: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly storage: "object";
      readonly hash: string;
      readonly size: number;
      readonly key: string;
      readonly bytes: Uint8Array | null;
    };

/** The fields every entry carries. */
export interface JournalEntryStamp {
  /** Monotonic per workspace; a reader's cursor is the last seq it has seen. */
  readonly seq: number;
  /** ISO 8601 (UTC). */
  readonly at: IsoTimestamp;
}

/**
 * A write the Journal accepted but has not settled.
 *
 * @remarks
 * The intent is recorded before the machine applies the write, so a crash between the two leaves
 * enough to reconcile (docs/durability.md §3.1). The body is the content to write; the machine
 * re-hashes it before it renames.
 */
export interface JournalIntentEntry extends JournalEntryStamp {
  readonly kind: "intent";
  readonly operationId: OperationId;
  /** The normalized workspace-relative path the write names. */
  readonly path: string;
  /** The version the writer saw, compared again by the machine before it applies. */
  readonly expectedVersion: string;
  /** The bytes to write; null when the intent records no content. */
  readonly body: JournalBody | null;
}

/**
 * What happened to an intent.
 *
 * @remarks
 * The fields mirror `MutationResult` in `@hns/core` for `applied`, `conflict`, and `unknown`:
 * `version` is set only for `applied`, `currentVersion` only for `conflict`, and `reason` is
 * set only for `unknown` (a {@link MutationUnknownReason}) and `denied` (a
 * {@link JournalRefusalCode}). `denied` is the Journal's own settlement of an intent the machine
 * refused before writing, so no checkpoint has to reconcile it. An outcome is never rewritten: a
 * retry reads the recorded one (INV-04).
 */
export interface JournalOutcomeEntry extends JournalEntryStamp {
  readonly kind: "outcome";
  readonly operationId: OperationId;
  readonly path: string;
  readonly status: JournalOutcomeStatus;
  /** The applied version; null unless `status` is `applied`. */
  readonly version: string | null;
  /** The version found instead; null unless `status` is `conflict`. */
  readonly currentVersion: string | null;
  /**
   * Why the outcome is `unknown` (a `MutationUnknownReason`), or the machine's refusal code
   * when it is `denied`; null for `applied` and `conflict`.
   */
  readonly reason: MutationUnknownReason | JournalRefusalCode | null;
}

/**
 * A refused attempt.
 *
 * @remarks
 * Audits outlive truncation because a refusal is evidence: the write never happened, so no
 * checkpoint can absorb it. `operationId` is null when the attempt had no valid id. `reason` is
 * the machine's refusal code, the same closed vocabulary a `denied` outcome records.
 */
export interface JournalAuditEntry extends JournalEntryStamp {
  readonly kind: "audit";
  readonly operationId: OperationId | null;
  readonly path: string | null;
  readonly reason: JournalRefusalCode;
}

/**
 * One file event.
 *
 * @remarks
 * Events outlive truncation so `watch(cursor)` can replay the stream without reading every file.
 * `overflow` carries neither path nor version: coverage was lost.
 */
export interface JournalEventEntry extends JournalEntryStamp {
  readonly kind: "event";
  readonly eventKind: JournalEventKind;
  readonly path: string | null;
  readonly version: string | null;
}

/** One row of the Journal, discriminated by `kind`. */
export type JournalEntry =
  | JournalIntentEntry
  | JournalOutcomeEntry
  | JournalAuditEntry
  | JournalEventEntry;

/**
 * Where the checkpoint folded the Journal.
 *
 * @remarks
 * Every settled intent and outcome at or below `throughSeq` is in checkpoint C, so the Journal
 * truncated them. The watermark never decreases for a workspace, and no intent without an
 * outcome sits below it: an unsettled write is exactly the `unknown` record restore reconciles
 * (INV-04).
 */
export interface JournalWatermark {
  readonly throughSeq: number;
  /** ISO 8601 (UTC). */
  readonly at: IsoTimestamp;
}
