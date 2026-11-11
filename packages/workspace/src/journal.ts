import * as v from "valibot";
import type { JsonValue, MutationResult } from "@hns/core";
import type { JournalIntent, JournalState } from "./types.ts";

const MutationResultSchema: v.GenericSchema<unknown, MutationResult> = v.variant("status", [
  v.object({ status: v.literal("applied"), operationId: v.string(), version: v.string() }),
  v.object({ status: v.literal("conflict"), operationId: v.string(), currentVersion: v.string() }),
  v.object({
    status: v.literal("unknown"),
    operationId: v.string(),
    reason: v.picklist(["io", "crash", "timeout"]),
  }),
]);

const FileEventSchema = v.variant("kind", [
  v.object({
    seq: v.string(),
    at: v.string(),
    kind: v.literal("created"),
    path: v.string(),
    version: v.string(),
  }),
  v.object({
    seq: v.string(),
    at: v.string(),
    kind: v.literal("changed"),
    path: v.string(),
    version: v.string(),
  }),
  v.object({ seq: v.string(), at: v.string(), kind: v.literal("deleted"), path: v.string() }),
  v.object({ seq: v.string(), at: v.string(), kind: v.literal("overflow") }),
]);

const AuditEntrySchema = v.object({
  at: v.string(),
  operationId: v.nullable(v.string()),
  path: v.nullable(v.string()),
  reason: v.string(),
  denied: v.literal(true),
});

const IntentSchema: v.GenericSchema<unknown, JournalIntent> = v.object({
  abs: v.string(),
  rel: v.string(),
  expectedVersion: v.union([v.literal("absent"), v.string()]),
  contentHash: v.string(),
  temp: v.string(),
  outcome: v.optional(MutationResultSchema),
});

const JournalSchema: v.GenericSchema<unknown, JournalState> = v.object({
  id: v.optional(v.string()),
  ops: v.record(v.string(), IntentSchema),
  seq: v.number(),
  events: v.array(FileEventSchema),
  audit: v.array(AuditEntrySchema),
});

/**
 * An empty journal, for a workspace that has not written one yet.
 *
 * @remarks
 * An absent journal file is a new workspace; this is the state it starts from.
 *
 * @internal
 */
export function emptyJournal(): JournalState {
  return { ops: {}, seq: 0, events: [], audit: [] };
}

/**
 * Parse a stored journal. A corrupt one throws instead of reading as empty.
 *
 * @param input - The parsed JSON from the journal file.
 * @returns A journal whose fields all passed validation.
 * @throws When the stored shape does not match, including an unreadable
 * `outcome` variant. The error is valibot's; opening a workspace with a corrupt
 * journal is a refusal, not a fresh start.
 *
 * @internal
 */
export function parseJournal(input: JsonValue): JournalState {
  return v.parse(JournalSchema, input);
}
