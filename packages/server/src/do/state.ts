import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

/** The alarm methods the Session uses; a subset of `DurableObjectStorage`. */
export interface AlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/**
 * The slice of `DurableObjectState` the Session uses.
 *
 * @remarks
 * Structural on purpose: the class does not extend `DurableObject`, so the runtime and the
 * tests provide this shape without a Workers type dependency.
 */
export interface SessionState {
  readonly storage: DurableObjectSqliteStorage & AlarmStorage;
  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
  abort(reason?: string): void;
}

/** The bindings the Session reads. It never reads a secret. */
export interface SessionEnv {
  readonly HNS_ENV?: string | undefined;
  readonly HNS_MODEL?: string | undefined;
}
