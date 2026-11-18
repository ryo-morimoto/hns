import { openStore, type D1Binding, type Store } from "@hns/store";
import type { Project, ProjectId } from "@hns/core";
import * as v from "valibot";
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
 * Give one binding its own open store, not this isolate's shared one.
 *
 * @param db - The control database binding.
 *
 * @remarks
 * The memo above is keyed by the binding, and two tests that stand up separate databases with
 * the same adapter would otherwise share the first one opened. A test that wants the real open
 * (migrations, the default project) calls this; production never does.
 * @internal
 */
export function forgetStore(db: D1Binding): void {
  STORES.delete(db);
}

/**
 * The D1 store for this isolate, opened once.
 *
 * @param env - The Worker environment carrying the `DB` binding.
 * @returns The shared store; the caller does not close it.
 * @throws StoreUnavailableError when the binding is missing or the open fails. A rejected open
 * is dropped from the cache so the next request retries.
 * @throws ValiError when the stored default project is corrupt; that is a defect, not an outage.
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
    // A corrupt row means the data disagrees with the model; rounding it into "the database is
    // unavailable" would turn a defect into a retryable 503. It stays a ValiError (a 500).
    if (error instanceof v.ValiError) throw error;
    throw new StoreUnavailableError("The database could not be opened.", { cause: error });
  }
}

/**
 * Look one project up in D1.
 *
 * @param env - The Worker environment carrying the `DB` binding.
 * @param projectId - The project's raw id, already parsed.
 * @returns The project, or undefined when no row has that id.
 * @throws StoreUnavailableError when the database is missing or cannot be opened.
 * @throws ValiError when a stored project row is corrupt.
 *
 * @remarks
 * The one project lookup the faces share, so `/ws`, the file face, and the GraphQL resolvers
 * agree on what "this project exists" means. It never creates anything: an id with no row is
 * undefined, and the caller decides the refusal.
 */
export async function projectFor(
  env: WorkerEnv,
  projectId: ProjectId,
): Promise<Project | undefined> {
  const store = await storeFor(env);
  try {
    return await store.projects.get(projectId);
  } catch (error) {
    // A read that failed is an outage (the caller may retry); a row that failed to parse is a
    // defect and stays a ValiError.
    if (error instanceof v.ValiError) throw error;
    throw new StoreUnavailableError("The project could not be read.", { cause: error });
  }
}
