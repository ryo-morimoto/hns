import type { D1Binding } from "@hns/store";
import * as v from "valibot";

/** The table has exactly one row; this is its id. */
const ROW_ID = "gateway";

/** What a reservation attempt found. */
export type BudgetReservation = "reserved" | "exceeded" | "stopped";

/**
 * The gateway's daily and monthly budget, held in one D1 row.
 *
 * @remarks
 * The spend is a single `UPDATE ... WHERE spent + price <= limit` so two isolates cannot
 * both pass the limit: D1 applies one writer at a time and the losers see `changes = 0`.
 * No Durable Object is involved (D049). The columns are REAL, so the comparison carries
 * float slack far smaller than one call's price; the provider's own hard limit is the outer
 * fence (docs/auth.md).
 */
export interface Budget {
  /**
   * Take one call's price out of the budget and relabel the period keys.
   *
   * @param amount - The call's price in USD; must be positive.
   * @param at - The instant the call starts; only its UTC day and month are used.
   * @returns `reserved` when the write applied, otherwise why it did not.
   *
   * @throws Error when the budget row is missing, corrupt, or D1 fails. The caller must
   * fail closed: an unreadable budget is not permission to spend.
   */
  reserve(amount: number, at: Date): Promise<BudgetReservation>;
  /**
   * Give back a reservation whose call did not succeed.
   *
   * @param amount - The same price that was reserved.
   * @param at - The instant of the **reservation**, not of the refund.
   *
   * @remarks
   * A refund only subtracts inside the period the reservation belongs to. If the day rolled
   * over in between, that day's spend is already history and is left alone.
   * @throws Error when D1 fails; the caller cannot claim a clean failure without it.
   */
  refund(amount: number, at: Date): Promise<void>;
}

// Numbered parameters so each value is bound once and the CASE arms cannot drift apart.
const RESERVE_SQL = `UPDATE provider_gateway
SET day_spent = CASE WHEN day_key = ?1 THEN day_spent + ?2 ELSE ?2 END,
    month_spent = CASE WHEN month_key = ?3 THEN month_spent + ?2 ELSE ?2 END,
    day_key = ?1,
    month_key = ?3,
    updated_at = ?4
WHERE id = ?5
  AND stopped = 0
  AND (CASE WHEN day_key = ?1 THEN day_spent + ?2 ELSE ?2 END) <= day_limit
  AND (CASE WHEN month_key = ?3 THEN month_spent + ?2 ELSE ?2 END) <= month_limit`;

const REFUND_SQL = `UPDATE provider_gateway
SET day_spent = CASE WHEN day_key = ?1 THEN MAX(day_spent - ?2, 0) ELSE day_spent END,
    month_spent = CASE WHEN month_key = ?3 THEN MAX(month_spent - ?2, 0) ELSE month_spent END,
    updated_at = ?4
WHERE id = ?5`;

const STOPPED_SQL = "SELECT stopped FROM provider_gateway WHERE id = ?1";

const StoppedSchema = v.object({ stopped: v.picklist([0, 1]) });

/** The UTC day key a reservation belongs to, such as `2026-11-17`. */
export const dayKey = (at: Date): string => at.toISOString().slice(0, 10);

/** The UTC month key a reservation belongs to, such as `2026-11`. */
export const monthKey = (at: Date): string => at.toISOString().slice(0, 7);

/**
 * Why a refused reservation was refused.
 *
 * @internal
 * @throws Error when the row is missing or its stop flag is not 0 or 1.
 */
async function refusalReason(db: D1Binding): Promise<BudgetReservation> {
  const row = await db.prepare(STOPPED_SQL).bind(ROW_ID).first();
  if (row === null || row === undefined) {
    throw new Error("the provider gateway budget row is missing");
  }
  return v.parse(StoppedSchema, row).stopped === 1 ? "stopped" : "exceeded";
}

/**
 * Bind a budget to a D1 database.
 *
 * @param db - The control database that holds the single budget row (migration 2).
 * @returns The budget the gateway spends against.
 */
export function createBudget(db: D1Binding): Budget {
  return {
    async reserve(amount, at) {
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new RangeError("amount must be a positive number");
      }
      const day = dayKey(at);
      const month = monthKey(at);
      const result = await db
        .prepare(RESERVE_SQL)
        .bind(day, amount, month, at.toISOString(), ROW_ID)
        .run();
      const changes = result.meta?.changes ?? 0;
      if (changes === 1) return "reserved";
      if (changes > 1) throw new Error("the provider gateway budget update hit several rows");
      return await refusalReason(db);
    },
    async refund(amount, at) {
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new RangeError("amount must be a positive number");
      }
      await db
        .prepare(REFUND_SQL)
        .bind(dayKey(at), amount, monthKey(at), new Date().toISOString(), ROW_ID)
        .run();
    },
  };
}
