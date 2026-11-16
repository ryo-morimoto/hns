import { migration0001 } from "./0001-initial.ts";
import { migration0002 } from "./0002-gateway.ts";
import type { Migration } from "./migration.ts";

/**
 * Every schema step, in application order.
 *
 * @remarks
 * Adding a table is one new file plus one entry here. The runner checks that the versions are
 * 1..n with no gap or duplicate before it executes any SQL.
 */
export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002];
