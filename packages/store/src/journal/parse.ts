/* oxlint-disable anti-slop/no-unknown-parameters --
   These functions are the DB boundary: they take an unknown row and parse it.
*/
import { IsoTimestampSchema, OperationIdSchema } from "@hns/core";
import * as v from "valibot";
import type {
  JournalAuditEntry,
  JournalBody,
  JournalEntry,
  JournalEventEntry,
  JournalIntentEntry,
  JournalOutcomeEntry,
} from "./model.ts";
import { JOURNAL_REFUSAL_CODES } from "./refusals.ts";
import {
  JOURNAL_BODY_HASH_PATTERN,
  JOURNAL_EVENT_KINDS,
  JOURNAL_KINDS,
  JOURNAL_OUTCOME_STATUSES,
  JOURNAL_UNKNOWN_REASONS,
} from "./schema.ts";

const SeqSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const NonEmptyText = v.pipe(v.string(), v.minLength(1));
const BodyHashSchema = v.pipe(v.string(), v.regex(JOURNAL_BODY_HASH_PATTERN));
const BodySizeSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const BodyBytesSchema = v.union([v.instance(Uint8Array), v.instance(ArrayBuffer)]);

const KindRowSchema = v.object({ kind: v.picklist(JOURNAL_KINDS) });

const IntentRowSchema = v.object({
  seq: SeqSchema,
  kind: v.literal("intent"),
  operation_id: OperationIdSchema,
  path: NonEmptyText,
  at: IsoTimestampSchema,
  expected_version: NonEmptyText,
  body_hash: v.nullable(BodyHashSchema),
  body_key: v.nullable(NonEmptyText),
  body_size: v.nullable(BodySizeSchema),
  body: v.nullable(BodyBytesSchema),
});

/**
 * The reason column of an outcome and an audit: the unknown vocabulary or the refusal codes.
 *
 * @remarks
 * One closed set per status: an `unknown` outcome names a `MutationUnknownReason` and a
 * `denied` outcome or an audit names a machine refusal code. A value outside both is corruption.
 * The column is the union here so the schema states what the row may hold; which half applies
 * is checked against the status in `outcomeFieldsMatch`.
 */
const ReasonSchema = v.picklist([...JOURNAL_UNKNOWN_REASONS, ...JOURNAL_REFUSAL_CODES]);

const OutcomeRowSchema = v.object({
  seq: SeqSchema,
  kind: v.literal("outcome"),
  operation_id: OperationIdSchema,
  path: NonEmptyText,
  at: IsoTimestampSchema,
  status: v.picklist(JOURNAL_OUTCOME_STATUSES),
  version: v.nullable(NonEmptyText),
  current_version: v.nullable(NonEmptyText),
  reason: v.nullable(ReasonSchema),
});

const AuditRowSchema = v.object({
  seq: SeqSchema,
  kind: v.literal("audit"),
  operation_id: v.nullable(OperationIdSchema),
  path: v.nullable(NonEmptyText),
  at: IsoTimestampSchema,
  reason: v.picklist(JOURNAL_REFUSAL_CODES),
});

const EventRowSchema = v.object({
  seq: SeqSchema,
  kind: v.literal("event"),
  event_kind: v.picklist(JOURNAL_EVENT_KINDS),
  path: v.nullable(NonEmptyText),
  version: v.nullable(NonEmptyText),
  at: IsoTimestampSchema,
});

/** The columns a body can occupy. */
interface BodyRow {
  readonly seq: number;
  readonly body_hash: string | null;
  readonly body_key: string | null;
  readonly body_size: number | null;
  readonly body: Uint8Array | ArrayBuffer | null;
}

/**
 * Rebuild one body from its columns, or fail loudly.
 *
 * @throws Error when the columns disagree, which means the row is corrupt rather than absent.
 *
 * @internal
 */
function bodyOf(row: BodyRow): JournalBody | null {
  if (row.body_hash === null) return null;
  if (row.body !== null) {
    const bytes = row.body instanceof Uint8Array ? row.body : new Uint8Array(row.body);
    if (row.body_key !== null || row.body_size !== bytes.byteLength) {
      throw new Error("journal row " + String(row.seq) + " has an inconsistent inline body");
    }
    return { storage: "inline", hash: row.body_hash, size: bytes.byteLength, bytes };
  }
  if (row.body_key === null || row.body_size === null) {
    throw new Error("journal row " + String(row.seq) + " has no body reference");
  }
  return {
    storage: "object",
    hash: row.body_hash,
    size: row.body_size,
    key: row.body_key,
    bytes: null,
  };
}

