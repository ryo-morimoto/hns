import type { Store } from "../store.ts";

/**
 * The two questions the Workspace object asks about a run's Trail (0272n).
 *
 * @remarks
 * The object writes a completed checkpoint's Change and does not touch D1 itself (D049), so the
 * Worker hands it an object with these two methods, answered by the store's Trail repository
 * (`trailLookupFor`). Declared here so the store does not have to read a type from the server: the
 * server's `TrailLookup` is this shape, and the two are checked against each other where they
 * meet (the Worker builds it, the object takes it).
 */
export interface RunTrailLink {
  /** The Trail a run is linked to, or undefined when no Trail is. A read, for a caller asking. */
  trailForRun(runId: string): Promise<string | undefined>;
  /**
   * Open the Trail this run is linked to, as one operation.
   *
   * @returns The Trail's id and the repository to write its Change with, or undefined when the
   * run is linked to no Trail.
   *
   * @remarks
   * The link is read **inside** the operation that returns the repository, so the Trail that is
   * found is the Trail the Change is written to: one call, one store.
   */
  lookupForRun(runId: string): Promise<
    | {
        readonly trailId: string;
        readonly trails: Store["trails"];
      }
    | undefined
  >;
}

/**
 * The Trail lookup the Workspace object is started with.
 *
 * @remarks
 * The object writes a completed checkpoint's Change and does not touch D1 itself (D049), so the
 * Worker hands it this lookup: "which Trail is this run linked to, and if there is one, the
 * repository to write its Change with".
 *
 * **The object's use is one operation.** The store is opened for the call and closed after it,
 * because the object's work finishes inside the operation: a store held across Durable Object
 * events would outlive the isolate that opened it, and answering the link through one call and
 * writing the Change through another would be two stores.
 *
 * `trailForRun` stays available on its own, because "which Trail is this run linked to" is the
 * question to ask when debugging a run. A deployment with no database answers undefined for
 * every run: no run is linked to a Trail, so no Change is written and no checkpoint fails for it.
 *
 * Every failure is the caller's to swallow: the Workspace logs it, and the checkpoint it already
 * answered is unaffected.
 *
 * @param open - How the control database is opened, or undefined when there is none; the Worker
 * passes its own `storeFor`, so the lookup reads the store the rest of the edge reads.
 */
/** What the lookup reads of the store: the Trail repository, and the close it always calls. */
export type TrailStoreView = Pick<Store, "trails" | "close">;

/**
 * The Trail lookup, over an opener the Worker supplies.
 *
 * @param open - How the control database is opened, or undefined when there is none; the Worker
 * passes an opener over the store the rest of the edge reads, and a test may pass a view of one.
 * @returns The lookup the Workspace object is started with.
 */
export function trailLookupFor(open: (() => Promise<TrailStoreView>) | undefined): RunTrailLink {
  return {
    async trailForRun(runId) {
      return await withStore(open, (store) => store.trails.trailForRun(runId));
    },
    async lookupForRun(runId) {
      return await withStore(open, async (store) => {
        const trailId = await store.trails.trailForRun(runId);
        return trailId === undefined ? undefined : { trailId, trails: store.trails };
      });
    },
  };
}

/**
 * Open the store, run the work, and always close it.
 *
 * @param open - The opener, or undefined when the deployment has no database.
 * @param work - The work; it must finish before it returns, because the store is closed after.
 * @returns The work's value, or undefined when there is no database to open.
 */
async function withStore<T>(
  open: (() => Promise<TrailStoreView>) | undefined,
  work: (store: TrailStoreView) => Promise<T>,
): Promise<T | undefined> {
  if (open === undefined) return undefined;
  const store = await open();
  try {
    return await work(store);
  } finally {
    await store.close();
  }
}
