/* oxlint-disable anti-slop/no-unknown-parameters --
   This is the D1 boundary: the limit row is unknown until it is parsed. */
import type { D1Binding } from "@hns/store";
import * as v from "valibot";
import type { CostMetric } from "./ledger.ts";

/**
 * The monthly operational limits and the alert thresholds, held in one D1 row.
 *
 * @remarks
 * These are policy, not schema: an operator changes them with an `UPDATE`, like the provider
 * gateway's budget row. The ratios are the fraction of a limit at which an alert fires; they
 * live here rather than in code so a deployment can change the warning points without a build.
 */
export interface CostLimits {
  /** DO rows written in the month. */
  readonly doRows: number;
  /** DO requests in the month. */
  readonly doRequests: number;
  /** R2 objects (Class A writes) in the month. */
  readonly r2Objects: number;
  /** Ratio of a limit at which the first alert fires; 0 < warnRatio < criticalRatio. */
  readonly warnRatio: number;
  /** Ratio of a limit at which the urgent alert fires; warnRatio < criticalRatio <= 1. */
  readonly criticalRatio: number;
}

/** The table has exactly one row; this is its id. */
const ROW_ID = "cost";

const LIMIT_SQL =
  "SELECT do_rows_limit, do_requests_limit, r2_objects_limit, warn_ratio, critical_ratio " +
  "FROM cost_limits WHERE id = ?1";

const LimitRowSchema = v.object({
  do_rows_limit: v.pipe(v.number(), v.integer(), v.minValue(1)),
  do_requests_limit: v.pipe(v.number(), v.integer(), v.minValue(1)),
  r2_objects_limit: v.pipe(v.number(), v.integer(), v.minValue(1)),
  warn_ratio: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  critical_ratio: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
});

/**
 * Parse the limit row into the public shape.
 *
 * @internal
 * @throws ValiError when a column is missing or outside its range.
 * @throws Error when the alert ratios are not ordered, which the table's CHECK also refuses.
 */
function parseLimits(row: unknown): CostLimits {
  const parsed = v.parse(LimitRowSchema, row);
  if (!(parsed.warn_ratio > 0 && parsed.warn_ratio < parsed.critical_ratio)) {
    throw new Error("the cost alert ratios must satisfy 0 < warn < critical");
  }
  return {
    doRows: parsed.do_rows_limit,
    doRequests: parsed.do_requests_limit,
    r2Objects: parsed.r2_objects_limit,
    warnRatio: parsed.warn_ratio,
    criticalRatio: parsed.critical_ratio,
  };
}

/**
 * Read the monthly limits and alert ratios.
 *
 * @param db - The control database that holds the single limit row (migration 3).
 * @returns The configured limits.
 *
 * @throws Error when the row is missing, corrupt, or D1 fails. The caller fails closed: an
 * unreadable limit is not permission to run without one.
 */
export async function readCostLimits(db: D1Binding): Promise<CostLimits> {
  const row = await db.prepare(LIMIT_SQL).bind(ROW_ID).first();
  if (row === null || row === undefined) {
    throw new Error("the monthly cost limit row is missing");
  }
  return parseLimits(row);
}

/**
 * The monthly limit that applies to one metric.
 *
 * @internal
 */
export function limitFor(limits: CostLimits, metric: CostMetric): number {
  switch (metric) {
    case "doRows":
      return limits.doRows;
    case "doRequests":
      return limits.doRequests;
    case "r2Objects":
      return limits.r2Objects;
    default: {
      const unhandled: never = metric;
      throw new Error("unknown cost metric: " + String(unhandled));
    }
  }
}