type OutcomeRow = v.InferOutput<typeof OutcomeRowSchema>;

/** Whether an outcome's version fields match its status. */
function outcomeFieldsMatch(row: OutcomeRow): boolean {
  switch (row.status) {
    case "applied":
      return row.version !== null && row.current_version === null && row.reason === null;
    case "conflict":
      return row.current_version !== null && row.version === null && row.reason === null;
    case "unknown":
      return (
        row.version === null &&
        row.current_version === null &&
        JOURNAL_UNKNOWN_REASONS.some((reason) => reason === row.reason)
      );
    case "denied":
      // The reason is the machine's refusal code, from the core vocabulary this package checks
      // its own list against; a code outside it is corruption, not a code to pass through.
      return (
        row.version === null &&
        row.current_version === null &&
        JOURNAL_REFUSAL_CODES.some((code) => code === row.reason)
      );
  }
}

type EventRow = v.InferOutput<typeof EventRowSchema>;

/** Whether an event kind carries the fields it must. */
function eventFieldsMatch(row: EventRow): boolean {
  switch (row.event_kind) {
    case "created":
    case "changed":
      return row.path !== null && row.version !== null;
    case "deleted":
      return row.path !== null && row.version === null;
    case "overflow":
      return row.path === null && row.version === null;
  }
}

const IntentEntrySchema: v.GenericSchema<unknown, JournalIntentEntry> = v.pipe(
  IntentRowSchema,
  v.transform((row): JournalIntentEntry => ({
    seq: row.seq,
    kind: "intent",
    operationId: row.operation_id,
    path: row.path,
    at: row.at,
    expectedVersion: row.expected_version,
    body: bodyOf(row),
  })),
);

const OutcomeEntrySchema: v.GenericSchema<unknown, JournalOutcomeEntry> = v.pipe(
  OutcomeRowSchema,
  v.check(outcomeFieldsMatch, "an outcome's version fields must match its status"),
  v.transform((row): JournalOutcomeEntry => ({
    seq: row.seq,
    kind: "outcome",
    operationId: row.operation_id,
    path: row.path,
    at: row.at,
    status: row.status,
    version: row.version,
    currentVersion: row.current_version,
    reason: row.reason,
  })),
);

const AuditEntrySchema: v.GenericSchema<unknown, JournalAuditEntry> = v.pipe(
  AuditRowSchema,
  v.transform((row): JournalAuditEntry => ({
    seq: row.seq,
    kind: "audit",
    operationId: row.operation_id,
    path: row.path,
    at: row.at,
    reason: row.reason,
  })),
);

const EventEntrySchema: v.GenericSchema<unknown, JournalEventEntry> = v.pipe(
  EventRowSchema,
  v.check(eventFieldsMatch, "an event's path and version must match its kind"),
  v.transform((row): JournalEventEntry => ({
    seq: row.seq,
    kind: "event",
    eventKind: row.event_kind,
    path: row.path,
    version: row.version,
    at: row.at,
  })),
);

/**
 * Parse one stored Journal row into its public entry.
 *
 * @param input - A row read from the Journal table.
 * @returns The entry whose `kind` names its shape.
 * @throws ValiError when a column is missing, has the wrong type, or disagrees with the kind.
 *
 * @remarks
 * This is the storage boundary: a corrupt row must surface, never read as an empty or default
 * entry. The table's CHECK constraints cover the same invariants; the parser is what a reader
 * trusts after a migration or a manual edit.
 *
 * @example
 * ```ts @import.meta.vitest
 * const entry = (await import("./parse.ts")).parseJournalEntry({
 *   seq: 1,
 *   kind: "audit",
 *   operation_id: "op-1",
 *   path: "a.txt",
 *   at: "2026-01-01T00:00:00.000Z",
 *   reason: "path_denied",
 * });
 * expect(entry.seq).toBe(1);
 * expect(entry.kind).toBe("audit");
 * ```
 */
export function parseJournalEntry(input: unknown): JournalEntry {
  const { kind } = v.parse(KindRowSchema, input);
  switch (kind) {
    case "intent":
      return v.parse(IntentEntrySchema, input);
    case "outcome":
      return v.parse(OutcomeEntrySchema, input);
    case "audit":
      return v.parse(AuditEntrySchema, input);
    case "event":
      return v.parse(EventEntrySchema, input);
  }
}
