import type { MachineRefusalCode } from "@hns/core";

/**
 * The refusal codes a Journal row can carry as its reason.
 *
 * @remarks
 * A `denied` outcome and an audit entry record why the machine refused a write. That reason is
 * the machine agent's code, and the list is the core model's one vocabulary
 * ({@link MachineRefusalCode}). This package cannot depend on `@hns/machine` (server → store →
 * core), so the list is written here and `satisfies` makes it a compile error to hold anything
 * the core list does not: a code added on one side without the other fails to build.
 */
export const JOURNAL_REFUSAL_CODES = [
  "unauthorized",
  "stale_request",
  "replayed",
  "stale_connection",
  "invalid_request",
  "path_denied",
  "forbidden",
  "not_found",
  "busy",
  "too_large",
  "deadline_exceeded",
  "method_not_allowed",
  "internal",
] as const satisfies readonly MachineRefusalCode[];

/** One refusal code a Journal row can record. */
export type JournalRefusalCode = (typeof JOURNAL_REFUSAL_CODES)[number];
