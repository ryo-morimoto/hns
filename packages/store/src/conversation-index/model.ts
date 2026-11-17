import * as v from "valibot";

/**
 * One conversation row as the Session writes it into the D1 index.
 *
 * @remarks
 * This is the storage shape of the index, not the public conversation model: readers get the
 * model after `parseConversation`, and `indexedAt` stays here. `updatedAt` is never null —
 * the writer fills a conversation that was never touched with its creation time, so ordering and
 * the keyset cursor have one value.
 */
export interface ConversationIndexRow {
  /** The pi-durable conversation id, local to the project's Session object. */
  readonly id: string;
  /** The conversation's own project, not the Session object's name (a legacy object can mix). */
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  /** ISO 8601; the conversation's creation time when it was never touched. */
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly deletedAt: string | null;
  /** ISO 8601 of the write that put this row in the index. */
  readonly indexedAt: string;
}

/** The index of one stored conversation: what a drain compares before it writes. */
export interface IndexedConversation {
  readonly id: string;
  /** The stored activity; null only for a row an older build wrote. */
  readonly updatedAt: string | null;
}

/** The recorded state of one workspace's index. */
export interface IndexStateRow {
  /** Conversations that have not reached D1; zero when the index is current. */
  readonly pending: number;
  /** ISO 8601 of the last drain that left nothing pending. */
  readonly lastSyncedAt: string | null;
  /** The closed failure code of the last failed drain. */
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
}

/** The `index_state` row before its snake_case columns are mapped to the model. */
const indexStateRowSchema = v.object({
  pending: v.pipe(v.number(), v.integer(), v.minValue(0)),
  last_synced_at: v.nullable(v.string()),
  last_error_code: v.nullable(v.string()),
  last_error_at: v.nullable(v.string()),
});

/**
 * The `index_state` row.
 *
 * @remarks
 * An empty workspace has no row, and the reader fills zeroed totals; a stored row that does not
 * match (a negative backlog, a missing column) throws instead of being read as "in sync".
 */
export const IndexStateRowSchema: v.GenericSchema<unknown, IndexStateRow> = v.pipe(
  indexStateRowSchema,
  v.transform((row): IndexStateRow => ({
    pending: row.pending,
    lastSyncedAt: row.last_synced_at,
    lastErrorCode: row.last_error_code,
    lastErrorAt: row.last_error_at,
  })),
);
