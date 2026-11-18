/**
 * The observability surface a Worker project mounts: the event log and its internal RPC.
 *
 * @remarks
 * A Worker project mounts the same pair the deploy's Session object does (a test of the local
 * dev server needs it). Exported as their own subpath because a Worker's entrypoint is not
 * `index.ts`, and because the edge's own imports of the log stay inside the edge.
 */
export { createObsStore } from "./store.ts";
export type { ObsListQuery, ObsStore, ObsStoreOptions, ObsStorage } from "./store.ts";
export { handleObsRpc } from "./api.ts";
