import type { MutationResult } from "@hns/core";

/** The content hash recorded for a version: "sha256:<hex>". */
export type Version = string;

/** What a write expects to replace: a version, or nothing when the name is free. */
export type ExpectedVersion = Version | "absent";

export const FILE_EVENT_KINDS = ["created", "changed", "deleted", "overflow"] as const;
export type FileEventKind = (typeof FILE_EVENT_KINDS)[number];

interface FileEventStamp {
  /** Journal sequence number, as a decimal string. */
  readonly seq: string;
  /** ISO 8601 (UTC). */
  readonly at: string;
}

/** One entry of the journal's event log. Produced by the workspace; consumed by watchers. */
export type FileEvent =
  | (FileEventStamp & {
      readonly kind: "created" | "changed";
      readonly path: string;
      readonly version: Version;
    })
  | (FileEventStamp & { readonly kind: "deleted"; readonly path: string })
  | (FileEventStamp & { readonly kind: "overflow" });

/** What a new event carries; the journal adds seq and at. */
export type FileEventDraft =
  | { readonly kind: "created" | "changed"; readonly path: string; readonly version: Version }
  | { readonly kind: "deleted"; readonly path: string }
  | { readonly kind: "overflow" };

/** A refused operation, kept in the journal for the audit trail. */
export interface AuditEntry {
  readonly at: string;
  readonly operationId: string | null;
  readonly path: string | null;
  readonly reason: string;
  readonly denied: true;
}

/** A mutation the journal has accepted but not yet settled. */
export interface JournalIntent {
  abs: string;
  rel: string;
  expectedVersion: ExpectedVersion;
  contentHash: Version;
  temp: string;
  outcome?: MutationResult | undefined;
}

/** The whole journal. Stored outside the root; parsed when the workspace opens. */
export interface JournalState {
  id?: string | undefined;
  ops: Record<string, JournalIntent>;
  seq: number;
  events: FileEvent[];
  audit: AuditEntry[];
}
