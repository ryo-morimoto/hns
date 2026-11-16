import type { DurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";

/** Values the Durable Object SQL binding accepts and returns. */
type SqlValue = ArrayBuffer | string | number | null;

/** The part of `DurableObjectState` the unit layer models. */
export interface TestSqliteState {
  readonly storage: DurableObjectSqliteStorage;
  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
}

/** An open in-memory state and its closer. */
export interface OpenSqliteState {
  readonly state: TestSqliteState;
  close(): void;
}

/** The values node:sqlite can return; its own SQLOutputValue is not exported. */
type SqlRowValue = null | number | bigint | string | Uint8Array;

/** One node:sqlite value in the DO binding's shape: blobs as ArrayBuffer, the rest as-is. */
function normalize(value: SqlRowValue): SqlValue {
  return value instanceof Uint8Array
    ? new Uint8Array(value).buffer
    : v.parse(v.union([v.null(), v.string(), v.number()]), value);
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
  const state: TestSqliteState = {
    storage: {
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
    },
    blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T> {
      return run();
    },
  };
  return { state, close: () => db.close() };
}
