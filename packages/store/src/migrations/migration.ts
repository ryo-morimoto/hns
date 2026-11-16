/**
 * One forward step of the store schema.
 *
 * @remarks
 * `version` is recorded in `schema_migrations`; versions are 1..n, ascending, with no gaps.
 * `sql` holds statements separated by `;`: no trigger body and no semicolon inside a literal,
 * because the runner splits on `;`.
 */
export interface Migration {
  readonly version: number;
  readonly sql: string;
}
