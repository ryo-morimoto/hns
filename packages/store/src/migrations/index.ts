import { migration0001 } from "./0001-initial.ts";
import { migration0002 } from "./0002-gateway.ts";
import { migration0003 } from "./0003-cost.ts";
import { migration0004 } from "./0004-project-workspace.ts";
import { migration0005 } from "./0005-conversation-index.ts";
import { migration0006 } from "./0006-drop-legacy-events.ts";
import { migration0007 } from "./0007-policy.ts";
import { migration0008 } from "./0008-machines.ts";
import { migration0009 } from "./0009-conversation-edited.ts";
import type { Migration } from "./migration.ts";

/**
 * Every schema step, in application order.
 *
 * @remarks
 * Adding a table is one new file plus one entry here. The runner checks that the versions are
 * 1..n with no gap or duplicate before it executes any SQL.
 */
export const MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
];
