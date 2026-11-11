import * as v from "valibot";
import { IsoTimestampSchema, isoTimestamp, type IsoTimestamp } from "@hns/core";
import type { Sql } from "./sql.ts";

/**
 * The injection points a store is opened with.
 *
 * @remarks
 * Production callers leave both out. Tests pass a deterministic clock and id source so
 * ordering and ids are stable.
 */
export interface StoreHooks {
  /** Injected in tests so timestamps are stable. It must return an ISO timestamp. */
  readonly now?: (() => IsoTimestamp) | undefined;
  /** Injected in tests so ids are stable. Defaults to `crypto.randomUUID`. */
  readonly newId?: (() => string) | undefined;
}

/**
 * The database adapter and the small helpers every repository shares.
 *
 * @internal
 */
export interface StoreContext {
  readonly sql: Sql;
  /** The injected or default clock. Every call returns an ISO timestamp. */
  readonly now: () => IsoTimestamp;
  /** The injected or default id source. */
  readonly newId: () => string;
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
 * @param sql - The D1 adapter for this store.
 * @param hooks - The clock and id injections the store was opened with.
 * @returns The context bound to `sql`.
 * @throws ValiError if the clock returns a value that is not an ISO timestamp.
 */
export function createContext(sql: Sql, hooks: StoreHooks): StoreContext {
  const source = hooks.now ?? (() => isoTimestamp(new Date().toISOString()));
  // Fail at open, before any write: every repository assumes an ISO clock. Cache the first
  // tick so a sequence clock's first write still sees the value checked at open.
  let first: IsoTimestamp | undefined = v.parse(IsoTimestampSchema, source());
  return {
    sql,
    now: () => {
      if (first !== undefined) {
        const value = first;
        first = undefined;
        return value;
      }
      return v.parse(IsoTimestampSchema, source());
    },
    newId: hooks.newId ?? (() => crypto.randomUUID()),
  };
}
