import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import { IsoTimestampSchema, isoTimestamp, type IsoTimestamp } from "@hns/core";

/**
 * How to open the store.
 *
 * @remarks
 * `path` is `:memory:` in tests and a file in the app. `now` and `newId` are the only
 * injection points; production callers leave them out.
 */
export interface StoreOptions {
  /** A file path, or `:memory:` for a throwaway database. */
  readonly path: string;
  /** Injected in tests so timestamps are stable. It must return an ISO timestamp. */
  readonly now?: (() => IsoTimestamp) | undefined;
  /** Injected in tests so ids are stable. Defaults to `crypto.randomUUID`. */
  readonly newId?: (() => string) | undefined;
}

/**
 * The connection and the small helpers every repository shares.
 *
 * @internal
 */
export interface StoreContext {
  readonly db: DatabaseSync;
  /** The injected or default clock. Every call returns an ISO timestamp. */
  readonly now: () => IsoTimestamp;
  /** The injected or default id source. */
  readonly newId: () => string;
  /** Run `run` in one transaction; see {@link transaction}. */
  transaction<T>(run: () => T): T;
}

/**
 * Open a SQLite connection with the pragmas the store depends on.
 *
 * @internal
 * @remarks
 * Foreign keys are always ON, so deleting a project cascades. A file database also uses
 * WAL, which lets readers proceed while one writer holds the transaction; `:memory:` keeps
 * the default journal because WAL has nothing to do there.
 *
 * @param path - A file path, or `:memory:`.
 * @returns The open connection. The caller owns it and must close it.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/**
 * Run `run` inside one write transaction.
 *
 * @internal
 * @remarks
 * `BEGIN IMMEDIATE` takes the write lock up front, so a competing writer fails instead of
 * deadlocking later. The transaction commits when `run` returns and rolls back when it
 * throws. Repositories never nest these: one repository call is one transaction.
 *
 * @param db - The connection to write on.
 * @param run - The work to perform; its return value is passed through.
 * @returns The value `run` returned, after the commit.
 * @throws Whatever `run` threw, after the rollback.
 */
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

/**
 * Read the schema version from `PRAGMA user_version`.
 *
 * @internal
 * @remarks
 * A database that has never been migrated reports 0.
 *
 * @param db - The connection to read.
 * @returns The stored version, or 0 when unset.
 * @throws ValiError if the pragma returns a row that is not a single number.
 */
export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return row === undefined ? 0 : v.parse(userVersionSchema, row).user_version;
}

/**
 * Record the schema version in `PRAGMA user_version`.
 *
 * @internal
 * @remarks
 * SQLite only accepts an integer here, so the value is truncated. Migrations move this
 * forward only; nothing writes a lower version.
 *
 * @param db - The connection to write.
 * @param version - The version to store.
 */
export function writeUserVersion(db: DatabaseSync, version: number): void {
  db.exec("PRAGMA user_version = " + Math.trunc(version));
}

/**
 * Build the context every repository closes over.
 *
 * @internal
 * @remarks
 * The clock is parsed as an ISO timestamp at open and again on every tick, so a bad injected
 * clock fails before any write. The value parsed at open is cached for the first tick, so a
 * sequence clock's first write sees exactly the value that was checked.
 *
 * @param db - An open connection.
 * @param options - The options the store was opened with.
 * @returns The context bound to `db`.
 * @throws ValiError if the clock returns a value that is not an ISO timestamp.
 */
export function createContext(db: DatabaseSync, options: StoreOptions): StoreContext {
  const source = options.now ?? (() => isoTimestamp(new Date().toISOString()));
  // Fail at open, before any write: every repository assumes an ISO clock. Cache the first
  // tick so a sequence clock's first write still sees the value checked at open.
  let first: IsoTimestamp | undefined = v.parse(IsoTimestampSchema, source());
  return {
    db,
    now: () => {
      if (first !== undefined) {
        const value = first;
        first = undefined;
        return value;
      }
      return v.parse(IsoTimestampSchema, source());
    },
    newId: options.newId ?? randomUUID,
    transaction: (run) => transaction(db, run),
  };
}
