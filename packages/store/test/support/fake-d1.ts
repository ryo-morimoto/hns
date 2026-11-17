/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns,
   anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type --
   This adapter is the D1 boundary: rows and bindings are unknown until a caller parses them. */
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";
import type { D1Binding } from "../../src/sql.ts";

/**
 * A D1 binding over an in-memory `node:sqlite` database.
 *
 * @remarks
 * The SQL, constraints, and migrations of whichever package under test run for real here; only
 * D1's wire shape (rows under `results`, changes under `meta.changes`) is emulated. A scenario
 * that needs workerd stays in `test/integration/`.
 *
 * It lives in `@hns/store`'s support because `D1Binding` is the store's own boundary type. A
 * server test that needs a control database imports this; the store never imports a server test
 * file, which would point the dependency backwards (`docs/packages.md`).
 */
export interface FakeD1 {
  readonly db: D1Binding;
  /** Run a script (several statements) outside the binding, for setup and assertions. */
  exec(sql: string): void;
  close(): void;
}

/** A value this adapter passes to node:sqlite. */
type SqlValue = string | number | null | ArrayBuffer;

/** A value node:sqlite may return. */
const RawSchema = v.union([v.null(), v.number(), v.bigint(), v.string(), v.instance(Uint8Array)]);

/** A value node:sqlite accepts as a binding. */
type BoundValue = string | number | null | Uint8Array;

/** Convert a node:sqlite value to the shape D1 returns: numbers and text as-is, blobs as ArrayBuffer. */
function normalize(value: unknown): unknown {
  const raw = v.parse(RawSchema, value);
  if (raw instanceof Uint8Array) return new Uint8Array(raw).buffer;
  if (typeof raw === "bigint") return Number(raw);
  return raw;
}

/** One row in D1's shape. */
function toRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(value)]));
}

/** Bind values in the shape node:sqlite accepts. */
function parameters(values: readonly SqlValue[]): BoundValue[] {
  return values.map((value) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value));
}

/**
 * Open the fake D1.
 *
 * @returns The binding, a script runner, and the closer. Every call opens its own database,
 * so a test never shares state with another one.
 */
export function openFakeD1(): FakeD1 {
  const database = new DatabaseSync(":memory:");
  const statementFor = (sql: string, values: readonly SqlValue[] = []) => {
    const bound = {
      bind: (...next: SqlValue[]) => statementFor(sql, next),
      all: async () => ({
        results: database
          .prepare(sql)
          .all(...parameters(values))
          .map((row) => toRow(v.parse(v.record(v.string(), v.unknown()), row))),
      }),
      first: async () => {
        const rows = database
          .prepare(sql)
          .all(...parameters(values))
          .map((row) => toRow(v.parse(v.record(v.string(), v.unknown()), row)));
        const first = rows[0];
        return first === undefined ? null : first;
      },
      run: async () => ({
        meta: { changes: Number(database.prepare(sql).run(...parameters(values)).changes) },
      }),
    };
    return bound;
  };
  return {
    db: {
      prepare: (sql: string) => statementFor(sql),
      batch: async (statements) => {
        database.exec("BEGIN");
        try {
          const results: Array<{ results: readonly unknown[] }> = [];
          for (const statement of statements) {
            results.push({ results: (await statement.all()).results ?? [] });
          }
          database.exec("COMMIT");
          return results;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    },
    exec: (sql) => {
      database.exec(sql);
    },
    close: () => {
      database.close();
    },
  };
}
