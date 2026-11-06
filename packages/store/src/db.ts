import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";

/** How to open the store. `path` is `:memory:` in tests and a file in the app. */
export interface StoreOptions {
  readonly path: string;
  /** Injected in tests so ids and timestamps are stable. */
  readonly now?: (() => string) | undefined;
  readonly newId?: (() => string) | undefined;
}

/** The connection and the small helpers every repository shares. */
export interface StoreContext {
  readonly db: DatabaseSync;
  readonly now: () => string;
  readonly newId: () => string;
  transaction<T>(run: () => T): T;
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/** One write transaction. Repositories do not nest these. */
export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = run();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const userVersionSchema = v.object({ user_version: v.number() });
export const isoTimestampSchema = v.pipe(v.string(), v.isoTimestamp());

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return row === undefined ? 0 : v.parse(userVersionSchema, row).user_version;
}

export function writeUserVersion(db: DatabaseSync, version: number): void {
  db.exec("PRAGMA user_version = " + Math.trunc(version));
}

export function createContext(db: DatabaseSync, options: StoreOptions): StoreContext {
  const source = options.now ?? (() => new Date().toISOString());
  // Fail at open, before any write: every repository assumes an ISO clock. Cache the first
  // tick so a sequence clock's first write still sees the value checked at open.
  let first: string | undefined = v.parse(isoTimestampSchema, source());
  return {
    db,
    now: () => {
      if (first !== undefined) {
        const value = first;
        first = undefined;
        return value;
      }
      return v.parse(isoTimestampSchema, source());
    },
    newId: options.newId ?? randomUUID,
    transaction: (run) => transaction(db, run),
  };
}
