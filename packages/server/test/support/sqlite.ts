import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";

/** Values the Durable Object SQL binding accepts and returns. */
type SqlValue = ArrayBuffer | string | number | null;

/** The DO binding's values as `node:sqlite` accepts them: a blob as its bytes. */
function sqlBindings(
  bindings: readonly (ArrayBuffer | string | number | null)[],
): (Uint8Array | string | number | null)[] {
  return bindings.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
}

/**
 * The part of `DurableObjectState` the unit layer models.
 *
 * @remarks
 * `waitUntil` is part of the real state (0272n made it required): the work that follows an answer
 * is kept alive by it, so a test state has one too. The promises are collected and `drain` awaits
 * them, which is how a test sees the push and the Change finish without a real isolate.
 */
export interface TestSqliteState {
  readonly storage: DurableObjectSqliteStorage;
  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<void>): void;
  /** Wait for every promise handed to `waitUntil` so far. */
  drain(): Promise<void>;
}

/** An open in-memory state and its closer. */
export interface OpenSqliteState {
  readonly state: TestSqliteState;
  /** Run a statement outside the object, for setup (a table another issue owns) and assertions. */
  sql(query: string, ...bindings: readonly (ArrayBuffer | string | number | null)[]): void;
  /** Read rows outside the object, for an assertion about what was stored. */
  rows(
    query: string,
    ...bindings: readonly (ArrayBuffer | string | number | null)[]
  ): Record<string, SqlValue>[];
  close(): void;
}

/** The values node:sqlite can return; its own SQLOutputValue is not exported. */
type SqlRowValue = null | number | bigint | string | Uint8Array;

/** One node:sqlite value in the DO binding's shape: blobs as ArrayBuffer, the rest as-is. */
function normalize(value: SqlRowValue): SqlValue {
  // node:sqlite hands a BLOB back as a Uint8Array with ArrayBuffer storage; the binding hands the
  // object an ArrayBuffer. A Uint8Array that views another array's storage (a slice of a pooled
  // buffer) is still the blob, so the test copies those too, as the binding does.
  if (value instanceof Uint8Array) {
    return value.buffer instanceof ArrayBuffer &&
      value.byteOffset === 0 &&
      value.byteLength === value.buffer.byteLength
      ? value.buffer
      : new Uint8Array(value).buffer;
  }
  return v.parse(v.union([v.null(), v.string(), v.number()]), value);
}

/** One node:sqlite row in the DO binding's shape: integers and text as-is, blobs as ArrayBuffer. */
function toRow(row: Record<string, SqlRowValue>): Record<string, SqlValue> {
  const pairs = Object.entries(row).map(([key, value]): [string, SqlValue] => [
    key,
    normalize(value),
  ]);
  return Object.fromEntries(pairs);
}

/**
 * A SQLite-backed `DurableObjectState` for the unit layer.
 *
 * @remarks
 * The real object runs one transaction at a time and retries on conflict; `queue` models that
 * contract so a concurrent read-check-write is actually serialized here. The schema and SQL are
 * real `node:sqlite`, so a wrong column or constraint fails the test. Blobs come back as
 * `ArrayBuffer`, the shape the DO returns, so callers parse what production returns.
 */
export function openSqliteState(): OpenSqliteState {
  const db = new DatabaseSync(":memory:");
  let queue: Promise<void> = Promise.resolve();
  const storage: DurableObjectSqliteStorage = {
    sql: {
      exec(query, ...bindings) {
        const values = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        const rows = db
          .prepare(query)
          .all(...values)
          .map(toRow);
        let index = 0;
        return {
          next() {
            const value = rows[index];
            if (value === undefined) return { done: true as const };
            index += 1;
            return { value };
          },
          toArray() {
            return rows;
          },
        };
      },
    },
    transaction<T>(run: () => Promise<T>): Promise<T> {
      const result = queue.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const value = await run();
          db.exec("COMMIT");
          return value;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  const blockConcurrencyWhile = <T>(run: () => Promise<T>): Promise<T> => run();
  const kept: Promise<void>[] = [];
  const state: TestSqliteState = {
    storage,
    blockConcurrencyWhile,
    waitUntil(promise: Promise<void>) {
      kept.push(promise);
    },
    async drain() {
      await Promise.all(kept);
    },
  };
  return {
    state,
    sql(query, ...bindings) {
      db.prepare(query).run(...sqlBindings(bindings));
    },
    rows(query, ...bindings) {
      return db
        .prepare(query)
        .all(...sqlBindings(bindings))
        .map(toRow);
    },
    close: () => db.close(),
  };
}
