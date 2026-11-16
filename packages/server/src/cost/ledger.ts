import type { D1Binding } from "@hns/store";
import * as v from "valibot";
import { monthKey } from "../gateway/budget.ts";

/** The three platform costs one turn adds up. */
export interface CostUsage {
  /** Rows the turn appended to the Session Durable Object's SQLite. */
  readonly doRows: number;
  /** Durable Object requests the turn spent. */
  readonly doRequests: number;
  /** R2 objects (Class A writes) the turn put. */
  readonly r2Objects: number;
}

/** The metrics a monthly limit applies to, in report order. */
export const COST_METRICS = ["doRows", "doRequests", "r2Objects"] as const;
/** One platform cost name. */
export type CostMetric = (typeof COST_METRICS)[number];

/** How a turn ended, for the record. The limit counts every outcome. */
const COST_OUTCOMES = ["completed", "failed"] as const;
/** One turn outcome. */
export type CostOutcome = (typeof COST_OUTCOMES)[number];

/** One turn to append to the ledger. */
export interface CostTurn {
  /**
   * The turn's request id.
   *
   * @remarks
   * The ledger key is (conversation, id), the scope pi-durable deduplicates a resend by, so
   * the same request id in two conversations is two turns and one conversation's resend is one.
   */
  readonly id: string;
  /** The conversation the turn belongs to; the other half of the ledger key. */
  readonly conversationId: string;
  /** When the turn started; only its UTC month is used for the limit. */
  readonly at: Date;
  readonly outcome: CostOutcome;
  readonly doRows: number;
  readonly doRequests: number;
  readonly r2Objects: number;
}

/** The provider gateway's month, read from its own row. */
export interface ProviderMonth {
  /** USD spent in the month; 0 when the row belongs to an earlier month. */
  readonly spent: number;
  /** The month's USD limit. */
  readonly limit: number;
}

const INSERT_SQL =
  "INSERT OR IGNORE INTO cost_turn (id, conversation_id, at, outcome, do_rows, do_requests, r2_objects) " +
  "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)";

const MONTH_SQL =
  "SELECT COALESCE(SUM(do_rows), 0) AS do_rows, COALESCE(SUM(do_requests), 0) AS do_requests, " +
  "COALESCE(SUM(r2_objects), 0) AS r2_objects FROM cost_turn WHERE at >= ?1 AND at < ?2";

const PROVIDER_SQL =
  "SELECT month_key, month_spent, month_limit FROM provider_gateway WHERE id = ?1";

const UsageRowSchema = v.object({
  do_rows: v.number(),
  do_requests: v.number(),
  r2_objects: v.number(),
});

const ProviderRowSchema = v.object({
  month_key: v.string(),
  month_spent: v.number(),
  month_limit: v.number(),
});

/** The inclusive start and exclusive end of a UTC month, as ISO timestamps. */
export interface MonthBounds {
  readonly start: string;
  readonly end: string;
}

/**
 * The UTC bounds of the month that contains `at`.
 *
 * @internal
 * @returns The bounds, so the SUM uses the `cost_turn_at` index instead of a substring match.
 */
export function monthBounds(at: Date): MonthBounds {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1)).toISOString(),
    end: new Date(Date.UTC(year, month + 1, 1)).toISOString(),
  };
}

/**
 * Refuse a count that could not have come from a database column.
 *
 * @internal
 * @throws RangeError when the value is not a non-negative integer.
 */
function requireCount(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(name + " must be a non-negative integer");
  }
  return value;
}

/**
 * Append one turn to the ledger.
 *
 * @param db - The control database that holds `cost_turn` (migration 3).
 * @param turn - The turn to record; the values are validated before the write.
 * @returns True when the row was new, false when the id was already recorded.
 *
 * @throws RangeError when a count is not a non-negative integer or the id is empty.
 * @throws Whatever D1 throws; the caller logs it and leaves the turn successful.
 *
 * @remarks
 * The insert ignores a duplicate (conversation, id), so a retried turn returns false and the
 * month total does not move. The key is the request id the caller resends with, scoped to its
 * conversation the way pi-durable scopes its own deduplication.
 */
export async function recordTurn(db: D1Binding, turn: CostTurn): Promise<boolean> {
  if (turn.id.length === 0) throw new RangeError("the turn id must not be empty");
  if (turn.conversationId.length === 0) {
    throw new RangeError("the turn's conversation id must not be empty");
  }
  requireCount("doRows", turn.doRows);
  requireCount("doRequests", turn.doRequests);
  requireCount("r2Objects", turn.r2Objects);
  const result = await db
    .prepare(INSERT_SQL)
    .bind(
      turn.id,
      turn.conversationId,
      turn.at.toISOString(),
      turn.outcome,
      turn.doRows,
      turn.doRequests,
      turn.r2Objects,
    )
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * The month's platform usage.
 *
 * @param db - The control database that holds `cost_turn`.
 * @param at - An instant inside the month to total.
 * @returns The summed DO rows, DO requests, and R2 objects; zeros for an empty month.
 *
 * @throws Whatever D1 throws; the caller fails closed.
 */
export async function readMonthlyTotal(db: D1Binding, at: Date): Promise<CostUsage> {
  const bounds = monthBounds(at);
  const row = await db.prepare(MONTH_SQL).bind(bounds.start, bounds.end).first();
  const parsed = v.parse(UsageRowSchema, row ?? { do_rows: 0, do_requests: 0, r2_objects: 0 });
  return {
    doRows: parsed.do_rows,
    doRequests: parsed.do_requests,
    r2Objects: parsed.r2_objects,
  };
}

/**
 * The provider gateway's spend and limit for the month that contains `at`.
 *
 * @param db - The control database that holds `provider_gateway` (migration 2).
 * @param at - An instant inside the month to judge.
 * @returns The month's spend and limit. A row whose `month_key` is an earlier month reports
 * zero spend, which is the gateway's own reset rule.
 *
 * @throws Error when the row is missing or corrupt; the caller fails closed.
 *
 * @remarks
 * This is the same row the gateway spends against (0151); reading it here is reuse, not a
 * second copy of the money state. The gateway's 429 is per call; this check is per run.
 */
export async function readProviderMonth(db: D1Binding, at: Date): Promise<ProviderMonth> {
  const row = await db.prepare(PROVIDER_SQL).bind("gateway").first();
  if (row === null || row === undefined) {
    throw new Error("the provider gateway budget row is missing");
  }
  const parsed = v.parse(ProviderRowSchema, row);
  return {
    spent: parsed.month_key === monthKey(at) ? parsed.month_spent : 0,
    limit: parsed.month_limit,
  };
}
