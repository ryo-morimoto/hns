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
 * The index's observation sink.
 *
 * @remarks
 * Every observation is built by {@link indexEntry}, so the entry has the one shape the worker
 * and the object write. `Session` passes the event log's append, which stores the entry in the
 * object's `obs_events`; the sink must not throw. A drain that fails on D1 does not call the
 * sink: the observation is dropped, because writing it would be the observation path failing
 * on the same outage the drain already recorded in `index_state`.
 */
export type IndexLog = (entry: ObsLogEntry) => void;

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

  constructor(options: SessionIndexOptions) {
    this.#session = options.session;
    this.#index = options.index;
    this.#workspaceId = options.workspaceId;
    this.#now = options.now;
    this.#log = options.log ?? ((entry) => console.error(JSON.stringify(entry)));
  }

  /**
   * Write the dirty rows and record the outcome.
   *
   * @param requestId - The correlation id of the request that triggered the drain.
   * @returns Nothing; every failure is recorded and retried by the next drain.
   */
  async drain(requestId: string): Promise<void> {
    let pending: PendingIndex;
    try {
      pending = await this.#session.pendingIndex(INDEX_DRAIN_BATCH);
    } catch {
      await this.#recordFailure(0);
      return;
    }
    const backlog = pending.entries.length + pending.remaining;
    if (pending.entries.length === 0) {
      await this.#recordSuccess();
      return;
    }
    const indexedAt = new Date(this.#now()).toISOString();
    // Read before writing: a drain runs after every turn, D1 bills every statement, and most
    // turns reindex a row the index already holds under the same version.
    let stale = pending.entries.map((entry) => indexRow(entry.conversation, indexedAt));
    try {
      const stored = await this.#index.read(this.#workspaceId);
      if (stored.length > 0) {
        const known = new Map(stored.map((row) => [row.id, row.updatedAt]));
        stale = stale.filter((row) => known.get(row.id) !== row.updatedAt);
      }
    } catch {
      await this.#recordFailure(backlog);
      return;
    }
    try {
      await this.#index.upsert(stale);
    } catch {
      await this.#recordFailure(backlog);
      return;
    }
    try {
      await this.#session.markIndexed(pending.entries.map((entry) => this.#markOf(entry)));
    } catch {
      // The rows are written; the dirty marks stay and the next drain rewrites them (idempotent).
      await this.#recordFailure(backlog);
      return;
    }
    if (pending.legacy > 0) {
      this.#log(
        indexEntry({
          event: "index.legacy_rows",
          requestId,
          at: this.#at(),
          level: "info",
          rows: pending.legacy,
        }),
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
      indexEntry({
        event: "index.rebuilt",
        requestId,
        at: this.#at(),
        level: "info",
        indexed,
        removed,
      }),
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

  /**
   * Record one failed drain: the state transition only.
   *
   * @remarks
   * The drain's failure observation is dropped rather than written: a failure means D1 is
   * unreachable, the same outage the state write is about to record, and a line for it would
   * add a row to the object after the turn's rows were measured. The state row already says what
   * failed (`d1_write_failed`) and how many rows wait.
   */
  async #recordFailure(backlog: number): Promise<void> {
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
        indexEntry({
          event: "index.state.failed",
          requestId: null,
          at: this.#at(),
          level: "warn",
        }),
      );
    }
  }
}
