import { limitFor, type CostLimits } from "./limits.ts";
import { COST_METRICS, type CostMetric, type CostUsage } from "./ledger.ts";

/** The alert levels, in severity order. */
const COST_ALERT_LEVELS = ["warn", "critical", "exceeded"] as const;
/** One alert level: a ratio crossed (`warn`, `critical`), or the limit used up. */
export type CostAlertLevel = (typeof COST_ALERT_LEVELS)[number];

/** One threshold crossing, emitted as a structured log line. */
export interface CostAlert {
  readonly metric: CostMetric;
  readonly level: CostAlertLevel;
  readonly used: number;
  readonly limit: number;
}

/** The severity order of {@link COST_ALERT_LEVELS}, so a crossing compares one number. */
const rankOf = (level: CostAlertLevel | undefined): number =>
  level === undefined ? -1 : COST_ALERT_LEVELS.indexOf(level);

/**
 * The alert level a used amount is in.
 *
 * @internal
 * @param used - The month's usage for the metric.
 * @param limit - The metric's monthly limit; positive.
 * @param limits - The configured ratios.
 * @returns The level, or undefined below the warning ratio.
 *
 * @remarks
 * `exceeded` starts at the limit itself because that is where new runs stop; there is no
 * meaningful "just over" band to alert on separately.
 */
export function levelFor(
  used: number,
  limit: number,
  limits: CostLimits,
): CostAlertLevel | undefined {
  if (used >= limit) return "exceeded";
  if (used >= limit * limits.criticalRatio) return "critical";
  if (used >= limit * limits.warnRatio) return "warn";
  return undefined;
}

/**
 * The alerts one turn added usage should emit.
 *
 * @param before - The month's usage without this turn.
 * @param after - The month's usage with this turn.
 * @param limits - The configured limits and ratios.
 * @returns One alert per metric whose level rose, in {@link COST_METRICS} order.
 *
 * @remarks
 * Crossing detection needs no stored state: the caller derives `before` as
 * `after - turn`, so a restart cannot forget or repeat a crossing. Only the highest level
 * reached is reported; a jump from below the warning ratio straight past the limit reports
 * `exceeded`, not three alerts.
 */
export function alertsBetween(
  before: CostUsage,
  after: CostUsage,
  limits: CostLimits,
): readonly CostAlert[] {
  const alerts: CostAlert[] = [];
  for (const metric of COST_METRICS) {
    const limit = limitFor(limits, metric);
    const was = levelFor(before[metric], limit, limits);
    const now = levelFor(after[metric], limit, limits);
    if (now !== undefined && rankOf(now) > rankOf(was)) {
      alerts.push({ metric, level: now, used: after[metric], limit });
    }
  }
  return alerts;
}

/**
 * The usage a turn added, subtracted back out of a total.
 *
 * @internal
 * @throws RangeError when `turn` is larger than `total`; that cannot happen for a total read
 * after the insert, and a silent zero would hide the mismatch.
 */
export function minusTurn(total: CostUsage, turn: CostUsage): CostUsage {
  const subtract = (metric: CostMetric): number => {
    const value = total[metric] - turn[metric];
    if (value < 0) throw new RangeError("the month total is smaller than the turn for " + metric);
    return value;
  };
  return {
    doRows: subtract("doRows"),
    doRequests: subtract("doRequests"),
    r2Objects: subtract("r2Objects"),
  };
}
