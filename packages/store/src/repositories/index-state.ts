import type { StoreContext } from "../db.ts";
import { readIndexState } from "../conversation-index/state.ts";
import type { IndexStateRow } from "../conversation-index/model.ts";

/**
 * The D1 conversation index's recorded state, one row per workspace.
 *
 * @remarks
 * This is the read the UI and an operator use to tell a delayed index from an empty one. A
 * workspace with no row yet reads as zero pending and no error, not as an outage.
 */
export interface IndexStateRepository {
  /** The workspace's state; zeroed totals when no drain has recorded one. */
  read(workspaceId: string): Promise<IndexStateRow>;
}

/** The state an unrecorded workspace reads as: no backlog and no failure. */
const EMPTY: IndexStateRow = {
  pending: 0,
  lastSyncedAt: null,
  lastErrorCode: null,
  lastErrorAt: null,
};

/**
 * Build the index-state repository over `context`.
 *
 * @internal
 */
export function indexStateRepository(context: StoreContext): IndexStateRepository {
  return {
    read: async (workspaceId) => (await readIndexState(context.sql, workspaceId)) ?? { ...EMPTY },
  };
}
