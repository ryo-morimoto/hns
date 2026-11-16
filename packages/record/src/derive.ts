import type { DoneLevel, WorkRecord } from "./types.ts";

/**
 * Derive the done level from the record's own facts.
 *
 * @remarks
 * The order is fixed: learning, outcome, integration, verified, intended, generated.
 * Unresolved criteria cap the level at intended, even when integration or outcome exists.
 * @param record - A validated record.
 * @returns The highest level its evidence supports.
 */
export const deriveDoneLevel = (record: WorkRecord): DoneLevel => {
  if (record.intent.trim() === "") return "generated";
  const resolved =
    record.criteria.length > 0 &&
    record.criteria.every(
      (criterion) => criterion.status === "passed" || criterion.status === "waived",
    );
  if (!resolved) return "intended";
  if (record.learning !== undefined) return "learned";
  if (record.outcome !== undefined) return "observed";
  if (record.integration !== undefined) return "integrated";
  return "verified";
};
