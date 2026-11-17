import { openStore, type D1Binding, type Store } from "@hns/store";
import type { WorkerEnv } from "./env.ts";

/** The control database is not configured or could not be opened. */
export class StoreUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreUnavailableError";
  }
}

const STORES = new WeakMap<D1Binding, Promise<Store>>();

/**
 * The D1 store for this isolate, opened once.
 *
 * @param env - The Worker environment carrying the `DB` binding.
 * @returns The shared store; the caller does not close it.
 * @throws StoreUnavailableError when the binding is missing or the open fails. A rejected open
 * is dropped from the cache so the next request retries.
 *
 * @remarks
 * `openStore` applies migrations, so opening once per isolate is what keeps a request from
 * paying for them. 0149 replaces this memo with a provider that counts the opens.
 */
export async function storeFor(env: WorkerEnv): Promise<Store> {
  const db = env.DB;
  if (db === undefined) {
    throw new StoreUnavailableError("The database binding is not configured.");
  }
  const cached = STORES.get(db);
  if (cached !== undefined) return cached;
  const opened = openOnce(db);
  STORES.set(db, opened);
  return opened;
}

/** Open once and drop the failed attempt so the next request retries. */
async function openOnce(db: D1Binding): Promise<Store> {
  try {
    return await openStore({ d1: db });
  } catch (error) {
    STORES.delete(db);
    throw new StoreUnavailableError("The database could not be opened.", { cause: error });
  }
}
