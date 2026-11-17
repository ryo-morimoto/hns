import type { AgentSession, IndexMark, PendingIndex, PendingIndexEntry } from "@hns/agent/session";
import {
  INDEX_DRAIN_BATCH,
  isoTimestamp,
  type Conversation,
  type IsoTimestamp,
  type ObsLogEntry,
} from "@hns/core";
import type {
  ConversationIndex,
  ConversationIndexRow,
  IndexStateRow,
} from "@hns/store/conversation-index";
import { indexEntry } from "../obs/log.ts";

/** The one failure code recorded in `index_state`; the event name says what failed. */
const INDEX_WRITE_FAILED = "d1_write_failed";

/**
 * The index's log sink: one line of text.
 *
 * @remarks
 * The index used to build its own JSON. Every observation is now built by {@link indexEntry}, so
 * the entry has the one shape the worker and the object write; this sink still receives a line,
 * and `Session` passes the line to the same console sink as before, so the cost gate's turn
 * measurement is unchanged. Connecting the sink to the event log (an `ObsLogEntry` append) is
 * the data-lane decision about the measurement window.
 */
export type IndexLog = (line: string) => void;

/** The one-line text of one index observation, built as {@link indexEntry}. */
export function indexLine(entry: ObsLogEntry): string {
  return JSON.stringify(entry);
}

/** What the Session gives the index drain. */
export interface SessionIndexOptions {
  readonly session: AgentSession;
  readonly index: ConversationIndex;
  /** The Session object's name: one `index_state` row per workspace (D080: the project id). */
  readonly workspaceId: string;
  readonly now: () => number;
  readonly log?: IndexLog | undefined;
}

/** What a rebuild did. */
export interface ReindexResult {
  readonly indexed: number;
  readonly removed: number;
}

/**
 * Project one conversation onto its index row.
 *
 * @internal
 * @remarks
 * The writer fills `updatedAt` with the creation time when the conversation was never touched,
 * so ordering and the keyset cursor have one value and the monotonic upsert has a comparison.
 */
function indexRow(conversation: Conversation, indexedAt: string): ConversationIndexRow {
  return {
    id: conversation.id,
    projectId: conversation.project_id,
    title: conversation.title,
    createdAt: conversation.created_at,
    updatedAt: conversation.updated_at ?? conversation.created_at,
    archived: conversation.archived,
    deletedAt: conversation.deleted_at,
    indexedAt,
  };
}

/** Two index states say the same thing. */
function sameState(left: IndexStateRow, right: IndexStateRow): boolean {
  return (
    left.pending === right.pending &&
    left.lastSyncedAt === right.lastSyncedAt &&
    left.lastErrorCode === right.lastErrorCode &&
    left.lastErrorAt === right.lastErrorAt
  );
}

/**
 * The Session's D1 conversation index: drain the dirty rows, record the backlog, rebuild on demand.
 *
 * @remarks
 * The index is a copy; the object's metadata is the truth. A drain writes at most
 * {@link INDEX_DRAIN_BATCH} rows and clears each one with a compare-and-set, so a turn that
 * commits during the drain stays dirty. A D1 failure never fails the turn: the dirty mark
 * stays, the state row records the backlog, one line is logged, and the next RPC or alarm
 * retries (D078 U-04). `index_state` is written only on a transition, not every turn.
 */
export class SessionIndex {
  readonly #session: AgentSession;
  readonly #index: ConversationIndex;
  readonly #workspaceId: string;
  readonly #now: () => number;
  readonly #log: IndexLog;
  #state: IndexStateRow | undefined;
  #loaded = false;
  #attempts = 0;

  constructor(options: SessionIndexOptions) {
    this.#session = options.session;
    this.#index = options.index;
    this.#workspaceId = options.workspaceId;
    this.#now = options.now;
    this.#log = options.log ?? ((line) => console.error(line));
  }

