import * as v from "valibot";

/** A value the Durable Object SQL binding accepts and returns. */
type SqlValue = ArrayBuffer | string | number | null;

/**
 * The slice of a Durable Object's SQLite storage the meter reads.
 *
 * @remarks
 * Structural on purpose: both the Workers runtime and the Node test state provide it, and the
 * meter never writes.
 */
export interface TurnStorage {
  readonly sql: {
    exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, SqlValue>[] };
  };
}

const TableSchema = v.object({ name: v.string() });
const CountSchema = v.object({ count: v.number() });

/**
 * Count the rows stored in the object's SQLite.
 *
 * @param storage - The object's storage.
 * @returns The sum of `COUNT(*)` over every table, including the runtime's own tables.
 *
 * @throws ValiError when a row of `sqlite_master` or a count is not the expected shape.
 * @throws Whatever the SQL layer throws; the caller treats the measurement as unavailable.
 *
 * @remarks
 * The turn's DO row cost is the difference between this count before and after the turn. It
 * counts appended rows, not updated ones, so it is a lower bound on the rows billed; a change
 * in the order of magnitude (a row per token) still shows. Table names come from
 * `sqlite_master` and are quoted, so a name with a quote cannot change the statement.
 */
export function countStoredRows(storage: TurnStorage): number {
  const tables = storage.sql
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .toArray()
    .map((row) => v.parse(TableSchema, row).name);
  let total = 0;
  for (const table of tables) {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    const counted = storage.sql.exec("SELECT COUNT(*) AS count FROM " + quoted).toArray();
    const first = counted[0];
    if (first === undefined) throw new Error("a row count returned no row");
    total += v.parse(CountSchema, first).count;
  }
  return total;
}
