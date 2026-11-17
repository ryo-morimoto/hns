/* oxlint-disable anti-slop/no-unknown-returns --
   This is the D1 boundary: rows stay unknown until the caller runs the matching parse*.
*/
/**
 * Values the store binds into SQL.
 *
 * @remarks
 * `ArrayBuffer` is a BLOB column's value. The D1 binding accepts it, and the adapter parses rows
 * at each caller's boundary (`machines.public_key` is the first column that stores bytes).
 */
type SqlValue = string | number | null | ArrayBuffer;

/** One parameterised statement, executed by {@link Sql.batch}. */
export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly SqlValue[] | undefined;
}

/** The part of a D1 result row set the store reads. */
interface D1ResultLike {
  readonly results?: readonly unknown[] | undefined;
  readonly meta?: { readonly changes?: number | undefined } | undefined;
}

/** The part of a D1 prepared statement the store uses. */
interface D1StatementLike {
  bind(...values: SqlValue[]): D1StatementLike;
  all(): Promise<D1ResultLike>;
  first(): Promise<unknown>;
  run(): Promise<D1ResultLike>;
}

/**
 * The subset of the Cloudflare D1 binding the store depends on.
 *
 * @remarks
 * Structural rather than the Workers type so the package does not need
 * `@cloudflare/workers-types` at build time, and so tests can pass miniflare's binding.
 */
export interface D1Binding {
  prepare(sql: string): D1StatementLike;
  batch(statements: readonly D1StatementLike[]): Promise<readonly D1ResultLike[]>;
}

/**
 * The normalised D1 surface every repository uses.
 *
 * @remarks
 * D1 returns rows under `results`, changes under `meta.changes`, and null for a missed
 * `first()`. The adapter hides those shapes and refuses calls after {@link Sql.close}.
 */
export interface Sql {
  /** Every row of `sql`; an empty array when there are none. */
  all(sql: string, params?: readonly SqlValue[]): Promise<readonly unknown[]>;
  /** The first row of `sql`, or `undefined` when it returns none. */
  get(sql: string, params?: readonly SqlValue[]): Promise<unknown>;
  /** Execute one write and return the number of changed rows. */
  run(sql: string, params?: readonly SqlValue[]): Promise<number>;
  /**
   * Execute every statement in one D1 batch.
   *
   * @remarks
   * A batch is atomic: one failure rolls every statement back. That is the only
   * transaction D1 offers, so callers use it for multi-statement writes and for a
   * read that must see the writes before it.
   *
   * @returns The rows of each statement, in order; writes return an empty array.
   */
  batch(statements: readonly SqlStatement[]): Promise<readonly (readonly unknown[])[]>;
  /** Refuse further calls; D1 itself has nothing to close. */
  close(): Promise<void>;
}

/**
 * Bind the normalising adapter to a D1 binding.
 *
 * @param db - A D1 binding (the Worker's `env.DB` or miniflare's database).
 * @returns The adapter; the caller owns it and should call {@link Sql.close}.
 */
export function createSql(db: D1Binding): Sql {
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new Error("store is closed");
  };

  const bind = (sql: string, params: readonly SqlValue[]): D1StatementLike => {
    const statement = db.prepare(sql);
    return params.length === 0 ? statement : statement.bind(...params);
  };

  return {
    async all(sql, params = []) {
      assertOpen();
      return (await bind(sql, params).all()).results ?? [];
    },
    async get(sql, params = []) {
      assertOpen();
      return (await bind(sql, params).first()) ?? undefined;
    },
    async run(sql, params = []) {
      assertOpen();
      return (await bind(sql, params).run()).meta?.changes ?? 0;
    },
    async batch(statements) {
      assertOpen();
      if (statements.length === 0) return [];
      const results = await db.batch(
        statements.map((statement) => bind(statement.sql, statement.params ?? [])),
      );
      return results.map((result) => result.results ?? []);
    },
    async close() {
      closed = true;
    },
  };
}