  /**
   * Write the dirty rows and record the outcome.
   *
   * @param requestId - The correlation id of the request that triggered the drain.
   * @returns Nothing; every failure is recorded and retried by the next drain.
   */
  async drain(requestId: string): Promise<void> {
    this.#attempts += 1;
    let pending: PendingIndex;
    try {
      pending = await this.#session.pendingIndex(INDEX_DRAIN_BATCH);
    } catch (error) {
      await this.#recordFailure(requestId, error, 0, undefined);
      return;
    }
    const backlog = pending.entries.length + pending.remaining;
    if (pending.entries.length === 0) {
      await this.#recordSuccess();
      return;
    }
    const indexedAt = new Date(this.#now()).toISOString();
    try {
      await this.#index.upsert(
        pending.entries.map((entry) => indexRow(entry.conversation, indexedAt)),
      );
    } catch (error) {
      await this.#recordFailure(requestId, error, backlog, pending.entries[0]);
      return;
    }
    try {
      await this.#session.markIndexed(pending.entries.map((entry) => this.#markOf(entry)));
    } catch (error) {
      // The rows are written; the dirty marks stay and the next drain rewrites them (idempotent).
      await this.#recordFailure(requestId, error, backlog, pending.entries[0]);
      return;
    }
    if (pending.legacy > 0) {
      this.#log(
        indexLine(
          indexEntry({
            event: "index.legacy_rows",
            requestId,
            at: this.#at(),
            level: "info",
            rows: pending.legacy,
          }),
        ),
      );
    }
    await this.#recordPending(pending.remaining);
  }

  /**
   * Rebuild the index from the object's metadata.
   *
   * @param requestId - The correlation id of the request that triggered the rebuild.
   * @returns How many rows were written and how many stale rows were removed.
   * @throws Whatever the read or write throws: the caller answers 500 and nothing is reported
   * as a successful rebuild.
   *
   * @remarks
   * The object's own project is replaced exactly (upsert, then delete the rows it no longer
   * knows). A project that appears only in a legacy object's mixed metadata is upserted but
   * never deleted, because that project's own object may have written newer rows.
   */
  async reindex(requestId: string): Promise<ReindexResult> {
    const conversations = await this.#session.indexRows();
    const indexedAt = new Date(this.#now()).toISOString();
    const byProject = new Map<string, ConversationIndexRow[]>();
    for (const conversation of conversations) {
      const rows = byProject.get(conversation.project_id) ?? [];
      rows.push(indexRow(conversation, indexedAt));
      byProject.set(conversation.project_id, rows);
    }
    let indexed = 0;
    let removed = 0;
    for (const [projectId, rows] of byProject) {
      if (projectId === this.#workspaceId) {
        const result = await this.#index.replaceAll(projectId, rows);
        indexed += result.indexed;
        removed += result.removed;
      } else {
        await this.#index.upsert(rows);
        indexed += rows.length;
      }
    }
    const own = byProject.get(this.#workspaceId) ?? [];
    if (own.length === 0) {
      const result = await this.#index.replaceAll(this.#workspaceId, []);
      removed += result.removed;
    }
    await this.#session.markIndexed(
      conversations.map((conversation) => ({
        id: conversation.id,
        version: conversation.updated_at ?? conversation.created_at,
      })),
    );
    this.#state = {
      pending: 0,
      lastSyncedAt: indexedAt,
      lastErrorCode: null,
      lastErrorAt: null,
    };
    await this.#write(this.#state);
    this.#log(
      indexLine(
        indexEntry({
          event: "index.rebuilt",
          requestId,
          at: this.#at(),
          level: "info",
          indexed,
          removed,
        }),
      ),
    );
    return { indexed, removed };
  }

  /** The clock reading the index uses for its lines, branded as the log's timestamp. */
  #at(): IsoTimestamp {
    return isoTimestamp(new Date(this.#now()).toISOString());
  }

  /** The mark a drain clears after writing one entry. */
  #markOf(entry: PendingIndexEntry): IndexMark {
    return { id: entry.conversation.id, version: entry.version };
  }

  /**
   * Load the recorded state once, so a transition is the only thing written.
   *
   * @returns The state, or undefined when it could not be read (then nothing is written and
   * the next drain tries again).
   */
  async #current(): Promise<IndexStateRow | undefined> {
    if (this.#loaded) return this.#state;
    try {
      this.#state = await this.#index.state(this.#workspaceId);
      this.#loaded = true;
      return this.#state;
    } catch {
      return undefined;
    }
  }

  /** A drain that left nothing pending: record the clear only when it is a change. */
  async #recordSuccess(): Promise<void> {
    const current = await this.#current();
    if (this.#loaded && current !== undefined) {
      if (current.pending === 0 && current.lastErrorCode === null) return;
    }
    await this.#record({
      pending: 0,
      lastSyncedAt: new Date(this.#now()).toISOString(),
      lastErrorCode: null,
      lastErrorAt: null,
    });
  }

  /** A drain that left rows waiting: record the new backlog size. */
  async #recordPending(remaining: number): Promise<void> {
    const current = await this.#current();
    if (current !== undefined) {
      if (current.pending === remaining && current.lastErrorCode === null) return;
    }
    await this.#record({
      pending: remaining,
      lastSyncedAt:
        remaining === 0 ? new Date(this.#now()).toISOString() : (current?.lastSyncedAt ?? null),
      lastErrorCode: null,
      lastErrorAt: null,
    });
  }

  /** Record one failed drain: a structured line, then the state transition. */
  async #recordFailure(
    requestId: string,
    // The cause is not written (no allowlisted detail key); the event name and code say what failed.
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value is unknown by definition.
    error: unknown,
    backlog: number,
    entry: PendingIndexEntry | undefined,
  ): Promise<void> {
    this.#log(
      indexLine(
        indexEntry({
          event: "index.drain.failed",
          requestId,
          at: this.#at(),
          level: "warn",
          conversationId: entry?.conversation.id,
          attempt: this.#attempts,
          code: INDEX_WRITE_FAILED,
        }),
      ),
    );
    void error;
    await this.#recordFailureState(backlog, this.#at());
  }

  /** Write the failure state, keeping the first error time of a run of failures. */
  async #recordFailureState(backlog: number, at: IsoTimestamp): Promise<void> {
    const current = await this.#current();
    if (current !== undefined) {
      if (current.pending === backlog && current.lastErrorCode === INDEX_WRITE_FAILED) return;
    }
    await this.#record({
      pending: backlog,
      lastSyncedAt: current?.lastSyncedAt ?? null,
      lastErrorCode: INDEX_WRITE_FAILED,
      lastErrorAt: at,
    });
  }

  /** Write one state row, remembering it so the next drain can compare. */
  async #record(next: IndexStateRow): Promise<void> {
    const current = this.#state;
    if (this.#loaded && current !== undefined && sameState(current, next)) return;
    this.#state = next;
    this.#loaded = true;
    await this.#write(next);
  }

  /** One state write; a failure leaves the cached state unset so the next drain retries. */
  async #write(state: IndexStateRow): Promise<void> {
    try {
      await this.#index.writeState(this.#workspaceId, state, new Date(this.#now()).toISOString());
    } catch {
      this.#state = undefined;
      this.#loaded = false;
      this.#log(
        indexLine(
          indexEntry({
            event: "index.state.failed",
            requestId: null,
            at: this.#at(),
            level: "warn",
          }),
        ),
      );
    }
  }
}
