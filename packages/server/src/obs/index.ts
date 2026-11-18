/**
 * The observability surface a Worker project mounts: the event log and its internal RPC.
 *
 * @remarks
 * The deploy's Worker reaches the Session object with these (0249's local project mounts the same
 * pair a test of the simulator needs). Exported as their own subpath because the entrypoint of a
 * Worker is not `index.ts`, and because the edge's own imports of the log stay inside the edge.
 */
export { createObsStore } from "./store.ts";
export type { ObsListQuery, ObsStore, ObsStoreOptions, ObsStorage } from "./store.ts";
export { handleObsRpc } from "./api.ts";
