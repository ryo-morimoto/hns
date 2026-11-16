import type { D1Binding } from "@hns/store";
import { alertsBetween, minusTurn, type CostAlert } from "./alerts.ts";
import { limitFor, readCostLimits, type CostLimits } from "./limits.ts";
import {
  COST_METRICS,
  readMonthlyTotal,
  readProviderMonth,
  recordTurn,
  type CostMetric,
  type CostOutcome,
  type CostUsage,
  type ProviderMonth,
} from "./ledger.ts";
import { countStoredRows, type TurnStorage } from "./meter.ts";

/** Which monthly budget refused a new run. */
export type CostBudget = CostMetric | "provider";

/** A monthly budget is used up; the caller refuses the new run. */
export class CostLimitError extends Error {
  readonly budget: CostBudget;

  constructor(budget: CostBudget) {
    super("the monthly " + budget + " budget is used up");
    this.name = "CostLimitError";
    this.budget = budget;
  }
}

/** The monthly gauge could not be read; the caller fails closed. */
export class CostGaugeUnavailableError extends Error {
  constructor(cause: unknown) {
    super("the monthly cost gauge could not be read", { cause });
    this.name = "CostGaugeUnavailableError";
  }
}

/** The stages whose failure is logged and does not fail the turn. */
const COST_FAILURE_STAGES = ["measure", "record"] as const;
/** One stage the cost gate can fail in without failing the turn. */
export type CostFailureStage = (typeof COST_FAILURE_STAGES)[number];

/** What one turn did that the ledger records. */
export interface TurnActivity {
  /** The turn's id; the ledger key is (conversation, id), so a retried turn is one row. */
  readonly id: string;
  readonly conversationId: string;
  /** Durable Object requests the turn spent. Defaults to 0. */
  readonly requests?: number | undefined;
  /** R2 objects the turn put. Defaults to 0 until the object write path reports them. */
  readonly r2Objects?: number | undefined;
}

/** The seam the Session's message route uses. */
export interface CostGate {
  /**
   * Refuse a new run when a monthly budget is used up.
   *
   * @param at - The instant the run would start; only its UTC month is used.
   * @throws CostLimitError when a budget is at or above its limit.
   * @throws CostGaugeUnavailableError when the limits, the month total, or the provider row
   * cannot be read. The caller answers 503: an unreadable gauge is not permission to spend.
   */
  admit(at: Date): Promise<void>;
  /**
   * Run one turn and record what it cost.
   *
   * @param activity - The turn's id, conversation, and the counts the caller already knows.
   * @param run - The turn; its completion or failure is recorded with its row delta.
   * @returns Whatever `run` returned.
   * @throws Whatever `run` threw, after the record is attempted. Measurement and recording
   * failures are logged and never replace the turn's own result.
   *
   * @remarks
   * The rows are the difference of the object's SQLite row count across the turn, clamped at
   * zero. A failure to measure or record leaves the turn successful: the answer is not lost
   * to bookkeeping, and the provider's own hard limit stays the outer fence (docs/auth.md).
   */
  turn<T>(activity: TurnActivity, run: () => Promise<T>): Promise<T>;
}

/** The injection points; production leaves the optional ones out. */
export interface CostGateDependencies {
  /** The control database that holds the limits and the ledger (migration 3). */
  readonly db: D1Binding;
  /** The object's SQLite, read to measure the turn's row delta. */
  readonly storage: TurnStorage;
  /** The clock for the ledger's timestamps; defaults to `new Date()`. */
  readonly now?: (() => Date) | undefined;
  /** Receives each threshold crossing; defaults to one `console.warn` line of numbers. */
  readonly alert?: ((alert: CostAlert) => void) | undefined;
  /** Receives a measurement or recording failure; defaults to `console.error` with the name. */
  readonly failure?: ((stage: CostFailureStage, error: Error) => void) | undefined;
}

/**
 * Narrow a caught value for logging.
 *
 * @internal
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a caught value is unknown by definition.
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The budget that is used up, if any.
 *
 * @internal
 * @returns The first exhausted metric, then the provider month. The comparison is `>=`: at the
 * limit the budget is spent, which is also where the gateway stops reserving.
 */
function exhaustedBudget(
  usage: CostUsage,
  limits: CostLimits,
  provider: ProviderMonth,
): CostBudget | undefined {
  for (const metric of COST_METRICS) {
    if (usage[metric] >= limitFor(limits, metric)) return metric;
  }
  if (provider.spent >= provider.limit) return "provider";
  return undefined;
}

/**
 * Bind the cost gate to one Session's database and storage.
 *
 * @param dependencies - The control database, the object's SQLite, and the logging seams.
 * @returns The gate the message route admits and measures with.
 *
 * @remarks
 * The gate keeps no state: the month total is a SUM, and a threshold crossing is derived from
 * the total after the insert minus the turn's own cost, so a restart cannot forget or repeat
 * an alert. Every read is a single D1 statement against a primary key or the `at` index.
 */
export function createCostGate(dependencies: CostGateDependencies): CostGate {
  const { db, storage } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const alert =
    dependencies.alert ??
    ((crossing: CostAlert): void => {
      console.warn("cost: alert", crossing.metric, crossing.level, crossing.used, crossing.limit);
    });
  const failure =
    dependencies.failure ??
    ((stage: CostFailureStage, error: Error): void => {
      console.error("cost: " + stage + " failed", error.name);
    });

  /**
   * Append the turn and emit the alerts it caused.
   *
   * @internal
   * @remarks
   * A duplicate id returns before the alert calculation: a retried turn must not alert twice.
   */
  async function record(
    activity: TurnActivity,
    at: Date,
    before: number | undefined,
    outcome: CostOutcome,
  ): Promise<void> {
    let doRows = 0;
    if (before !== undefined) {
      try {
        doRows = Math.max(countStoredRows(storage) - before, 0);
      } catch (error) {
        failure("measure", asError(error));
      }
    }
    const usage: CostUsage = {
      doRows,
      doRequests: activity.requests ?? 0,
      r2Objects: activity.r2Objects ?? 0,
    };
    try {
      const inserted = await recordTurn(db, {
        id: activity.id,
        at,
        conversationId: activity.conversationId,
        outcome,
        doRows: usage.doRows,
        doRequests: usage.doRequests,
        r2Objects: usage.r2Objects,
      });
      if (!inserted) return;
      const limits = await readCostLimits(db);
      const after = await readMonthlyTotal(db, at);
      for (const crossing of alertsBetween(minusTurn(after, usage), after, limits)) {
        alert(crossing);
      }
    } catch (error) {
      failure("record", asError(error));
    }
  }

  return {
    async admit(at) {
      let limits: CostLimits;
      let usage: CostUsage;
      let provider: ProviderMonth;
      try {
        limits = await readCostLimits(db);
        usage = await readMonthlyTotal(db, at);
        provider = await readProviderMonth(db, at);
      } catch (error) {
        throw new CostGaugeUnavailableError(error);
      }
      const exhausted = exhaustedBudget(usage, limits, provider);
      if (exhausted !== undefined) throw new CostLimitError(exhausted);
    },
    async turn(activity, run) {
      const at = now();
      let before: number | undefined;
      try {
        before = countStoredRows(storage);
      } catch (error) {
        failure("measure", asError(error));
      }
      try {
        const value = await run();
        await record(activity, at, before, "completed");
        return value;
      } catch (error) {
        await record(activity, at, before, "failed");
        throw error;
      }
    },
  };
}
